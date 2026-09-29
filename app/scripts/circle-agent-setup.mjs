import { randomUUID } from 'node:crypto';
import { getAddress, keccak256, parseUnits, stringToHex } from 'viem';

const CHAIN = 5042002;
const MAX_ESTIMATED_FEE = parseUnits('0.1', 18);
const must = (ok, message) => { if (!ok) throw new Error(message); };

/** Activation is a zero-value self-transfer, never a payment or token approval.
 * A saved uncertain attempt is only observed, never automatically resubmitted.
 * Uses the executor's wallet-wide lock and checks its unresolved-operation barrier.
 */
export async function setupCircleAgentWallet({ agent, client, circle, journal, confirm = false }) {
  const address = getAddress(agent);
  const namespace = keccak256(stringToHex(JSON.stringify({ chainId: CHAIN, agent: address })));
  const key = `${namespace}:activation`;
  return journal.withLock(namespace, async () => {
    must(await client.getChainId() === CHAIN, 'Wallet setup is Arc testnet only.');
    await circle.session();
    const summary = {
      chainId: CHAIN, agent: address,
      sponsorLink: `https://www.shadowbuild.xyz/start?agent=${address}`,
      activation: { from: address, to: address, amount: '0', asset: 'native test USDC' },
    };
    const deployed = async () => {
      const code = await client.getCode({ address, blockTag: 'finalized' });
      return Boolean(code && code !== '0x');
    };
    const record = await journal.get(key);
    if (record) must(record.version === 1 && record.agent === address && record.chainId === CHAIN
      && ['unknown','not-submitted'].includes(record.status), 'Activation journal identity or status mismatch.');
    if (await deployed()) return {
      ...summary, status: 'ready', deployed: true, sent: false,
      next: 'Wallet code is deployed on Arc testnet. Share the sponsor link; the sponsor chooses and authorizes the budget.',
    };
    if (record && record.status !== 'not-submitted') return {
      ...summary, status: 'unknown', deployed: false, sent: false,
      next: 'An activation was already attempted and wallet code is not finalized yet. Run setup again to check; it will not resend. If this persists, inspect Circle transaction history in your own environment. Keep the state directory.',
    };
    must(!await journal.get(`${namespace}:active`), 'Recover the outstanding Circle operation before wallet activation.');
    const balance = await client.getBalance({ address });
    if (balance === 0n) return {
      ...summary, status: 'needs-funding', deployed: false, sent: false, nativeBalance: '0',
      next: 'Fund this address with Arc testnet USDC from https://faucet.circle.com, then run setup again. No faucet request or transfer was sent.',
    };
    const estimate = await circle.estimateActivation();
    must(typeof estimate?.networkFee === 'string' && /^\d+(\.\d{1,18})?$/.test(estimate.networkFee), 'Invalid Circle activation fee estimate.');
    const fee = parseUnits(estimate.networkFee, 18);
    must(fee <= MAX_ESTIMATED_FEE, 'Activation estimate exceeds 0.1 test USDC. Nothing sent.');
    must(balance >= fee, 'Insufficient native test USDC for the activation estimate. Nothing sent.');
    const review = {
      ...summary, deployed: false, nativeBalance: balance.toString(), estimatedNetworkFee: estimate.networkFee,
      feeNotice: '0.1 test USDC is an estimate threshold, not a guaranteed final fee cap. Gas is charged even though the transfer amount is zero.',
    };
    if (!confirm) return { ...review, status: 'review', sent: false,
      next: 'Review this zero-value self-transfer and fee estimate. Run setup with --confirm to authorize one attempt. Nothing signed or sent.' };
    // Recheck after estimation; another tool might already have activated the wallet.
    must(await client.getChainId() === CHAIN, 'Network changed before activation. Nothing sent.');
    if (await deployed()) return { ...summary, status: 'ready', deployed: true, sent: false,
      next: 'Wallet is already deployed. Share the sponsor link. Nothing sent.' };
    must(await client.getBalance({ address }) >= fee, 'Wallet balance changed below the estimate. Nothing sent.');
    const attempt = { version: 1, chainId: CHAIN, agent: address, idempotencyKey: randomUUID(), status: 'unknown' };
    await journal.put(key, attempt); // Durable barrier BEFORE any potentially submitted operation.
    try { await circle.activate({ idempotencyKey: attempt.idempotencyKey }); }
    catch (error) {
      if (error?.beforeSubmission === true) {
        await journal.put(key, { ...attempt, status: 'not-submitted' });
        return { ...review, status: 'not-submitted', sent: false,
          next: 'Session validation failed before submission. Restore Circle testnet login privately, then review setup again.' };
      }
      return { ...review, status: 'unknown', sent: 'unknown',
        next: 'Circle did not return a reliable activation result. Run setup to check finalized wallet code; do not resend or clear the state directory.' };
    }
    // Circle response alone is not proof of onchain deployment. Do not expose raw response data.
    try {
      if (await deployed()) return { ...review, status: 'ready', deployed: true, sent: true,
        next: 'Wallet code is now finalized on Arc testnet. Share the sponsor link.' };
    } catch { /* An RPC error after submission must remain recoverable without a resend. */ }
    return { ...review, status: 'unknown', sent: true,
      next: 'Activation requested; finalized wallet code is not confirmed yet. Run setup again to check without resending.' };
  });
}
