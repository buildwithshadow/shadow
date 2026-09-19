import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
  toBytes,
  toHex,
  zeroHash,
} from "viem";
import { sign } from "viem/accounts";

import { SPEND_INTENT_TYPES, eip712Domain, floatAbi } from "./float-mainnet-config.mjs";
import { CHAIN_ID, account, e2eSkip, keyOf, runTool, startAnvil } from "./float-mainnet-e2e.mjs";
import { DECLARED_LABEL, assembleBundle, declaredFrom, evidenceMarkdown, parseRequestId } from "./float-mainnet-evidence.mjs";
import { INDEX_KIND, validateIndex } from "./float-mainnet-indexer.mjs";
import { SECP256K1_HALF_ORDER, intentFile, validateIntentFile } from "./float-mainnet-intent.mjs";
import { validateReceiptFile } from "./float-mainnet-provider.mjs";

// The provider receipt format the exporter takes from the provider kit, written
// out here rather than imported, so a drift in the kit fails.
const SPEC_RECEIPT_TYPES = {
  ServiceAcceptance: [
    { name: "digest", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "principal", type: "uint256" },
    { name: "requestIdHash", type: "bytes32" },
    { name: "acceptedAt", type: "uint256" },
  ],
  DeliveryReceipt: [
    { name: "digest", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "requestIdHash", type: "bytes32" },
    { name: "resultHash", type: "bytes32" },
    { name: "resultRefHash", type: "bytes32" },
    { name: "deliveredAt", type: "uint256" },
  ],
};

const hash = (label) => keccak256(toBytes(label));
// Request ids and result locations are hashed as UTF-8 text, never decoded as hex.
const textHash = (text) => keccak256(stringToBytes(text));
const decimal = (message) => Object.fromEntries(Object.entries(message).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));

function receiptTypedData(primaryType, message, verifyingContract, chainId = CHAIN_ID) {
  return {
    domain: { name: "ShadowFloatMainnetProvider", version: "1", chainId, verifyingContract },
    types: { [primaryType]: SPEC_RECEIPT_TYPES[primaryType] },
    primaryType,
    message,
  };
}

// A provider receipt file as the kit writes it, signed directly with viem.
async function receiptFile(signer, primaryType, message, { verifyingContract, requestId, resultRef, chainId = CHAIN_ID }) {
  const typed = receiptTypedData(primaryType, message, verifyingContract, chainId);
  const file = {
    kind: `ShadowFloatMainnet.${primaryType}`,
    chainId: chainId.toString(),
    verifyingContract,
    typedData: { ...typed, domain: { ...typed.domain, chainId: chainId.toString() }, message: decimal(message) },
    signature: await signer.signTypedData(typed),
    signer: signer.address,
    requestId,
  };
  if (resultRef !== undefined) file.resultRef = resultRef;
  return file;
}

const acceptanceMessage = ({ digest, provider, endpointHash, principal, requestId, acceptedAt }) => ({
  digest,
  provider,
  endpointHash,
  principal,
  requestIdHash: textHash(requestId),
  acceptedAt,
});
const deliveryMessage = ({ digest, provider, requestId, result, resultRef, deliveredAt }) => ({
  digest,
  provider,
  requestIdHash: textHash(requestId),
  resultHash: hash(result),
  resultRefHash: resultRef === undefined ? zeroHash : textHash(resultRef),
  deliveredAt,
});

