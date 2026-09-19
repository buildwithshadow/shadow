import { readFileSync } from "node:fs";
import { BlockNotFoundError, decodeEventLog, getAddress } from "viem";
import { floatAbi } from "./float-mainnet-config.mjs";
import {
  UsageError,
  connect,
  eventRecord,
  findLogs,
  fromBlockFlag,
  parseAddress,
  parseBytes32,
  parseUint,
  required,
  runCli,
} from "./float-mainnet-cli.mjs";
import { writeJsonFile } from "./float-mainnet-intent.mjs";
import { errorMessage, isEntrypoint, stableStringify } from "./float-mainnet-preflight.mjs";

// Event index for the ShadowFloatMainnet candidate: every Float event from a
// start block (the manifest's deployment block) to a pinned head, decoded and
// enriched with its block hash, timestamp and transaction sender. The index is
// held in its file shape (integers as decimal strings) in memory as well, so
// the evidence exporter consumes a scan and an index file the same way.

export const INDEX_KIND = "ShadowFloatMainnet.EventIndex";
export const INDEX_SCHEMA = 1;
// A block number in its stored form: a decimal string without leading zeros.
const BLOCK_NUMBER = /^(0|[1-9]\d*)$/;
const EVENT_INPUTS = new Map(floatAbi.filter((item) => item.type === "event").map((item) => [item.name, item.inputs]));

const plain = (value) => JSON.parse(stableStringify(value));
const position = (event) => [BigInt(event.blockNumber), BigInt(event.logIndex)];
// (blockNumber, logIndex) order, for sort().
export const byPosition = (a, b) => {
  const [[blockA, logA], [blockB, logB]] = [position(a), position(b)];
  return blockA === blockB ? (logA < logB ? -1 : logA > logB ? 1 : 0) : blockA < blockB ? -1 : 1;
};

async function blockAt(connection, blockNumber) {
  try {
    return await connection.client.getBlock({ blockNumber });
  } catch (error) {
    if (error instanceof BlockNotFoundError) return null;
    throw error;
  }
}

// Whether the checkpoint block is still on the canonical chain. A reorg at or
// below it changes its hash; a chain now shorter than it has no block there.
export async function checkpointStatus(connection, checkpoint) {
  const block = await blockAt(connection, BigInt(checkpoint.blockNumber));
  return { canonical: block?.hash === checkpoint.blockHash, canonicalHash: block?.hash ?? null };
}

// Every Float log in [fromBlock, toBlock] (findLogs without an event returns
// them all), decoded; an undecodable log fails the scan.
async function scan(connection, fromBlock, toBlock) {
  const logs = await findLogs(connection, undefined, undefined, fromBlock, toBlock);
  const blocks = new Map();
  const senders = new Map();
  const events = [];
  for (const log of logs) {
    const { eventName, args } = decodeEventLog({ abi: floatAbi, data: log.data, topics: log.topics });
    if (!blocks.has(log.blockNumber)) blocks.set(log.blockNumber, await connection.client.getBlock({ blockNumber: log.blockNumber }));
    const block = blocks.get(log.blockNumber);
    if (block.hash !== log.blockHash) {
      throw new Error(
        `block ${log.blockNumber} is now ${block.hash}, but its ${eventName} log came from ${log.blockHash}: the chain reorganized during the scan; run again`,
      );
    }
    if (!senders.has(log.transactionHash)) {
      senders.set(log.transactionHash, getAddress((await connection.client.getTransaction({ hash: log.transactionHash })).from));
    }
    events.push({
      ...eventRecord({ ...log, eventName, args }),
      blockHash: log.blockHash,
      transactionIndex: log.transactionIndex,
      from: senders.get(log.transactionHash),
      timestamp: block.timestamp,
    });
  }
  return events;
}

