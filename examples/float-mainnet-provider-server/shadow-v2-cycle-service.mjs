import { createRequire } from "node:module";

const { createPublicClient, decodeEventLog, formatUnits, formatTransactionReceipt, getAddress, http, numberToHex, parseAbiItem } =
  createRequire(new URL("../../app/package.json", import.meta.url))("viem");

const HASH = /^0x[0-9a-fA-F]{64}$/;
const CHAIN_ID = 5042002;
const FLOAT = getAddress("0x20dcA96B0C487D94De885c726c956ffaF38b12C2");
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const floatReceipt = parseAbiItem("event FloatReceipt(uint256 indexed receiptId, bytes32 indexed receiptHash, uint8 indexed receiptType, address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, uint256 creditBeforeUSDC, uint256 creditAfterUSDC, uint256 debtBeforeUSDC, uint256 debtAfterUSDC, uint8 reason, bytes32 mandateId, bytes32 requestHash, bytes32 prevChecksum, bytes32 checksum)");
const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

function matchingEvents(receipt, address, event) {
  return receipt.logs.flatMap((log) => {
    if (getAddress(log.address) !== address) return [];
    try { return [decodeEventLog({ abi: [event], data: log.data, topics: log.topics }).args]; }
    catch { return []; }
  });
}

function only(events, type) {
  const found = events.filter((event) => event.receiptType === type);
  if (found.length !== 1) throw new Error(`expected exactly one V2 receipt of type ${type}`);
  return found[0];
}

function checkedCycle(payment, repayment, paymentTx, repaymentTx) {
  if (payment.status !== "success" || repayment.status !== "success") throw new Error("a V2 transaction reverted");
  if (payment.transactionHash?.toLowerCase() !== paymentTx || repayment.transactionHash?.toLowerCase() !== repaymentTx) {
    throw new Error("RPC receipt transaction hash does not match the requested transaction");
  }
  if (payment.blockNumber >= repayment.blockNumber) throw new Error("repayment did not follow payment");
  const paidEvents = matchingEvents(payment, FLOAT, floatReceipt);
  const repaidEvents = matchingEvents(repayment, FLOAT, floatReceipt);
  const paid = only(paidEvents, 4);
  const opened = only(paidEvents, 5);
  const repaid = only(repaidEvents, 6);
  const samePaymentState = ["agent", "provider", "amountUSDC", "requestHash", "creditBeforeUSDC", "creditAfterUSDC", "debtBeforeUSDC", "debtAfterUSDC"]
    .every((key) => paid[key] === opened[key]);
  if (!samePaymentState || paid.agent !== repaid.agent || paid.amountUSDC !== repaid.amountUSDC ||
      paid.amountUSDC <= 0n || paid.debtBeforeUSDC !== 0n ||
      paid.debtAfterUSDC !== paid.amountUSDC || paid.creditBeforeUSDC - paid.creditAfterUSDC !== paid.amountUSDC ||
      repaid.debtBeforeUSDC !== paid.debtAfterUSDC || repaid.debtAfterUSDC !== 0n ||
      repaid.creditBeforeUSDC !== paid.creditAfterUSDC || repaid.creditAfterUSDC !== paid.creditBeforeUSDC ||
      repaid.provider !== getAddress("0x0000000000000000000000000000000000000000")) {
    throw new Error("V2 payment and repayment state do not reconcile");
  }
  const hasTransfer = (receipt, from, to) => matchingEvents(receipt, USDC, transfer)
    .filter((event) => event.from === from && event.to === to && event.value === paid.amountUSDC).length === 1;
  if (!hasTransfer(payment, FLOAT, paid.provider) || !hasTransfer(repayment, paid.agent, FLOAT)) {
    throw new Error("V2 USDC transfers do not match receipts");
  }
  return {
    kind: "shadow-v2-cycle-reconciliation",
    scope: "Historical Shadow-operated Arc testnet V2 cycle; read-only founder engineering report, not a new candidate payment or independent customer",
    chainId: CHAIN_ID, float: FLOAT, usdc: USDC, requestId: paymentTx,
    agent: paid.agent, provider: paid.provider, amountUSDC: formatUnits(paid.amountUSDC, 6),
    payment: {
      tx: paymentTx, blockNumber: payment.blockNumber.toString(), blockHash: payment.blockHash,
      requestHash: paid.requestHash, providerPaidReceiptHash: paid.receiptHash,
      debtOpenedReceiptHash: opened.receiptHash, debtBeforeUSDC: formatUnits(paid.debtBeforeUSDC, 6),
      debtAfterUSDC: formatUnits(paid.debtAfterUSDC, 6),
    },
    repayment: {
      tx: repaymentTx, blockNumber: repayment.blockNumber.toString(), blockHash: repayment.blockHash,
      requestHash: repaid.requestHash, receiptHash: repaid.receiptHash,
      debtBeforeUSDC: formatUnits(repaid.debtBeforeUSDC, 6), debtAfterUSDC: formatUnits(repaid.debtAfterUSDC, 6),
    },
    checks: { twoRpcReceiptsMatch: true, providerTransferMatches: true, repaymentTransferMatches: true, debtRestored: true,
      noInterveningAgentDebtOrCreditChange: true },
    limits: `Payment and repayment request hashes ${paid.requestHash === repaid.requestHash ? "match" : "differ"}. This pair is linked by agent, amount and an uninterrupted debt/credit transition in the inspected interval; it cannot prove the global absence of duplicate charges.`,
  };
}

