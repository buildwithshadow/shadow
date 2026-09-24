import { createRequire } from "node:module";

const { createPublicClient, decodeEventLog, formatUnits, getAddress, http, parseAbiItem } =
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
    checks: { twoRpcReceiptsMatch: true, providerTransferMatches: true, repaymentTransferMatches: true, debtRestored: true },
    limits: `Payment and repayment request hashes ${paid.requestHash === repaid.requestHash ? "match" : "differ"}. This pair is linked by agent, amount and sequential debt/credit state; it cannot prove the global absence of duplicate charges.`,
  };
}

function comparable(receipt) {
  return JSON.stringify({ status: receipt.status, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
    logs: receipt.logs.map(({ address, data, topics }) => ({ address: address.toLowerCase(), data, topics })) });
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
    if (typeof requestId !== "string" || requestId.toLowerCase() !== paymentHash) return null;
    const reads = await Promise.all(rpcClients.map(async (client) => {
      if (await client.getChainId() !== CHAIN_ID) throw new Error("provider report RPC is not Arc testnet");
      return Promise.all([
        client.getTransactionReceipt({ hash: paymentHash }),
        client.getTransactionReceipt({ hash: repaymentHash }),
      ]);
    }));
    for (let i = 0; i < 2; i++) {
      if (comparable(reads[0][i]) !== comparable(reads[1][i])) throw new Error("independent RPC receipts disagree");
    }
    const report = checkedCycle(reads[0][0], reads[0][1], paymentHash, repaymentHash);
    return { result: `${JSON.stringify(report)}\n`, resultRef: `https://explorer.testnet.arc.io/tx/${paymentHash}` };
  };
  return service;
}