describe("evidence assembly from indexed events and participant files", () => {
  // Account index 1 is not used. FLOAT only names the EIP-712 verifying contract.
  const [sponsor, agent, executor, provider, otherAgent, otherProvider, payer] = [6, 7, 8, 9, 5, 4, 3].map(account);
  const FLOAT = account(20).address;
  const DEPLOYMENT = { chainId: CHAIN_ID.toString(), address: FLOAT, deployBlock: "90", runtimeKeccak256: hash("runtime"), sourceCommit: hash("commit").slice(2, 42) };
  const OBSERVED = { blockNumber: "500", blockHash: hash("observed block") };
  const LINE = hash("line A");
  const OTHER_LINE = hash("line B");
  const ENDPOINT_HASH = hash("https://provider.example/api/answer");
  const connection = { chainId: CHAIN_ID, address: FLOAT };

  // Index-shaped events (decimal strings), one per block, in order.
  function timeline() {
    let n = 0;
    return (event, args, from = executor.address) => {
      n += 1;
      return {
        event,
        args,
        blockNumber: String(100 + n),
        logIndex: 0,
        transactionHash: hash(`tx ${n}`),
        blockHash: hash(`block ${n}`),
        transactionIndex: 0,
        from,
        timestamp: String(1_790_000_000 + n * 3_600),
      };
    };
  }
  const opened = (ev, lineId = LINE, lineAgent = agent.address) =>
    ev("LineOpened", { lineId, sponsor: sponsor.address, agent: lineAgent, epoch: "1", reserve: "1000000", termsVersion: "1" }, sponsor.address);
  const providerPaid = (ev, digest, principal = "1000000", lineId = LINE) =>
    ev("ProviderPaid", { digest, lineId, provider: provider.address, principal, dueAt: "1790600000" });
  const repaid = (ev, amount, principalRemaining, from = agent.address, lineId = LINE) =>
    ev("Repaid", { lineId, payer: from, amount, principalRemaining }, from);
  const blocked = (ev, digest, reason, lineId = LINE) => ev("SpendBlocked", { digest, lineId, nonce: "9", reason, reasonName: "ignored" });
  const assemble = (events, rest = {}) => assembleBundle({ deployment: DEPLOYMENT, observedAt: OBSERVED, lineId: LINE, events, ...rest });

  async function signedIntent(signer, { lineId = LINE, principal = 1_000_000n, nonce }) {
    const struct = {
      agent: signer.address,
      sponsor: sponsor.address,
      lineId,
      lineEpoch: 1n,
      termsHash: hash("terms"),
      provider: provider.address,
      endpointHash: ENDPOINT_HASH,
      principal,
      maximumTotalDebt: principal,
      dueAt: 1_790_600_000n,
      nonce,
      signatureExpiry: 1_790_000_900n,
      executor: executor.address,
    };
    const signature = await signer.signTypedData({ domain: eip712Domain(CHAIN_ID, FLOAT), types: SPEND_INTENT_TYPES, primaryType: "SpendIntent", message: struct });
    const file = intentFile({ chainId: CHAIN_ID, verifyingContract: FLOAT, struct, signature, signerKind: "eoa" });
    return { path: `intent-${nonce}.json`, file, ...validateIntentFile(file, connection) };
  }

  // A receipt as the exporter holds it: its path and file, validated by the provider kit.
  async function receipt(signer, primaryType, message, extra = {}) {
    const file = await receiptFile(signer, primaryType, message, { verifyingContract: FLOAT, ...extra });
    return { path: `${primaryType}-${extra.requestId}.json`, file, ...validateReceiptFile(file, connection, `ShadowFloatMainnet.${primaryType}`) };
  }

  test("cycles, partial repayments, a refusal between cycles, and a default with a claim exit; missing files are counted, not fatal", () => {
    const ev = timeline();
    const [first, refused, second] = ["first", "refused", "second"].map(hash);
    const events = [
      opened(ev),
      ev("ProviderPolicySet", { lineId: LINE, provider: provider.address, endpointHash: ENDPOINT_HASH, perSpendCap: "1000000", dailySpendCap: "1000000", expiry: "1795000000", active: true, termsVersion: "1" }),
      opened(ev, OTHER_LINE, otherAgent.address),
      providerPaid(ev, first),
      repaid(ev, "400000", "600000"),
      providerPaid(ev, hash("other line draw"), "500000", OTHER_LINE),
      repaid(ev, "600000", "0"),
      blocked(ev, refused, 7),
      ev("SponsorAllowed", { sponsor: sponsor.address, allowed: true }, sponsor.address),
      providerPaid(ev, second),
      ev("LineDefaulted", { lineId: LINE, principalOutstanding: "1000000", dueAt: "1790600000" }, sponsor.address),
      repaid(ev, "300000", "700000", payer.address),
      ev("SponsorClaimed", { lineId: LINE, sponsor: sponsor.address, amount: "300000" }, sponsor.address),
    ];
    const at = (i) => ({ txHash: events[i].transactionHash, blockNumber: events[i].blockNumber });
    const { bundle, expected } = assemble(events);

    assert.deepEqual(bundle.line, { lineId: LINE, sponsor: sponsor.address, agent: agent.address, epoch: "1", opened: at(0) });
    assert.deepEqual(bundle.cycles, [
      {
        index: 1,
        digest: first,
        intent: null,
        spend: { ...at(3), executor: executor.address },
        repayments: [
          { ...at(4), payer: agent.address, amount: "400000" },
          { ...at(6), payer: agent.address, amount: "600000" },
        ],
        cleared: true,
        provider: { requestId: null, acceptance: null, delivery: null },
      },
      {
        index: 2,
        digest: second,
        intent: null,
        spend: { ...at(9), executor: executor.address },
        repayments: [{ ...at(11), payer: payer.address, amount: "300000" }],
        cleared: false,
        provider: { requestId: null, acceptance: null, delivery: null },
      },
    ]);
    // The reason comes from the event's enum value, not from any label beside it.
    assert.deepEqual(bundle.refusals, [{ digest: refused, ...at(7), reason: "LINE_RESERVE_CAP", intent: null }]);
    assert.deepEqual(bundle.exit, { kind: "claim-defaulted", ...at(12), amount: "300000" });
    assert.deepEqual(bundle.exporterSummary, {
      cycles: 2,
      cyclesCleared: 1,
      principalPaid: "2000000",
      principalRepaid: "1300000",
      refusals: 1,
      missingIntentFiles: 3,
      missingDeliveries: 2,
    });
    assert.deepEqual(expected, { state: "DEFAULTED", principalOutstanding: 700_000n, cumulativePrincipalPaid: 2_000_000n });
    assert.deepEqual(bundle.declared, { label: DECLARED_LABEL, independentControl: null, customerPurpose: null, assistance: null, commercial: null });
    assert.deepEqual([bundle.kind, bundle.schema, bundle.deployment, bundle.observedAt], ["ShadowFloatMainnet.EvidenceBundle", 1, DEPLOYMENT, OBSERVED]);
    // A provider receipt cannot be recovered from the chain; an intent sent directly to the Float can, from its calldata.
    assert.match(
      bundle.verifierScope,
      /On-chain.*Against this bundle's signatures only.*a missing provider receipt cannot be recovered from the chain.*From the transaction calldata: .*a missing intent file can be recovered from them.*Declared only/s,
    );
  });

  test("a closed line exits with close; a line with several defaulted claims is refused, since schema 1 records one exit", () => {
    let ev = timeline();
    const closedEvents = [opened(ev), providerPaid(ev, hash("a")), repaid(ev, "1000000", "0"), ev("LineClosed", { lineId: LINE, sponsor: sponsor.address, amount: "1000000" }, sponsor.address)];
    const closed = assemble(closedEvents);
    assert.deepEqual(closed.bundle.exit, { kind: "close", txHash: closedEvents[3].transactionHash, blockNumber: closedEvents[3].blockNumber, amount: "1000000" });
    assert.deepEqual(closed.expected, { state: "CLOSED", principalOutstanding: 0n, cumulativePrincipalPaid: 1_000_000n });

    ev = timeline();
    const claimedTwice = [
      opened(ev),
      providerPaid(ev, hash("b")),
      ev("LineDefaulted", { lineId: LINE, principalOutstanding: "1000000", dueAt: "1790600000" }, sponsor.address),
      repaid(ev, "250000", "750000"),
      ev("SponsorClaimed", { lineId: LINE, sponsor: sponsor.address, amount: "250000" }, sponsor.address),
      repaid(ev, "750000", "0"),
      ev("SponsorClaimed", { lineId: LINE, sponsor: sponsor.address, amount: "750000" }, sponsor.address),
    ];
    assert.throws(() => assemble(claimedTwice), /^Error: schema 1 records a single exit; this line has 2 claims \(SponsorClaimed\) up to block 500$/);
    // Up to the first claim, the same line exports with that claim as its exit.
    const claimedOnce = assemble(claimedTwice.slice(0, 5));
    assert.deepEqual([claimedOnce.bundle.exit.kind, claimedOnce.bundle.exit.amount, claimedOnce.bundle.exit.blockNumber], ["claim-defaulted", "250000", "105"]);
    assert.deepEqual([claimedOnce.expected.state, claimedOnce.bundle.cycles[0].cleared], ["DEFAULTED", false]);

    ev = timeline();
    const drawn = assemble([opened(ev), providerPaid(ev, hash("c")), repaid(ev, "100", "999900")]);
    assert.deepEqual([drawn.bundle.exit, drawn.expected.state, drawn.bundle.cycles[0].cleared], [{ kind: "none", txHash: null, blockNumber: null, amount: null }, "DRAWN", false]);
  });

  test("a line without its LineOpened, or a Repaid before any draw, is refused", () => {
    const ev = timeline();
    assert.throws(() => assemble([providerPaid(ev, hash("x"))]), /found 0 LineOpened events for line .* up to block 500; the line is not on this deployment, or the index starts after it was opened/);
    const early = timeline();
    assert.throws(() => assemble([opened(early), repaid(early, "1", "0")]), /Repaid in .* precedes every ProviderPaid .* the index is inconsistent/);
  });

  test("signed intent files attach to their recorded digests; other lines, unrecorded digests and unsigned files are refused", async () => {
    const paid = await signedIntent(agent, { nonce: 1n });
    const refusal = await signedIntent(agent, { nonce: 2n, principal: 5_000_000n });
    const ev = timeline();
    const events = [opened(ev), providerPaid(ev, paid.digest), repaid(ev, "1000000", "0"), blocked(ev, refusal.digest, 7)];

    const { bundle } = assemble(events, { intents: [paid, refusal, paid] });
    assert.deepEqual(bundle.cycles[0].intent, paid.file);
    assert.deepEqual(bundle.refusals[0].intent, refusal.file);
    assert.equal(bundle.exporterSummary.missingIntentFiles, 0);

    const foreign = await signedIntent(otherAgent, { lineId: OTHER_LINE, nonce: 1n });
    assert.throws(() => assemble(events, { intents: [foreign] }), new RegExp(`intent-1\\.json: the intent is for line ${OTHER_LINE}, not ${LINE}`));
    const unrecorded = await signedIntent(agent, { nonce: 3n });
    assert.throws(() => assemble(events, { intents: [unrecorded] }), new RegExp(`intent-3\\.json: digest ${unrecorded.digest} is not recorded on line ${LINE}`));
    const { signature, signerKind, ...unsignedFile } = paid.file;
    const unsigned = { path: "unsigned.json", file: unsignedFile, ...validateIntentFile(unsignedFile, connection) };
    assert.throws(() => assemble(events, { intents: [unsigned] }), /unsigned\.json: the intent file has no signature/);
    const altered = { ...paid, path: "altered.json", file: { ...paid.file, signerKind: "erc1271" } };
    assert.throws(() => assemble(events, { intents: [paid, altered] }), /altered\.json: a different intent file for digest/);
  });

  test("a provider receipt must be this deployment's EIP-712 type, signed for by the provider it names, with a matching request id hash", async () => {
    const message = acceptanceMessage({ digest: hash("d"), provider: provider.address, endpointHash: ENDPOINT_HASH, principal: 1_000_000n, requestId: "req-1", acceptedAt: 1_790_000_000n });
    const file = await receiptFile(provider, "ServiceAcceptance", message, { verifyingContract: FLOAT, requestId: "req-1" });
    const validate = (value, primaryType = "ServiceAcceptance") => validateReceiptFile(value, connection, `ShadowFloatMainnet.${primaryType}`);
    const valid = validate(file);
    assert.deepEqual([valid.kind, valid.message, valid.requestId, valid.resultRef], ["ShadowFloatMainnet.ServiceAcceptance", message, "req-1", null]);
    assert.equal(valid.hash, hashTypedData(receiptTypedData("ServiceAcceptance", message, FLOAT)));
    // An explicit EIP712Domain type, as eth_signTypedData_v4 payloads carry, is accepted.
    const EIP712Domain = [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ];
    const withDomainType = { ...file, typedData: { ...file.typedData, types: { EIP712Domain, ...file.typedData.types } } };
    assert.equal(validate(withDomainType).hash, valid.hash);

    const rejects = (value, pattern, primaryType = "ServiceAcceptance") => assert.throws(() => validate(value, primaryType), pattern);
    rejects(file, /the receipt is a ShadowFloatMainnet\.ServiceAcceptance, not a ShadowFloatMainnet\.DeliveryReceipt/, "DeliveryReceipt");
    const other = account(21).address;
    rejects({ ...file, verifyingContract: other, typedData: { ...file.typedData, domain: { ...file.typedData.domain, verifyingContract: other } } }, /receipt is bound to contract/);
    rejects({ ...file, chainId: "1", typedData: { ...file.typedData, domain: { ...file.typedData.domain, chainId: "1" } } }, /receipt is bound to chain 1/);
    rejects(
      { ...file, typedData: { ...file.typedData, domain: { ...file.typedData.domain, name: "ShadowFloatMainnet" } } },
      /EIP-712 domain is "ShadowFloatMainnet" version "1"; provider receipts use ShadowFloatMainnetProvider version 1/,
    );
    // A domain field the hash does not cover would misstate the signed domain.
    rejects(
      { ...file, typedData: { ...file.typedData, domain: { ...file.typedData.domain, salt: hash("salt") } } },
      /^Error: typedData\.domain has fields chainId, name, salt, verifyingContract, version; a provider receipt's domain is exactly name, version, chainId and verifyingContract$/,
    );
    rejects({ ...file, typedData: { ...file.typedData, types: { ServiceAcceptance: SPEC_RECEIPT_TYPES.ServiceAcceptance.slice(1) } } }, /typedData\.types is not the ServiceAcceptance type/);
    rejects({ ...file, requestId: "req-2" }, /requestId "req-2" does not hash to the message's requestIdHash 0x[0-9a-f]{64}/);
    rejects({ ...file, signer: otherProvider.address }, new RegExp(`signer ${otherProvider.address} is not the receipt's provider ${provider.address}`));
    rejects({ ...file, typedData: { ...file.typedData, message: { ...file.typedData.message, extra: "1" } } }, /unexpected fields: extra/);
    rejects({ ...file, resultRef: "x" }, /resultRef is only a string on a DeliveryReceipt/);
  });

  test("receipts attach to a paid cycle of their provider and principal; request ids must agree", async () => {
    const intent = await signedIntent(agent, { nonce: 1n });
    const ev = timeline();
    const refusedDigest = hash("refused");
    const events = [opened(ev), providerPaid(ev, intent.digest), blocked(ev, refusedDigest, 9)];
    const accept = (overrides = {}, signer = provider) =>
      receipt(signer, "ServiceAcceptance", acceptanceMessage({ digest: intent.digest, provider: signer.address, endpointHash: ENDPOINT_HASH, principal: 1_000_000n, requestId: "req-1", acceptedAt: 1n, ...overrides }), { requestId: overrides.requestId ?? "req-1" });
    const deliver = (overrides = {}) =>
      receipt(provider, "DeliveryReceipt", deliveryMessage({ digest: intent.digest, provider: provider.address, requestId: "req-1", result: "answer", resultRef: "result-1", deliveredAt: 2n, ...overrides }), { requestId: overrides.requestId ?? "req-1", resultRef: "result-1" });
    const acceptance = await accept();
    const delivery = await deliver();
    const requestId = parseRequestId(`${intent.digest}=req-1`);

    const { bundle } = assemble(events, { intents: [intent], acceptances: [acceptance], deliveries: [delivery], requestIds: [requestId] });
    assert.deepEqual(bundle.cycles[0].provider, { requestId: "req-1", acceptance: acceptance.file, delivery: delivery.file });
    assert.equal(bundle.exporterSummary.missingDeliveries, 0);
    // A request id from --request-id alone is recorded too.
    assert.equal(assemble(events, { requestIds: [requestId] }).bundle.cycles[0].provider.requestId, "req-1");

    const refuses = (rest, pattern) => assert.throws(() => assemble(events, rest), pattern);
    refuses({ acceptances: [await accept({ digest: refusedDigest })] }, /has no paid cycle on line .* \(it was refused, so nothing was paid\)/);
    refuses({ deliveries: [await deliver({ digest: hash("never recorded") })] }, /DeliveryReceipt-req-1\.json: digest .* has no paid cycle on line/);
    refuses({ acceptances: [await accept({ principal: 999_999n })] }, /accepts principal 999999, but cycle 1 paid 1000000/);
    refuses({ acceptances: [await accept({}, otherProvider)] }, new RegExp(`signed for provider ${otherProvider.address}, but cycle 1 paid ${provider.address}`));
    refuses({ intents: [intent], acceptances: [await accept({ endpointHash: hash("elsewhere") })] }, /accepts endpoint hash .* but the cycle 1 intent names/);
    refuses({ acceptances: [acceptance, acceptance] }, /cycle 1 already has a provider acceptance file/);
    refuses({ acceptances: [acceptance], deliveries: [await deliver({ requestId: "req-2" })] }, /cycle 1 has request id "req-1" from .* but "req-2" from/);
    refuses({ acceptances: [acceptance], requestIds: [parseRequestId(`${intent.digest}=req-9`)] }, /but "req-9" from --request-id/);
    refuses({ requestIds: [parseRequestId(`${refusedDigest}=req-1`)] }, /--request-id .* has no paid cycle/);
  });

  test("--request-id and --declared parse strictly; declarations are copied verbatim under their label", () => {
    const digest = hash("d");
    assert.deepEqual(parseRequestId(`${digest}=a=b`), { digest, requestId: "a=b", source: `--request-id ${digest}=a=b` });
    for (const raw of [digest, `${digest}=`, "0x12=abc"]) assert.throws(() => parseRequestId(raw), /--request-id/);

    const declaration = { independentControl: { sponsor: "Acme", operator: ["Bob", 2] }, commercial: "1 USDC per answer" };
    assert.deepEqual(declaredFrom(declaration), { ...declaration, customerPurpose: null, assistance: null });
    assert.throws(() => declaredFrom({ ...declaration, verified: true }), /unknown keys verified/);
    assert.throws(() => declaredFrom(["x"]), /must be a JSON object/);
    const ev = timeline();
    const { bundle } = assemble([opened(ev)], { declared: declaredFrom(declaration) });
    assert.deepEqual(bundle.declared, { label: DECLARED_LABEL, ...declaration, customerPurpose: null, assistance: null });
  });

  test("the Markdown summary keeps on-chain records, signed files and declarations apart", async () => {
    const intent = await signedIntent(agent, { nonce: 1n });
    const ev = timeline();
    const events = [opened(ev), providerPaid(ev, intent.digest), repaid(ev, "1000000", "0"), blocked(ev, hash("r"), 10)];
    const { bundle } = assemble(events, { intents: [intent], requestIds: [parseRequestId(`${intent.digest}=a|b`)], declared: declaredFrom({ assistance: "used ``` fences" }) });
    const markdown = evidenceMarkdown(bundle, events);
    const sections = ["## Recorded on-chain", "## Signed by participants (bundle)", "## Declared (not verified)", "## Verifier scope"];
    const offsets = sections.map((heading) => markdown.indexOf(heading));
    assert.ok(offsets.every((offset, i) => offset > 0 && (i === 0 || offset > offsets[i - 1])), offsets.join(","));
    assert.match(markdown, new RegExp(`\\| 1 \\| ${intent.digest} \\| ${provider.address} \\| 1000000 \\|`));
    assert.match(markdown, /\| 1 \| 0x[0-9a-f]+ \| DAILY_SPEND_CAP \|/);
    assert.match(markdown, /\| 1 \| included \| a\\\|b \| missing \| missing \|/);
    assert.match(
      markdown,
      /## Signed by participants \(bundle\)\n\nThe participants' own signed files, checked against the digests above\. A provider receipt is not recorded on-chain and cannot be recovered from the chain; an intent sent directly to the Float is also in its transaction's executeSpend calldata, from which a missing intent file can be recovered\.\n/,
    );
    assert.match(markdown, new RegExp(`> ${DECLARED_LABEL}`));
    assert.match(markdown, /### Assistance\n\n````json\n"used ``` fences"\n````/);
    assert.match(markdown, /### Commercial evidence\n\nNot declared\./);
  });

  test("an index file must be this deployment's EventIndex", () => {
    // timeline() events are in blocks 101 and later.
    const index = { kind: INDEX_KIND, schema: 1, chainId: CHAIN_ID.toString(), address: FLOAT, fromBlock: "0", checkpoint: { blockNumber: "500", blockHash: hash("b") }, events: [] };
    assert.equal(validateIndex(index, connection), index);
    assert.throws(() => validateIndex({ ...index, kind: "ShadowFloatMainnet.EvidenceBundle" }, connection), /not a ShadowFloatMainnet\.EventIndex schema 1 file/);
    assert.throws(() => validateIndex({ ...index, address: account(21).address }, connection), /the index is for .* not/);
    assert.throws(() => validateIndex({ ...index, checkpoint: { blockNumber: "5" } }, connection), /no valid fromBlock, checkpoint or events/);

    // Each event must be a Float event in the indexer's stored form.
    const ev = timeline();
    const events = [opened(ev), providerPaid(ev, hash("p")), blocked(ev, hash("r"), 7)];
    assert.equal(validateIndex({ ...index, events }, connection).events, events);
    const withEvent = (i, edit) => ({ ...index, events: events.map((entry, k) => (k === i ? edit(structuredClone(entry)) : entry)) });
    for (const [edit, pattern] of [
      [(entry) => ({ ...entry, event: "Transfer" }), /^Error: events\[1\] is not a Float event$/],
      [(entry) => ({ ...entry, logIndex: "0" }), /^Error: events\[1\] has no valid blockNumber and logIndex$/],
      [(entry) => ({ ...entry, args: { ...entry.args, principal: "1e6" } }), /^Error: events\[1\]\.args\.principal must be an unsigned decimal integer string$/],
      [(entry) => ({ ...entry, args: { ...entry.args, provider: entry.args.provider.toLowerCase() } }), /^Error: events\[1\]\.args\.provider 0x[0-9a-f]{40} is not in its stored form$/],
      [(entry) => ({ ...entry, from: undefined }), /^Error: events\[1\]\.from must be a 20-byte hex address/],
      // The enrichment fields: block hash, timestamp and transaction index, each in its stored form.
      [(entry) => ({ ...entry, blockHash: undefined }), /^Error: events\[1\]\.blockHash must be a 0x-prefixed bytes32$/],
      [(entry) => ({ ...entry, blockHash: entry.blockHash.slice(0, 64) }), /^Error: events\[1\]\.blockHash must be a 0x-prefixed bytes32$/],
      [(entry) => ({ ...entry, blockHash: `0x${entry.blockHash.slice(2).toUpperCase()}` }), /^Error: events\[1\]\.blockHash 0x[0-9A-F]{64} is not in its stored form$/],
      [(entry) => ({ ...entry, timestamp: undefined }), /^Error: events\[1\]\.timestamp must be a decimal string without leading zeros$/],
      [(entry) => ({ ...entry, timestamp: `0${entry.timestamp}` }), /^Error: events\[1\]\.timestamp must be a decimal string without leading zeros$/],
      [(entry) => ({ ...entry, timestamp: Number(entry.timestamp) }), /^Error: events\[1\]\.timestamp must be a decimal string without leading zeros$/],
      [(entry) => ({ ...entry, timestamp: "-1" }), /^Error: events\[1\]\.timestamp must be a decimal string without leading zeros$/],
      [(entry) => ({ ...entry, transactionIndex: undefined }), /^Error: events\[1\] has no valid transactionIndex$/],
      [(entry) => ({ ...entry, transactionIndex: "0" }), /^Error: events\[1\] has no valid transactionIndex$/],
      [(entry) => ({ ...entry, transactionIndex: -1 }), /^Error: events\[1\] has no valid transactionIndex$/],
      [(entry) => ({ ...entry, transactionIndex: 1.5 }), /^Error: events\[1\] has no valid transactionIndex$/],
    ]) {
      assert.throws(() => validateIndex(withEvent(1, edit), connection), pattern);
    }
    assert.throws(() => validateIndex(withEvent(2, (entry) => ({ ...entry, args: { ...entry.args, reason: -1 } })), connection), /events\[2\]\.args\.reason must be an unsigned/);

    // Each event at its own position, inside the blocks the index covers.
    assert.throws(
      () => validateIndex(withEvent(2, (entry) => ({ ...entry, blockNumber: events[0].blockNumber })), connection),
      /^Error: events\[2\] is at block 101 log index 0, the position of events\[0\]$/,
    );
    // The same position written with a leading zero is the same position.
    assert.throws(() => validateIndex(withEvent(1, (entry) => ({ ...entry, blockNumber: "0101" })), connection), /^Error: events\[1\] is at block 101 log index 0, the position of events\[0\]$/);
    assert.throws(() => validateIndex({ ...index, fromBlock: "102", events }, connection), /^Error: events\[0\] is in block 101, outside the index's blocks 102-500$/);
    assert.throws(
      () => validateIndex({ ...index, checkpoint: { ...index.checkpoint, blockNumber: "102" }, events }, connection),
      /^Error: events\[2\] is in block 103, outside the index's blocks 0-102$/,
    );
    // The bounds are inclusive; another log index in the same block is another position.
    const edges = [events[0], { ...events[1], blockNumber: events[0].blockNumber, logIndex: 1 }, events[2]];
    assert.equal(validateIndex({ ...index, fromBlock: "101", checkpoint: { ...index.checkpoint, blockNumber: "103" }, events: edges }, connection).events, edges);
  });
});

const PORT = 18581;
const RPC = `http://127.0.0.1:${PORT}`;
const ENDPOINT = "https://provider.example/api/answer";
const SIXTY_DAYS = "+5184000";
const PRICE = 1_000_000n;
const MAXIMA = { protocolReserve: 50_000_000n, lineReserve: 10_000_000n, lineSpend: 10_000_000n, perSpend: 2_000_000n, dailySpend: 4_000_000n };
const INITIAL = { protocolReserve: 25_000_000n, lineReserve: 5_000_000n, lineSpend: 5_000_000n, perSpend: 1_000_000n, dailySpend: 2_000_000n };

describe("evidence for a pilot line run through the participant CLIs", { skip: e2eSkip }, () => {
  // Account index 1 is not used.
  const [owner, sponsor, agent, executor, provider, agent2] = [0, 6, 7, 8, 9, 5].map(account);
  const OWNER = { FLOAT_OWNER_PRIVATE_KEY: keyOf(0) };
  const SPONSOR = { FLOAT_SPONSOR_PRIVATE_KEY: keyOf(6) };
  const AGENT = { FLOAT_AGENT_PRIVATE_KEY: keyOf(7) };
  const AGENT2 = { FLOAT_AGENT_PRIVATE_KEY: keyOf(5) };
  const EXECUTOR = { FLOAT_EXECUTOR_PRIVATE_KEY: keyOf(8) };
  const SOURCE_COMMIT = hash("evidence e2e source").slice(2, 42);
  const chain = defineChain({
    id: Number(CHAIN_ID),
    name: "anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC) });
  const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  const walletOf = (signer) => createWalletClient({ account: signer, chain, transport: http(RPC) });
  const artifact = (path) => JSON.parse(readFileSync(new URL(`../../contracts/out/${path}`, import.meta.url), "utf8"));

  let anvil;
  let dir;
  let float;
  let manifest;
  let deployBlock;
  let runtimeKeccak256;
  const seen = { cycles: [] };
  const path = (name) => join(dir, name);

  async function deploy(name, args) {
    const { abi, bytecode } = artifact(name);
    const receipt = await client.waitForTransactionReceipt({ hash: await walletOf(owner).deployContract({ abi, bytecode: bytecode.object, args }) });
    assert.equal(receipt.status, "success", name);
    return receipt;
  }

  // Every participant command names the deployment by its release manifest.
  const cli = (tool, args, env = {}) =>
    runTool(tool, [...args, "--manifest", manifest], { ARC_RPC_URL: RPC, FLOAT_MAINNET_EXPECTED_CHAIN_ID: CHAIN_ID.toString(), ...env });

  async function ok(tool, args, env) {
    const { status, json } = await cli(tool, args, env);
    assert.equal(status, 0, `${tool} ${args[0]}: ${JSON.stringify(json, null, 2)}`);
    assert.equal(json.ok, true);
    return json;
  }

  async function fails(tool, args, env, pattern) {
    const { status, json } = await cli(tool, args, env);
    assert.equal(status, 1, `${tool} ${args[0]}: ${JSON.stringify(json, null, 2)}`);
    assert.equal(json.ok, false);
    assert.match(json.error.message, pattern);
    return json;
  }

  const openArgs = (lineAgent) => [
    "open",
    "--agent", lineAgent.address,
    "--provider", provider.address,
    "--endpoint", ENDPOINT,
    "--reserve", "1000000",
    "--line-spend-cap", "3000000",
    "--daily-cap", "1000000",
    "--line-expiry", SIXTY_DAYS,
    "--max-repayment-window", "604800",
    "--provider-per-spend", "1000000",
    "--provider-daily", "1000000",
    "--provider-expiry", SIXTY_DAYS,
    "--execute",
  ];
  const buildArgs = (lineAgent, principal, out, extra = []) => [
    "build",
    "--agent", lineAgent.address,
    "--sponsor", sponsor.address,
    "--provider", provider.address,
    "--endpoint", ENDPOINT,
    "--principal", principal.toString(),
    "--executor", executor.address,
    "--out", out,
    ...extra,
  ];
  const eventOf = (output, name) => output.events.find((entry) => entry.event === name);

  before(async () => {
    anvil = await startAnvil(PORT);
    dir = mkdtempSync(join(tmpdir(), "float-evidence-"));
    const usdc = getAddress((await deploy("MockAsset.sol/MockAsset.json", ["USD Coin", "USDC", 6])).contractAddress);
    const deployed = await deploy("ShadowFloatMainnet.sol/ShadowFloatMainnet.json", [usdc, CHAIN_ID, MAXIMA, INITIAL, 3_600n, 604_800n, 172_800n]);
    float = getAddress(deployed.contractAddress);
    deployBlock = deployed.blockNumber;
    runtimeKeccak256 = keccak256(await client.getCode({ address: float }));
    const { abi } = artifact("MockAsset.sol/MockAsset.json");
    for (const [holder, amount] of [[sponsor, 10_000_000n], [agent, 5_000_000n]]) {
      const minted = await walletOf(owner).writeContract({ address: usdc, abi, functionName: "mint", args: [holder.address, amount] });
      assert.equal((await client.waitForTransactionReceipt({ hash: minted })).status, "success");
    }
    manifest = path("manifest.json");
    writeJson(manifest, {
      ok: true,
      chainId: CHAIN_ID.toString(),
      contract: { address: float },
      bytecode: { onchainRuntimeKeccak256: runtimeKeccak256 },
      deployment: { blockNumber: deployBlock.toString() },
      source: { commit: SOURCE_COMMIT },
    });
  });

  after(() => {
    anvil?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the owner allows the sponsor, who opens the pilot line and a second agent's line", async () => {
    await ok("owner", ["allow-sponsor", "--sponsor", sponsor.address, "--execute"], OWNER);
    const opened = await ok("sponsor", openArgs(agent), SPONSOR);
    const lineOpened = eventOf(opened, "LineOpened");
    seen.line = { lineId: opened.lineId, opened: { txHash: lineOpened.transactionHash, blockNumber: lineOpened.blockNumber } };
    seen.otherLineId = (await ok("sponsor", openArgs(agent2), SPONSOR)).lineId;
    // The second agent's own signed purchase, on its own line.
    await ok("intent", buildArgs(agent2, PRICE, path("foreign.json")));
    await ok("intent", ["sign", "--intent", path("foreign.json")], AGENT2);
  });

  test("three purchase and repayment cycles on separate UTC days, one repaid in two parts, each with provider receipts", async () => {
    for (let day = 1; day <= 3; day++) {
      if (day > 1) {
        // Mine after moving time, so build reads the new day's timestamp.
        await testClient.increaseTime({ seconds: 86_400 });
        await testClient.mine({ blocks: 1 });
      }
      const file = (kind) => path(`cycle${day}-${kind}.json`);
      const built = await ok("intent", buildArgs(agent, PRICE, file("intent")));
      const requestId = `request-${day}`;
      // The provider accepts the request for exactly this digest before it is paid.
      const acceptance = acceptanceMessage({
        digest: built.digest,
        provider: provider.address,
        endpointHash: hash(ENDPOINT),
        principal: PRICE,
        requestId,
        acceptedAt: (await client.getBlock()).timestamp,
      });
      writeJson(file("acceptance"), await receiptFile(provider, "ServiceAcceptance", acceptance, { verifyingContract: float, requestId }));
      await ok("intent", ["sign", "--intent", file("intent")], AGENT);
      const paid = await ok("submit", ["submit", "--intent", file("intent"), "--execute"], EXECUTOR);
      assert.deepEqual([paid.status, paid.digest], ["paid", built.digest]);
      const delivery = deliveryMessage({ digest: built.digest, provider: provider.address, requestId, result: `answer ${day}`, resultRef: `results/${day}`, deliveredAt: (await client.getBlock()).timestamp });
      writeJson(file("delivery"), await receiptFile(provider, "DeliveryReceipt", delivery, { verifyingContract: float, requestId, resultRef: `results/${day}` }));

      const repayments = [];
      for (const amount of day === 2 ? [["--amount", "400000"], ["--full"]] : [["--full"]]) {
        const repaid = eventOf(await ok("repay", ["--line-id", seen.line.lineId, ...amount, "--execute"], AGENT), "Repaid");
        repayments.push({ txHash: repaid.transactionHash, blockNumber: repaid.blockNumber, payer: agent.address, amount: repaid.args.amount });
      }
      seen.cycles.push({
        digest: built.digest,
        requestId,
        acceptance,
        spend: { txHash: paid.txHash, blockNumber: paid.providerPaid.blockNumber, executor: executor.address },
        repayments,
      });
    }
    assert.deepEqual(seen.cycles[1].repayments.map((repayment) => repayment.amount), ["400000", "600000"]);
    const days = await Promise.all(seen.cycles.map(async ({ spend }) => (await client.getBlock({ blockNumber: BigInt(spend.blockNumber) })).timestamp / 86_400n));
    assert.equal(new Set(days).size, 3);
  });

  test("an over-cap purchase is recorded deliberately as a refusal; the sponsor then closes the line", async () => {
    const status = await ok("line", ["status", "--line-id", seen.line.lineId, "--provider", provider.address]);
    const { remaining } = status.providers[0];
    assert.deepEqual([remaining.nextSpendMax, remaining.limitedBy], ["0", "LINE_SPEND_CAP"]);
    const overCap = BigInt(remaining.nextSpendMax) + 1n;
    const built = await ok("intent", buildArgs(agent, overCap, path("refusal.json"), ["--allow-block"]));
    await ok("intent", ["sign", "--intent", path("refusal.json"), "--allow-block"], AGENT);
    const blocked = await ok("submit", ["submit", "--intent", path("refusal.json"), "--execute", "--allow-block"], EXECUTOR);
    assert.deepEqual([blocked.status, blocked.reason], ["blocked", "LINE_SPEND_CAP"]);
    const spendBlocked = eventOf(blocked, "SpendBlocked");
    seen.refusal = { digest: built.digest, txHash: blocked.txHash, blockNumber: spendBlocked.blockNumber, reason: "LINE_SPEND_CAP" };

    const closed = await ok("sponsor", ["close", "--line-id", seen.line.lineId, "--execute"], SPONSOR);
    const lineClosed = eventOf(closed, "LineClosed");
    assert.equal(closed.amount, "1000000");
    seen.exit = { kind: "close", txHash: lineClosed.transactionHash, blockNumber: lineClosed.blockNumber, amount: "1000000" };
  });

  test("the indexer records every Float event, resumes from its checkpoint, and rebuilds after a reorg", async () => {
    const index = path("index.json");
    const full = await ok("indexer", ["index", "--out", index]);
    assert.deepEqual([full.mode, full.reorg, full.fromBlock], ["full", null, deployBlock.toString()]);
    const written = readJson(index);
    const head = await client.getBlock();
    assert.deepEqual(
      [written.kind, written.schema, written.chainId, written.address, written.fromBlock, written.checkpoint],
      [INDEX_KIND, 1, CHAIN_ID.toString(), float, deployBlock.toString(), { blockNumber: head.number.toString(), blockHash: head.hash }],
    );
    // The same logs straight from the node, in the same order.
    const logs = await client.getLogs({ address: float, fromBlock: deployBlock, toBlock: head.number });
    assert.deepEqual(
      written.events.map((entry) => [entry.transactionHash, entry.logIndex, entry.event]),
      logs.map((log) => [log.transactionHash, log.logIndex, decodeEventLog({ abi: floatAbi, data: log.data, topics: log.topics }).eventName]),
    );
    for (const entry of written.events) {
      const [block, transaction] = await Promise.all([client.getBlock({ blockNumber: BigInt(entry.blockNumber) }), client.getTransaction({ hash: entry.transactionHash })]);
      assert.deepEqual(
        [entry.blockHash, entry.timestamp, entry.from, entry.transactionIndex],
        [block.hash, block.timestamp.toString(), getAddress(transaction.from), transaction.transactionIndex],
      );
    }
    const paid = written.events.filter((entry) => entry.event === "ProviderPaid" && entry.args.lineId === seen.line.lineId);
    assert.deepEqual(paid.map((entry) => [entry.args.digest, entry.from]), seen.cycles.map((cycle) => [cycle.digest, executor.address]));
    // --from-block overrides the manifest's start; the constructor emits nothing, so the events are the same.
    const later = (deployBlock + 1n).toString();
    assert.equal((await ok("indexer", ["index", "--from-block", later, "--out", path("from-block.json")])).fromBlock, later);
    assert.deepEqual(readJson(path("from-block.json")), { ...written, fromBlock: later });

    // More blocks, one of them with a Float event: --resume scans only past the checkpoint.
    await ok("owner", ["pause", "--what", "openings", "--execute"], OWNER);
    await testClient.mine({ blocks: 3 });
    const resumed = await ok("indexer", ["index", "--out", index, "--resume"]);
    assert.deepEqual(
      [resumed.mode, resumed.reorg, resumed.newEvents, resumed.scanned.fromBlock],
      ["resumed", null, 1, (BigInt(full.checkpoint.blockNumber) + 1n).toString()],
    );
    await ok("indexer", ["index", "--out", path("fresh.json")]);
    assert.deepEqual(readJson(index), readJson(path("fresh.json")));

    // A reorg: the unpause and the blocks after it are replaced by other blocks.
    const snapshot = await testClient.snapshot();
    await ok("owner", ["unpause", "--what", "openings", "--execute"], OWNER);
    await testClient.mine({ blocks: 2 });
    const orphaned = await ok("indexer", ["index", "--out", index, "--resume"]);
    assert.equal(orphaned.newEvents, 1);
    copyFileSync(index, path("short.json"));
    copyFileSync(index, path("orphaned.json"));
    await testClient.revert({ id: snapshot });

    // The chain is now shorter than the checkpoint: its block no longer exists.
    const shorter = await ok("indexer", ["index", "--out", path("short.json"), "--resume"]);
    assert.deepEqual([shorter.mode, shorter.reorg.checkpoint, shorter.reorg.canonicalHash], ["rebuilt", orphaned.checkpoint, null]);
    assert.match(shorter.reorg.detail, /no longer exists/);

    // A rollback below the index's own start block leaves nothing to rebuild from: refused, the file untouched.
    const late = { ...readJson(path("orphaned.json")), fromBlock: orphaned.checkpoint.blockNumber, events: [] };
    writeJson(path("late.json"), late);
    await fails("indexer", ["index", "--out", path("late.json"), "--resume"], {}, /is before the index's start block/);
    assert.deepEqual(readJson(path("late.json")), late);

    // Remined past the checkpoint height, that height holds a different block.
    await testClient.increaseTime({ seconds: 7_200 });
    await testClient.mine({ blocks: 5 });
    const rebuilt = await ok("indexer", ["index", "--out", index, "--resume"]);
    assert.deepEqual([rebuilt.mode, rebuilt.reorg.checkpoint, rebuilt.scanned.fromBlock], ["rebuilt", orphaned.checkpoint, deployBlock.toString()]);
    assert.ok(rebuilt.reorg.canonicalHash && rebuilt.reorg.canonicalHash !== orphaned.checkpoint.blockHash, JSON.stringify(rebuilt.reorg));
    const rebuiltIndex = readJson(index);
    assert.deepEqual(rebuiltIndex.events.filter((entry) => entry.event === "OpeningsPauseSet").map((entry) => entry.args.paused), [true]);
    await ok("indexer", ["index", "--out", path("fresh.json")]);
    assert.deepEqual(rebuiltIndex, readJson(path("fresh.json")));
    seen.index = index;
  });

  test("the exported bundle matches the chain, keeps declarations verbatim under their label, and reports missing files", async () => {
    const declared = {
      independentControl: { sponsor: "Sponsor Co controls the sponsor key", operator: "Agent Ltd controls the agent and repayment keys" },
      customerPurpose: "Daily market summary requires one paid provider answer per day",
      assistance: ["Shadow supplied test USDC", "no live intervention"],
      commercial: { price: "1 USDC per answer", commitment: null },
    };
    writeJson(path("declared.json"), declared);
    const [c1, c2, c3] = seen.cycles;
    const files = [
      "--intent", path("cycle1-intent.json"),
      "--intent", path("cycle3-intent.json"),
      "--intent", path("refusal.json"),
      "--acceptance", path("cycle1-acceptance.json"),
      "--acceptance", path("cycle2-acceptance.json"),
      "--acceptance", path("cycle3-acceptance.json"),
      "--delivery", path("cycle1-delivery.json"),
      "--delivery", path("cycle2-delivery.json"),
      "--request-id", `${c3.digest}=${c3.requestId}`,
      "--declared", path("declared.json"),
    ];
    const exported = await ok("evidence", ["export", "--line-id", seen.line.lineId, ...files, "--out", path("bundle.json")]);
    const bundle = readJson(path("bundle.json"));
    const head = await client.getBlock();

    assert.deepEqual(bundle.observedAt, { blockNumber: head.number.toString(), blockHash: head.hash });
    assert.deepEqual(bundle.deployment, { chainId: CHAIN_ID.toString(), address: float, deployBlock: deployBlock.toString(), runtimeKeccak256, sourceCommit: SOURCE_COMMIT });
    assert.deepEqual(bundle.line, { lineId: seen.line.lineId, sponsor: sponsor.address, agent: agent.address, epoch: "1", opened: seen.line.opened });
    const provided = (cycle, { delivery = true } = {}) => ({
      requestId: cycle.requestId,
      acceptance: readJson(path(`cycle${seen.cycles.indexOf(cycle) + 1}-acceptance.json`)),
      delivery: delivery ? readJson(path(`cycle${seen.cycles.indexOf(cycle) + 1}-delivery.json`)) : null,
    });
    assert.deepEqual(bundle.cycles, [
      { index: 1, digest: c1.digest, intent: readJson(path("cycle1-intent.json")), spend: c1.spend, repayments: c1.repayments, cleared: true, provider: provided(c1) },
      { index: 2, digest: c2.digest, intent: null, spend: c2.spend, repayments: c2.repayments, cleared: true, provider: provided(c2) },
      { index: 3, digest: c3.digest, intent: readJson(path("cycle3-intent.json")), spend: c3.spend, repayments: c3.repayments, cleared: true, provider: provided(c3, { delivery: false }) },
    ]);
    assert.deepEqual(bundle.refusals, [{ ...seen.refusal, intent: readJson(path("refusal.json")) }]);
    assert.deepEqual(bundle.exit, seen.exit);
    assert.deepEqual(bundle.declared, { label: DECLARED_LABEL, ...declared });
    const summary = { cycles: 3, cyclesCleared: 3, principalPaid: "3000000", principalRepaid: "3000000", refusals: 1, missingIntentFiles: 1, missingDeliveries: 1 };
    assert.deepEqual([bundle.exporterSummary, exported.exporterSummary, exported.observedAt], [summary, summary, bundle.observedAt]);

    // Every ProviderPaid and SpendBlocked the node has for the line is in the bundle.
    const lineLogs = async (name) =>
      client.getLogs({ address: float, event: floatAbi.find((item) => item.type === "event" && item.name === name), args: { lineId: seen.line.lineId }, fromBlock: deployBlock, toBlock: head.number });
    assert.deepEqual(bundle.cycles.map((cycle) => cycle.digest), (await lineLogs("ProviderPaid")).map((log) => log.args.digest));
    assert.deepEqual(bundle.refusals.map((refusal) => refusal.digest), (await lineLogs("SpendBlocked")).map((log) => log.args.digest));

    const markdown = readFileSync(exported.markdown, "utf8");
    assert.equal(exported.markdown, `${path("bundle.json")}.md`);
    for (const text of ["## Recorded on-chain", "## Signed by participants (bundle)", "## Declared (not verified)", `> ${DECLARED_LABEL}`, c2.digest, "Missing intent files: 1. Missing delivery receipts: 1."]) {
      assert.ok(markdown.includes(text), text);
    }

    // The index file from the reorg test is canonical and at the head: the same bundle.
    await ok("evidence", ["export", "--line-id", seen.line.lineId, ...files, "--index", seen.index, "--out", path("bundle-from-index.json")]);
    assert.deepEqual(readJson(path("bundle-from-index.json")), bundle);
    // Its events in reverse order give the same bundle: the exporter orders them by block and log index.
    const index = readJson(seen.index);
    writeJson(path("reversed.json"), { ...index, events: [...index.events].reverse() });
    await ok("evidence", ["export", "--line-id", seen.line.lineId, ...files, "--index", path("reversed.json"), "--out", path("bundle-from-reversed.json")]);
    assert.deepEqual(readJson(path("bundle-from-reversed.json")), bundle);
  });

  test("export refuses a foreign intent, a receipt its provider did not sign, and an index that is stale, starts late or misses events", async () => {
    const out = path("refused.json");
    const base = ["export", "--line-id", seen.line.lineId, "--out", out];
    await fails("evidence", [...base, "--intent", path("foreign.json")], {}, new RegExp(`foreign\\.json: the intent is for line ${seen.otherLineId}, not ${seen.line.lineId}`));

    // Names the provider as signer, but the agent's key signed it.
    const forged = { ...(await receiptFile(agent, "ServiceAcceptance", seen.cycles[0].acceptance, { verifyingContract: float, requestId: seen.cycles[0].requestId })), signer: provider.address };
    writeJson(path("forged.json"), forged);
    await fails("evidence", [...base, "--acceptance", path("forged.json")], {}, new RegExp(`forged\\.json: the provider signature does not verify for ${provider.address}: signature recovers to ${agent.address}`));
    // A delivery whose result location was rewritten after the provider signed it.
    writeJson(path("redirected.json"), { ...readJson(path("cycle1-delivery.json")), resultRef: "results/elsewhere" });
    await fails("evidence", [...base, "--delivery", path("redirected.json")], {}, /redirected\.json: resultRef "results\/elsewhere" does not hash to the message's resultRefHash 0x[0-9a-f]{64}$/);

    await fails("evidence", [...base, "--index", path("orphaned.json")], {}, /orphaned\.json: checkpoint block \d+ is no longer 0x[0-9a-f]+ \(reorg\); run index --resume first/);
    const index = readJson(seen.index);
    writeJson(path("late.json"), { ...index, fromBlock: (deployBlock + 1n).toString() });
    await fails("evidence", [...base, "--index", path("late.json")], {}, /late\.json starts at block \d+, after the deployment block \d+, so it can miss events/);
    // A canonical checkpoint with a line event dropped or edited: the chain's
    // own logs for the line give it away, even for a refusal, which leaves
    // everything getLine reports unchanged.
    const incomplete = (name) =>
      new RegExp(`${name}\\.json does not hold line ${seen.line.lineId}'s events as the chain records them up to its checkpoint ${index.checkpoint.blockNumber}: `);
    const lastPaid = index.events.findLastIndex((entry) => entry.event === "ProviderPaid" && entry.args.lineId === seen.line.lineId);
    writeJson(path("gap.json"), { ...index, events: index.events.filter((_, i) => i !== lastPaid) });
    const gap = await fails("evidence", [...base, "--index", path("gap.json")], {}, incomplete("gap"));
    assert.match(gap.error.message, /: missing or altered ProviderPaid at block \d+ log \d+; not on the chain none$/);
    const refusal = index.events.findIndex((entry) => entry.event === "SpendBlocked" && entry.args.lineId === seen.line.lineId);
    assert.notEqual(refusal, -1);
    writeJson(path("no-refusal.json"), { ...index, events: index.events.filter((_, i) => i !== refusal) });
    const dropped = await fails("evidence", [...base, "--index", path("no-refusal.json")], {}, incomplete("no-refusal"));
    assert.match(dropped.error.message, /: missing or altered SpendBlocked at block \d+ log \d+; not on the chain none$/);
    const retimed = { ...index.events[refusal], timestamp: (BigInt(index.events[refusal].timestamp) + 1n).toString() };
    writeJson(path("retimed.json"), { ...index, events: index.events.map((entry, i) => (i === refusal ? retimed : entry)) });
    const edited = await fails("evidence", [...base, "--index", path("retimed.json")], {}, incomplete("retimed"));
    assert.match(edited.error.message, /: missing or altered SpendBlocked at block (\d+) log (\d+); not on the chain SpendBlocked at block \1 log \2$/);
    // An event not in the indexer's shape is refused before any cycle is assembled.
    writeJson(path("malformed.json"), { ...index, events: index.events.map((entry, i) => (i === lastPaid ? { ...entry, args: { ...entry.args, principal: "-1" } } : entry)) });
    await fails("evidence", [...base, "--index", path("malformed.json")], {}, new RegExp(`malformed\\.json: events\\[${lastPaid}\\]\\.args\\.principal must be an unsigned decimal integer string$`));
    assert.equal(existsSync(out), false);
    // index --resume keeps the existing events, so it refuses an index whose event lacks, or malforms, a block hash, timestamp or transaction index.
    const paidEvent = index.events[lastPaid];
    for (const [field, value, message] of [
      ["blockHash", undefined, "\\.blockHash must be a 0x-prefixed bytes32"],
      ["blockHash", paidEvent.blockHash.toUpperCase().replace("0X", "0x"), "\\.blockHash 0x[0-9A-F]{64} is not in its stored form"],
      ["timestamp", undefined, "\\.timestamp must be a decimal string without leading zeros"],
      ["timestamp", `0${paidEvent.timestamp}`, "\\.timestamp must be a decimal string without leading zeros"],
      ["transactionIndex", undefined, " has no valid transactionIndex"],
      ["transactionIndex", String(paidEvent.transactionIndex), " has no valid transactionIndex"],
    ]) {
      const name = `resume-${field}-${value === undefined ? "missing" : "malformed"}.json`;
      writeJson(path(name), { ...index, events: index.events.map((entry, i) => (i === lastPaid ? { ...entry, [field]: value } : entry)) });
      await fails("indexer", ["index", "--out", path(name), "--resume"], {}, new RegExp(`${name.replace(".", "\\.")}: events\\[${lastPaid}\\]${message}$`));
    }
  });

  test("a smart-account agent that rotates its signer after the spend still exports: its signature is checked where the contract checked it", async () => {
    // The reorg test left openings paused.
    await ok("owner", ["unpause", "--what", "openings", "--execute"], OWNER);
    const accountCode = "ShadowFloatMainnetPilotLifecycle.t.sol/PilotSmartAccount.json";
    const smartAgent = getAddress((await deploy(accountCode, [account(3).address])).contractAddress);
    const { lineId } = await ok("sponsor", openArgs({ address: smartAgent }), SPONSOR);
    const built = await ok("intent", buildArgs({ address: smartAgent }, PRICE, path("smart.json")));
    // PilotSmartAccount.isValidSignature expects abi.encode(r, s, v).
    const { r, s, v } = await sign({ hash: built.digest, privateKey: keyOf(3) });
    const signature = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }], [r, s, Number(v)]);
    await ok("intent", ["verify", "--intent", path("smart.json"), "--signature", signature, "--out", path("smart-signed.json")]);
    const paid = await ok("submit", ["submit", "--intent", path("smart-signed.json"), "--execute"], EXECUTOR);
    assert.equal(paid.status, "paid");

    // The account rotates its signer: another signer's account code at the same address.
    const rotated = await deploy(accountCode, [account(2).address]);
    await testClient.setCode({ address: smartAgent, bytecode: await client.getCode({ address: rotated.contractAddress }) });
    await testClient.mine({ blocks: 1 });
    const isValidSignature = (blockNumber, signed = signature) =>
      client.readContract({
        address: smartAgent,
        abi: parseAbi(["function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)"]),
        functionName: "isValidSignature",
        args: [built.digest, signed],
        blockNumber,
      });
    assert.equal(await isValidSignature(undefined), "0xffffffff", "the rotated account rejects the signature now");
    assert.equal(await isValidSignature(BigInt(paid.providerPaid.blockNumber) - 1n), "0x1626ba7e", "and accepted it before the spend");

    await ok("evidence", ["export", "--line-id", lineId, "--intent", path("smart-signed.json"), "--out", path("smart-bundle.json")]);
    const bundle = readJson(path("smart-bundle.json"));
    assert.deepEqual([bundle.cycles.length, bundle.cycles[0].digest, bundle.cycles[0].intent], [1, built.digest, readJson(path("smart-signed.json"))]);

    // The high-s twin of the account's signature, (r, n - s, the other v), is
    // another signature the account accepted for the digest before the spend,
    // so it passes the signature check. It is not the one the spend's
    // executeSpend calldata carries, and the export refuses it in the
    // verifier's words.
    const twin = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }],
      [r, toHex(2n * SECP256K1_HALF_ORDER + 1n - BigInt(s), { size: 32 }), Number(v) === 27 ? 28 : 27],
    );
    assert.equal(await isValidSignature(BigInt(paid.providerPaid.blockNumber) - 1n, twin), "0x1626ba7e", "the account accepted the twin before the spend");
    writeJson(path("smart-twin.json"), { ...readJson(path("smart-signed.json")), signature: twin });
    await fails(
      "evidence",
      ["export", "--line-id", lineId, "--intent", path("smart-twin.json"), "--out", path("smart-twin-bundle.json")],
      {},
      new RegExp(`smart-twin\\.json: the intent file's signature ${twin} is not the calldata's ${signature}$`),
    );
    assert.equal(existsSync(path("smart-twin-bundle.json")), false);
  });
});