function comparable(receipt) {
  return JSON.stringify({ transactionHash: receipt.transactionHash?.toLowerCase(), status: receipt.status,
    blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
    logs: receipt.logs.map(({ address, data, topics }) => ({ address: address.toLowerCase(), data, topics })) });
}

export async function verifyCanonicalBlocks(clients, receipts) {
  await Promise.all(clients.map(async (client) => {
    const head = await client.getBlockNumber();
    for (const receipt of receipts) {
      if (head < receipt.blockNumber + 20n) throw new Error("V2 report receipt has fewer than 20 confirmations");
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) throw new Error("V2 report receipt block is no longer canonical");
    }
  }));
}

function normalizedFloatLogs(logs) {
  return logs.map((log) => ({
    transactionHash: log.transactionHash?.toLowerCase(), blockNumber: log.blockNumber?.toString(),
    logIndex: log.logIndex, receiptHash: log.args?.receiptHash?.toLowerCase(),
    receiptType: log.args?.receiptType, agent: log.args?.agent?.toLowerCase(),
    creditBefore: log.args?.creditBeforeUSDC?.toString(), creditAfter: log.args?.creditAfterUSDC?.toString(),
    debtBefore: log.args?.debtBeforeUSDC?.toString(), debtAfter: log.args?.debtAfterUSDC?.toString(),
    removed: log.removed === true,
  })).sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || a.logIndex - b.logIndex);
}

export function assertNoInterveningDebtChange(logs, report) {
  if (logs.some((log) => log.removed || log.logIndex === null || log.logIndex === undefined)) {
    throw new Error("V2 interval logs are incomplete or removed");
  }
  const positions = (tx, receiptHash, type) => logs.flatMap((log, index) =>
    log.transactionHash === tx && log.receiptHash === receiptHash && log.receiptType === type ? [index] : []);
  const starts = positions(report.payment.tx, report.payment.debtOpenedReceiptHash.toLowerCase(), 5);
  const ends = positions(report.repayment.tx, report.repayment.receiptHash.toLowerCase(), 6);
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new Error("V2 debt interval boundaries are missing or out of order");
  }
  const agent = report.agent.toLowerCase();
  if (logs.slice(starts[0] + 1, ends[0]).some((log) => log.agent === agent &&
      (log.debtBefore !== log.debtAfter || log.creditBefore !== log.creditAfter))) {
    throw new Error("another V2 debt or credit change intervened between payment and repayment");
  }
}

async function verifyDebtInterval(clients, payment, repayment, report) {
  if (repayment.blockNumber - payment.blockNumber > 5_000n) throw new Error("V2 debt interval exceeds the bounded scan range");
  const results = await Promise.all(clients.map((client) => client.getLogs({
    address: FLOAT, event: floatReceipt, fromBlock: payment.blockNumber, toBlock: repayment.blockNumber,
  })));
  const logs = results.map(normalizedFloatLogs);
  if (JSON.stringify(logs[0]) !== JSON.stringify(logs[1])) throw new Error("independent RPC V2 interval logs disagree");
  assertNoInterveningDebtChange(logs[0], report);
}

