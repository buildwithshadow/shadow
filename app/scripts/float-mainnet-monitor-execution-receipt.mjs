import { TransactionReceiptNotFoundError } from 'viem';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const must = (ok, message) => { if (!ok) throw Error(message); };

// A missing transaction hash index is not a missing payment. Some Arc RPCs
// retain the complete canonical block receipts after pruning that index.
// Recover only the exact mined slot. Callers still verify the signed intent,
// exact payment log and historical Shadow receipt status as before.
export async function readExecutionReceipt(client, event) {
  must(typeof event.blockNumber === 'bigint' && event.blockNumber >= 0n
    && /^0x[0-9a-f]{64}$/i.test(event.blockHash ?? '')
    && /^0x[0-9a-f]{64}$/i.test(event.transactionHash ?? '')
    && Number.isSafeInteger(event.transactionIndex) && event.transactionIndex >= 0,
  'Execution receipt event has no mined block binding');
  try { return await client.getTransactionReceipt({ hash: event.transactionHash }); }
  catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error; }

  const block = await client.getBlock({ blockNumber: event.blockNumber });
  must(block.number === event.blockNumber && same(block.hash, event.blockHash)
    && Array.isArray(block.transactions) && same(block.transactions[event.transactionIndex], event.transactionHash),
  'Execution receipt block or transaction slot is not canonical');
  const receipts = await client.getBlockReceipts({ blockNumber: event.blockNumber });
  must(Array.isArray(receipts), 'Canonical block receipts are unavailable');
  const matches = receipts.filter(receipt => same(receipt?.transactionHash, event.transactionHash));
  must(matches.length === 1 && receipts[event.transactionIndex] === matches[0]
    && receipts.filter(receipt => receipt?.transactionIndex === event.transactionIndex).length === 1,
  'Execution receipt is absent or ambiguous in the canonical block slot');
  const receipt = matches[0];
  must(receipt.status === 'success' && receipt.blockNumber === event.blockNumber
    && same(receipt.blockHash, event.blockHash) && receipt.transactionIndex === event.transactionIndex
    && Array.isArray(receipt.logs) && receipt.logs.every(log => log.blockNumber === event.blockNumber
      && same(log.blockHash, event.blockHash) && same(log.transactionHash, event.transactionHash)
      && log.transactionIndex === event.transactionIndex && log.removed === false),
  'Recovered execution receipt differs from its mined event');
  const current = await client.getBlock({ blockNumber: event.blockNumber });
  must(current.number === event.blockNumber && same(current.hash, event.blockHash),
    'Execution receipt block changed during recovery');
  return receipt;
}
