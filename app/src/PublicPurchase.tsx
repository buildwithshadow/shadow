import { useEffect, useMemo, useRef, useState } from 'react';
import { createWalletClient, custom, formatUnits, type Address, type Hex, type PublicClient } from 'viem';
import { candidateErrorMessage, candidateChainFor, candidateFundingAbi, type CandidateDeployment } from './candidateFunding';
import { assertGatewayFundingResolved, assertCandidateFundingResolved, assertPurchaseResolved, gatewayWalletLockKey } from './gatewayFundingGuard';
import { createSelfServicePurchase, createGuardedMainnetPurchase, type PurchaseRecord } from './selfServicePurchase.mjs';

export interface PublicService { name: string; provider: Address; endpoint: string; providerUrl: string; principal: string; sourcePayment: string; requestKind?: 'arc-wallet' }
export function PublicPurchase({ account, correctNetwork, deployment, service, client, busy, setBusy, fundingPending, lineId, onLineIdChange, onPurchaseChanged }: {
  account: Address | null; correctNetwork: boolean; deployment: CandidateDeployment; service: PublicService; client: PublicClient;
  busy: string; setBusy(value: string): void; fundingPending: boolean; lineId: string; onLineIdChange(value: string): void; onPurchaseChanged(lineId: string, transactionHash?: Hex): Promise<void>;
}) {
  const mainnet = deployment.chainId === 5042;
  const network = mainnet ? 'Arc mainnet' : 'Arc testnet';
  const currency = mainnet ? 'USDC' : 'test USDC';
  const chain = useMemo(() => candidateChainFor(deployment), [deployment]);
  const [record, setRecord] = useState<PurchaseRecord | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState('');
  const [refusedDigest, setRefusedDigest] = useState<string | null>(null);
  const [receiptCheck, setReceiptCheck] = useState<{ key: string; status: number } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const setup = useMemo(() => { try { return { engine: account && window.ethereum ? (mainnet ? createGuardedMainnetPurchase : createSelfServicePurchase)({
    client, wallet: createWalletClient({ chain, transport: custom(window.ethereum), account }),
    storage: window.localStorage,
    withLock: async (key: string, work: () => Promise<unknown>, operation: 'prepare' | 'submit' | 'recover' | 'archive') => {
      if (!navigator.locks) throw new Error('This browser cannot coordinate wallet actions.');
      return navigator.locks.request(gatewayWalletLockKey(account, deployment.chainId), {ifAvailable:true}, async lock => {
        if (!lock) throw new Error('Another Shadow tab is using this wallet.');
        if (operation !== 'recover' && operation !== 'archive') {
          assertCandidateFundingResolved(account, window.localStorage, deployment.chainId);
          if (!mainnet) assertGatewayFundingResolved(account);
          assertPurchaseResolved(account, window.localStorage, deployment.chainId, key);
        }
        return navigator.locks.request(key, {ifAvailable:true}, async purchaseLock => {
          if (!purchaseLock) throw new Error('Another tab is using this purchase.');
          return work();
        });
      });
    },
    config: { chainId: deployment.chainId, account, contract: deployment.address, runtimeHash: deployment.runtimeHash,
      provider: service.provider, providerUrl: service.providerUrl, endpoint: service.endpoint, principal: service.principal },
  }) : null, error: '' }; } catch (cause) { return { engine: null, error: candidateErrorMessage(cause) }; } }, [account, client, deployment, service, mainnet, chain]);
  const engine = setup.engine;
  useEffect(() => {
    revision.current++; setReviewing(false); setRecord(null); setResult(''); setRefusedDigest(null); setReceiptCheck(null); setError(setup.error); setNotice('');
    const refresh = () => { try { setRecord(engine?.load() ?? null); } catch (cause) { setError(candidateErrorMessage(cause)); } };
    refresh(); window.addEventListener('storage', refresh);
    return () => { revision.current++; window.removeEventListener('storage', refresh); };
  }, [engine, correctNetwork, setup.error]);
  useEffect(() => {
    if (!engine || !record || refusedDigest === record.intent.digest) return;
    const checkKey = `${record.intent.digest}:${record.stage}`;
    let current = true;
    void client.readContract({ address: deployment.address, abi: candidateFundingAbi, functionName: 'receiptStatus', args: [record.intent.digest] })
      .then(status => {
        if (!current) return;
        setReceiptCheck({ key: checkKey, status: Number(status) });
        if (Number(status) === 1) {
          setRefusedDigest(record.intent.digest);
          setReviewing(false);
          setNotice('The contract refused this purchase. No provider payment was made for this intent.');
        }
      })
      .catch(cause => { if (current) setError(candidateErrorMessage(cause)); });
    return () => { current = false; };
  }, [client, deployment.address, engine, record?.intent.digest, record?.stage, refusedDigest]);
  const refused = refusedDigest === record?.intent.digest;
  const receiptCheckKey = record ? `${record.intent.digest}:${record.stage}` : null;
  const receiptChecked = receiptCheckKey !== null && receiptCheck?.key === receiptCheckKey;
  const receiptUnconfirmed = Boolean(record && !receiptChecked);
  const reviewable = record?.stage === 'prepared' || record?.stage === 'accepted';
  const reviewBlocked = Boolean(record && (!receiptChecked || receiptCheck?.status !== 0));
  const signable = Boolean(reviewable && receiptChecked && receiptCheck?.status === 0 && !refused);
  useEffect(() => {
    if (reviewing && record && signable && !dialog.current?.open) dialog.current?.showModal();
    else if (!reviewing || !record || !signable) dialog.current?.close();
  }, [record?.intent.digest, reviewing, signable]);

  async function action(kind: 'prepare' | 'submit' | 'recover' | 'archive') {
    if (!engine || inFlight.current || busy || !correctNetwork || (refused && (kind === 'prepare' || kind === 'submit')) || (kind === 'submit' && !signable) || (fundingPending && (kind === 'prepare' || kind === 'submit'))) return;
    inFlight.current = true;
    const current = revision.current;
    setError(''); setNotice(''); setBusy(kind === 'submit' ? 'Confirm the purchase signature, then the transaction in your wallet…' : 'Checking your purchase…');
    try {
      if (kind === 'prepare') {
        const job = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
        await engine.prepare(lineId, service.requestKind === 'arc-wallet' ? `arc-wallet:${job}:${account}` : `report:${job}:${service.sourcePayment}`);
        if (revision.current === current) setReviewing(true);
      } else if (kind === 'submit') {
        if (!record || !receiptCheckKey) return;
        const receiptStatus = Number(await client.readContract({ address: deployment.address, abi: candidateFundingAbi, functionName: 'receiptStatus', args: [record.intent.digest] }));
        setReceiptCheck({ key: receiptCheckKey, status: receiptStatus });
        if (receiptStatus === 1) {
          setRefusedDigest(record.intent.digest);
          setReviewing(false);
          setNotice('The contract refused this purchase. No provider payment was made for this intent.');
          return;
        }
        if (receiptStatus !== 0) {
          setReviewing(false);
          setNotice('A payment receipt is recorded. Check payment and recover the result before continuing.');
          return;
        }
        await engine.submit();
        if (revision.current === current) { setReviewing(false); setNotice('Transaction requested. Check payment and recover the result below; do not submit a new purchase.'); }
      } else if (kind === 'recover') {
        const recovered = await engine.recover();
        if (revision.current === current) {
          setReceiptCheck({ key: `${recovered.record.intent.digest}:${recovered.record.stage}`, status: recovered.status === 'blocked' ? 1 : recovered.status === 'delivered' ? 2 : 0 });
          setNotice(recovered.status === 'delivered' ? 'Payment confirmed and the original service result recovered.' : recovered.status === 'blocked' ? 'The contract refused this purchase. No provider payment was made for this intent.' : 'No confirmed payment found yet. Finish any wallet prompt, then check again. This does not resend a transaction.');
          if (recovered.status === 'blocked') { setRefusedDigest(recovered.record.intent.digest); setReviewing(false); }
          if (recovered.bytes) setResult(new TextDecoder('utf-8', { fatal: true }).decode(recovered.bytes));
        }
      } else {
        await engine.archive();
        if (revision.current === current) { setResult(''); setReviewing(false); setNotice('Purchase resolved and archived in this browser. You can prepare another purchase when the line permits it.'); }
      }
    } catch (cause) { if (revision.current === current) { setError(candidateErrorMessage(cause)); setReviewing(false); } }
    finally {
      if (revision.current === current) {
        try {
          const saved = engine.load();
          setRecord(saved);
          if (!saved) { setRefusedDigest(null); setReceiptCheck(null); }
          // Even a delivery failure can follow a confirmed payment. Refresh from
          // chain after submission/recovery, never infer balances from delivery.
          if (saved && (kind === 'recover' || (kind === 'submit' && saved.txHash))) {
            await onPurchaseChanged(saved.intent.typedData.message.lineId, kind === 'submit' ? saved.txHash as Hex : undefined);
          }
        } catch (cause) { setError(candidateErrorMessage(cause)); }
      }
      inFlight.current = false; setBusy('');
    }
  }
  const recoveryDisabled = !account || !correctNetwork || Boolean(busy);
  const disabled = recoveryDisabled || fundingPending;
  const blocker = !account ? 'Connect the agent wallet to continue.' : !correctNetwork ? `Switch to ${network} to continue.`
    : busy ? busy : fundingPending ? 'Resolve the saved funding transaction before a new purchase. You can still check payment and recover or archive this purchase.' : record && !receiptChecked ? 'Confirm the saved purchase status before wallet review.' : record && receiptChecked && receiptCheck?.status !== 0 && !refused ? 'A payment receipt is recorded. Check payment and recover the result before continuing.' : setup.error || null;
  const message = record?.intent.typedData.message;
  return <section className="fundingPanel purchasePanel" aria-labelledby="purchase-title">
    <h2 id="purchase-title">Buy a service with your agent’s budget</h2>
    <p>{service.name} · {formatUnits(BigInt(service.principal), 6)} {currency}. {service.requestKind === 'arc-wallet' ? 'Receive a report of your connected wallet’s USDC balance, checked at a confirmed block using two RPC providers.' : 'Receive a report verifying a recorded Shadow payment and repayment. This test service uses public transaction data.'}</p>
    <p>Connect the agent’s browser wallet to sign and execute the purchase. It pays {mainnet ? 'mainnet' : 'testnet'} gas in USDC. The sponsor’s line covers the service price and records the repayment obligation.</p>
    <ol className="purchaseSteps" role="list" aria-label="Purchase steps">
      <li data-state={!record ? 'current' : 'complete'} aria-current={!record ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">1</span><span className="purchaseStepLabel">Line</span></li>
      <li data-state={reviewBlocked ? 'upcoming' : reviewable ? reviewing && busy ? 'complete' : 'current' : record ? 'complete' : 'upcoming'} aria-current={!reviewBlocked && reviewable && !(reviewing && busy) ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">2</span><span className="purchaseStepLabel">Review terms</span></li>
      <li data-state={reviewBlocked ? 'upcoming' : reviewable ? reviewing && busy ? 'current' : 'upcoming' : record ? 'complete' : 'upcoming'} aria-current={!reviewBlocked && reviewable && reviewing && Boolean(busy) ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">3</span><span className="purchaseStepLabel">Sign and submit</span></li>
      <li data-state={refused ? 'complete' : record?.stage === 'submitted' ? 'current' : record?.stage === 'delivered' ? 'complete' : 'upcoming'} aria-current={!refused && record?.stage === 'submitted' ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">4</span><span className="purchaseStepLabel">{refused ? 'Payment refused' : 'Payment'}</span></li>
      <li data-state={!refused && record?.stage === 'delivered' ? result ? 'complete' : 'current' : 'upcoming'} aria-current={!refused && record?.stage === 'delivered' && !result ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">5</span><span className="purchaseStepLabel">Result</span></li>
      <li data-state={refused || record?.stage === 'delivered' && result ? 'current' : 'upcoming'} aria-current={refused || record?.stage === 'delivered' && result ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">6</span><span className="purchaseStepLabel">Recover or archive</span></li>
    </ol>
    {blocker && <p id="purchase-blocker" role="status">{blocker}</p>}
    {!record && <form onSubmit={event => { event.preventDefault(); void action('prepare'); }}>
      <div className="fundingField"><label htmlFor="purchase-line">Funding line ID</label>
        <input id="purchase-line" value={lineId} onChange={event => onLineIdChange(event.target.value)} required disabled={Boolean(busy)} autoComplete="off" spellCheck={false} />
      </div><button type="submit" className="fundingPrimary" disabled={disabled} aria-describedby={blocker ? 'purchase-blocker' : undefined}>Review service purchase</button>
    </form>}
    {record && <>
      <p>Saved purchase: <strong>{refused ? 'Refused by contract' : receiptUnconfirmed ? 'Checking status' : receiptChecked && receiptCheck?.status !== 0 ? 'Payment receipt found' : record.stage === 'submitted' ? 'Awaiting confirmation' : record.stage === 'delivered' ? 'Delivered' : 'Ready for wallet review'}</strong>. Keep this browser’s site data until resolved.</p>
      <dl className="fundingDetails"><div><dt>Line</dt><dd><code>{message?.lineId}</code></dd></div><div><dt>Purchase ID</dt><dd><code>{record.intent.digest}</code></dd></div></dl>
      {record.txHash && <a href={`${chain.blockExplorers.default.url}/tx/${record.txHash}`} target="_blank" rel="noreferrer">View original transaction</a>}
      <div className="fundingActions">
        {reviewable && !refused && <button type="button" disabled={disabled || !signable} aria-describedby={(disabled || !signable) && blocker ? 'purchase-blocker' : undefined} onClick={() => setReviewing(true)}>Review saved purchase</button>}
        <button type="button" disabled={recoveryDisabled} aria-describedby={recoveryDisabled && blocker ? 'purchase-blocker' : undefined} onClick={() => void action('recover')}>Check payment & recover result</button>
        <button type="button" disabled={recoveryDisabled} aria-describedby={recoveryDisabled && blocker ? 'purchase-blocker' : undefined} onClick={() => void action('archive')}>Resolve completed or expired purchase</button>
      </div>
      <p>Recovery never resends a payment. An unknown payment remains held until confirmed or its unpaid authorization has expired. Repay debt and reclaim eligible funds under “Manage a line.”</p>
    </>}
    <div aria-live="polite">{notice && <p role="status">{notice}</p>}{error && <p className="fundingError" role="alert">{error}</p>}</div>
    {result && <details open><summary>Your verified service result</summary><pre className="publicServiceResult">{result}</pre></details>}
    <dialog ref={dialog} className="fundingDialog" role="alertdialog" aria-labelledby="purchase-review-title" aria-describedby="purchase-review-description" onCancel={event => { if (inFlight.current) event.preventDefault(); else setReviewing(false); }}>
      {message && <><h2 id="purchase-review-title">Review this service purchase</h2>
        <p id="purchase-review-description">Pay {formatUnits(BigInt(message.principal), 6)} {currency} from the sponsor’s line. This creates an equal repayment obligation. A payment does not guarantee service delivery.</p>
        <dl className="fundingDetails"><div><dt>Provider</dt><dd><code>{message.provider}</code></dd></div><div><dt>Sponsor</dt><dd><code>{message.sponsor}</code></dd></div><div><dt>Agent / executor</dt><dd><code>{message.agent}</code></dd></div><div><dt>Repayment due</dt><dd>{new Date(Number(message.dueAt) * 1000).toLocaleString()}</dd></div></dl>
        <p>Your wallet will request a purchase signature and a separate {network} transaction. Leave other wallet transactions closed until it finishes.</p>
        <div className="fundingActions"><button type="button" autoFocus disabled={Boolean(busy)} aria-describedby={busy ? 'purchase-back-hint' : undefined} onClick={() => setReviewing(false)}>Back</button>{!refused && <button type="button" className="fundingPrimary" disabled={disabled || !signable} aria-describedby={busy ? 'purchase-back-hint' : disabled || !signable ? 'purchase-submit-hint' : undefined} onClick={() => void action('submit')}>Sign & submit in wallet</button>}
          {(disabled || !signable) && !busy && <small id="purchase-submit-hint">{blocker ?? 'This saved purchase is not ready to sign.'}</small>}
        </div>
        {busy && <p id="purchase-back-hint" role="status">{busy}</p>}
      </>}
    </dialog>
  </section>;
}