// Indexes [fromBlock, head], or, given a previous index whose checkpoint is
// still canonical, only (checkpoint, head] appended to it. A previous index
// whose checkpoint was reorganized away is rebuilt from its own fromBlock.
export async function indexEvents(connection, { fromBlock, previous = null }) {
  const head = await connection.client.getBlock();
  let start = previous ? BigInt(previous.fromBlock) : fromBlock;
  let kept = [];
  let mode = "full";
  let reorg = null;
  if (previous) {
    const status = await checkpointStatus(connection, previous.checkpoint);
    if (status.canonical) {
      if (head.number < BigInt(previous.checkpoint.blockNumber)) {
        throw new Error(`the RPC head ${head.number} is behind the index checkpoint ${previous.checkpoint.blockNumber}; retry once it has caught up`);
      }
      [mode, kept, start] = ["resumed", previous.events, BigInt(previous.checkpoint.blockNumber) + 1n];
    } else {
      mode = "rebuilt";
      reorg = {
        checkpoint: previous.checkpoint,
        canonicalHash: status.canonicalHash,
        detail:
          status.canonicalHash === null
            ? `block ${previous.checkpoint.blockNumber} no longer exists (head ${head.number}); rebuilt from block ${previous.fromBlock}`
            : `block ${previous.checkpoint.blockNumber} is now ${status.canonicalHash}, not the checkpoint ${previous.checkpoint.blockHash}; rebuilt from block ${previous.fromBlock}`,
      };
    }
  } else if (fromBlock > head.number) {
    throw new UsageError(`the start block ${fromBlock} is after the head ${head.number}`);
  }

  const scanned = start <= head.number ? await scan(connection, start, head.number) : [];
  const pinned = await blockAt(connection, head.number);
  if (pinned?.hash !== head.hash) {
    throw new Error(`the pinned head ${head.number} (${head.hash}) was reorganized away during the scan; run again`);
  }
  const index = plain({
    kind: INDEX_KIND,
    schema: INDEX_SCHEMA,
    chainId: connection.chainId,
    address: connection.address,
    fromBlock: previous ? previous.fromBlock : fromBlock,
    checkpoint: { blockNumber: head.number, blockHash: head.hash },
    events: [...kept, ...scanned],
  });
  index.events.sort(byPosition);
  return {
    index,
    mode,
    reorg,
    scanned: start <= head.number ? plain({ fromBlock: start, toBlock: head.number }) : null,
    newEvents: scanned.length,
  };
}

// One event as the indexer writes it: a Float event whose ABI arguments are in
// their stored form (addresses checksummed, bytes32 lowercase, integers as
// decimal strings, or numbers for small ones), with its position, block hash,
// timestamp (a decimal string), transaction index (a number) and sender.
function checkEvent(entry, label) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || !EVENT_INPUTS.has(entry.event)) throw new Error(`${label} is not a Float event`);
  if (!/^\d+$/.test(entry.blockNumber ?? "") || !Number.isSafeInteger(entry.logIndex) || entry.logIndex < 0) {
    throw new Error(`${label} has no valid blockNumber and logIndex`);
  }
  const stored = (name, value, parse) => {
    if (parse(`${label}.${name}`, value, Error) !== value) throw new Error(`${label}.${name} ${value} is not in its stored form`);
  };
  stored("transactionHash", entry.transactionHash, parseBytes32);
  stored("blockHash", entry.blockHash, parseBytes32);
  if (typeof entry.timestamp !== "string" || !BLOCK_NUMBER.test(entry.timestamp)) {
    throw new Error(`${label}.timestamp must be a decimal string without leading zeros`);
  }
  if (!Number.isSafeInteger(entry.transactionIndex) || entry.transactionIndex < 0) throw new Error(`${label} has no valid transactionIndex`);
  stored("from", entry.from, parseAddress);
  if (!entry.args || typeof entry.args !== "object" || Array.isArray(entry.args)) throw new Error(`${label}.args is not an object`);
  for (const { name, type } of EVENT_INPUTS.get(entry.event)) {
    const value = entry.args[name];
    if (type === "address") stored(`args.${name}`, value, parseAddress);
    else if (type === "bytes32") stored(`args.${name}`, value, parseBytes32);
    else if (type === "bool" && typeof value !== "boolean") throw new Error(`${label}.args.${name} must be a boolean`);
    else if (type !== "bool") parseUint(`${label}.args.${name}`, Number.isSafeInteger(value) ? String(value) : value, Number(type.slice(4)), Error);
  }
}