// Job identity is separate from the historical report being purchased.
// A new purchase uses a random job ID; every retry retains that SAME ID.
export function reportPaymentFromRequest(requestId) {
  if (typeof requestId !== "string") return null;
  if (HASH.test(requestId)) return requestId.toLowerCase(); // existing rehearsal clients
  const match = /^report:[0-9a-f]{32}:(0x[0-9a-f]{64})$/.exec(requestId);
  return match?.[1] ?? null;
}

// Some RPCs prune the transaction-hash index while retaining block receipts.
// The other provider supplies only a block hint: the missing provider must still
// return its own exact receipt. Never substitute one provider's evidence for two.
export async function readHistoricalReceiptPair(clients, hash) {
  const attempts = await Promise.allSettled(clients.map(client => client.getTransactionReceipt({ hash })));
  for (const attempt of attempts) {
    if (attempt.status === "rejected" && attempt.reason?.name !== "TransactionReceiptNotFoundError") throw attempt.reason;
  }
  const receipts = attempts.map(attempt => attempt.status === "fulfilled" ? attempt.value : null);
  const hint = receipts.find(receipt => receipt?.transactionHash?.toLowerCase() === hash &&
    typeof receipt.blockNumber === "bigint" && receipt.blockNumber >= 0n && HASH.test(receipt.blockHash || ""));
  if (receipts.some(receipt => !receipt) && !hint) throw new Error("historical receipt unavailable from both RPC indexes");
  for (let i = 0; i < receipts.length; i++) {
    if (receipts[i]) continue;
    const raw = await clients[i].request({ method: "eth_getBlockReceipts", params: [numberToHex(hint.blockNumber)] });
    if (!Array.isArray(raw)) throw new Error("historical block receipts unavailable");
    const blockReceipts = raw.map(formatTransactionReceipt);
    const matching = blockReceipts.filter(receipt => receipt.transactionHash?.toLowerCase() === hash);
    if (matching.length !== 1 || matching[0].blockNumber !== hint.blockNumber || matching[0].blockHash !== hint.blockHash) {
      throw new Error("historical block receipts do not contain the exact transaction at the hinted block");
    }
    receipts[i] = matching[0];
  }
  if (comparable(receipts[0]) !== comparable(receipts[1])) throw new Error("independent RPC receipts disagree");
  return receipts;
}

export function createShadowV2CycleService({ paymentTx, repaymentTx, clients } = {}) {
  if (!HASH.test(paymentTx || "") || !HASH.test(repaymentTx || "") || paymentTx.toLowerCase() === repaymentTx.toLowerCase()) {
    throw new Error("SHADOW_V2_PAYMENT_TX and SHADOW_V2_REPAYMENT_TX must be distinct transaction hashes");
  }
  const paymentHash = paymentTx.toLowerCase();
  const repaymentHash = repaymentTx.toLowerCase();
  const rpcClients = clients ?? ["https://rpc.testnet.arc.io", "https://rpc.drpc.testnet.arc.io"]
    .map((url) => createPublicClient({ transport: http(url, { timeout: 8_000 }) }));
  if (rpcClients.length !== 2 || rpcClients[0] === rpcClients[1]) throw new Error("two independent Arc RPC clients are required");
  const service = async () => { throw new Error("V2 cycle report must be prepared before provider acceptance"); };
  service.prepare = async ({ requestId }) => {
    if (reportPaymentFromRequest(requestId) !== paymentHash) return null;
    await Promise.all(rpcClients.map(async (client) => {
      if (await client.getChainId() !== CHAIN_ID) throw new Error("provider report RPC is not Arc testnet");
    }));
    const [payments, repayments] = await Promise.all([
      readHistoricalReceiptPair(rpcClients, paymentHash),
      readHistoricalReceiptPair(rpcClients, repaymentHash),
    ]);
    const reads = rpcClients.map((_, index) => [payments[index], repayments[index]]);
    const report = checkedCycle(reads[0][0], reads[0][1], paymentHash, repaymentHash);
    report.requestId = requestId;
    await verifyDebtInterval(rpcClients, reads[0][0], reads[0][1], report);
    // A prepared result is retained after acceptance, so reject shallow or
    // orphaned receipts before freezing their block hashes under the digest.
    await verifyCanonicalBlocks(rpcClients, reads[0]);
    return { result: `${JSON.stringify(report)}\n`, resultRef: `https://explorer.testnet.arc.io/tx/${paymentHash}` };
  };
  return service;
}
