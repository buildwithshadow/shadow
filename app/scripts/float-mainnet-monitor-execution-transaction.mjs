import { TransactionNotFoundError } from "viem";

// Some RPCs retain historical block bodies after pruning their transaction
// hash index. Recover only an exact event-bound transaction from that block;
// missing history is never an empty or successful execution audit.
export async function readExecutionTransaction(client, event) {
  if (typeof event.blockNumber !== "bigint" || !/^0x[0-9a-f]{64}$/i.test(event.blockHash ?? "") ||
      !/^0x[0-9a-f]{64}$/i.test(event.transactionHash ?? "")) throw new Error("execution event has no mined block binding");
  let tx;
  try { tx = await client.getTransaction({ hash: event.transactionHash }); }
  catch (error) { if (!(error instanceof TransactionNotFoundError)) throw error; }
  const block = await client.getBlock({ blockNumber: event.blockNumber, includeTransactions: !tx });
  if (block.number !== event.blockNumber || block.hash !== event.blockHash) throw new Error("execution event block is not canonical");
  if (!tx) {
    const matches = block.transactions?.filter(entry => typeof entry === "object" && entry?.hash === event.transactionHash) ?? [];
    if (matches.length !== 1) throw new Error("execution transaction is unavailable in its canonical block");
    tx = matches[0];
  }
  if (tx.hash !== event.transactionHash || tx.blockNumber !== event.blockNumber || tx.blockHash !== block.hash ||
      !Number.isSafeInteger(tx.transactionIndex) || tx.transactionIndex < 0 || tx.transactionIndex !== event.transactionIndex ||
      !/^0x[0-9a-f]{40}$/i.test(tx.from ?? "") || !/^0x(?:[0-9a-f]{2})*$/i.test(tx.input ?? "")) {
    throw new Error("execution transaction does not match its mined event");
  }
  return tx;
}