// The shape and deployment of an index read back from a file, and the shape of
// each event: each at its own (blockNumber, logIndex), within [fromBlock, checkpoint].
export function validateIndex(index, { chainId, address }) {
  if (!index || typeof index !== "object" || Array.isArray(index)) throw new Error("the index is not a JSON object");
  if (index.kind !== INDEX_KIND || index.schema !== INDEX_SCHEMA) {
    throw new Error(`not a ${INDEX_KIND} schema ${INDEX_SCHEMA} file (kind ${JSON.stringify(index.kind ?? null)}, schema ${JSON.stringify(index.schema ?? null)})`);
  }
  if (index.chainId !== chainId.toString() || index.address !== address) {
    throw new Error(`the index is for ${index.address} on chain ${index.chainId}, not ${address} on chain ${chainId}`);
  }
  const { checkpoint } = index;
  if (
    !BLOCK_NUMBER.test(index.fromBlock ?? "") ||
    !BLOCK_NUMBER.test(checkpoint?.blockNumber ?? "") ||
    !/^0x[0-9a-f]{64}$/.test(checkpoint?.blockHash ?? "") ||
    !Array.isArray(index.events)
  ) {
    throw new Error("the index has no valid fromBlock, checkpoint or events");
  }
  const [first, last] = [BigInt(index.fromBlock), BigInt(checkpoint.blockNumber)];
  const positions = new Map();
  index.events.forEach((entry, i) => {
    const label = `events[${i}]`;
    checkEvent(entry, label);
    const [blockNumber, logIndex] = position(entry);
    if (blockNumber < first || blockNumber > last) throw new Error(`${label} is in block ${blockNumber}, outside the index's blocks ${first}-${last}`);
    const at = `${blockNumber}:${logIndex}`;
    if (positions.has(at)) throw new Error(`${label} is at block ${blockNumber} log index ${logIndex}, the position of ${positions.get(at)}`);
    // After the position checks, so a leading-zero copy of another event's position is reported as that position.
    if (!BLOCK_NUMBER.test(entry.blockNumber)) throw new Error(`${label}.blockNumber ${entry.blockNumber} is not in its stored form`);
    positions.set(at, label);
  });
  return index;
}

export function readIndexFile(path, connection) {
  let index;
  try {
    index = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read index file ${path}: ${errorMessage(error)}`);
  }
  try {
    return validateIndex(index, connection);
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

async function index(values) {
  const out = required(values, "out");
  const fromBlockArg = fromBlockFlag(values);
  if (values.resume && fromBlockArg !== null) {
    throw new UsageError("--from-block starts a new index; --resume keeps the existing index's fromBlock");
  }
  if (!values.resume && fromBlockArg === null && values.manifest === undefined) {
    throw new UsageError("pass --manifest <release manifest> (the index starts at its deployment block) or --from-block <n>");
  }
  const connection = await connect(values);
  const previous = values.resume ? readIndexFile(out, connection) : null;
  const result = await indexEvents(connection, { fromBlock: fromBlockArg ?? connection.deployBlock, previous });
  writeJsonFile(out, result.index);
  return {
    ok: true,
    out,
    mode: result.mode,
    reorg: result.reorg,
    fromBlock: result.index.fromBlock,
    scanned: result.scanned,
    checkpoint: result.index.checkpoint,
    events: result.index.events.length,
    newEvents: result.newEvents,
  };
}

const COMMANDS = {
  index: { options: { out: { type: "string" }, resume: { type: "boolean" }, "from-block": { type: "string" } }, run: index },
};
const TOOL = "node app/scripts/float-mainnet-indexer.mjs";
const USAGE = [
  `${TOOL} index --out <index.json> [--resume] [--from-block <n>] [--manifest <path>]`,
  "Writes every Float event from the manifest's deployment block (or --from-block) to the latest block, with block hash, timestamp and transaction sender, sorted by block and log index; checkpoint is the pinned head.",
  "--resume extends the index at --out from its checkpoint when that block is still canonical; after a reorg it reports the reorg and rebuilds from the index's fromBlock.",
];

if (isEntrypoint(import.meta)) runCli(COMMANDS, USAGE);
