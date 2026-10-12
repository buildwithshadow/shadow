import { useEffect, useMemo, useRef, useState } from 'react';
import { recoverySession, resetRecoverySession, retainRecoveryTerminal, recoveryWalletBusy, beginRecoveryWalletWork, finishRecoveryWalletWork, subscribeRecoverySettlement } from './purchaseRecoverySession.mjs';
import { VerifiedServiceReport } from './VerifiedServiceReport';
import { useLocation } from 'react-router-dom';
import { recoverOriginalPurchase, type RecoveryResult } from './purchaseRecovery.mjs';
import { createWalletClient, custom, formatUnits, type Address, type Hex, type PublicClient } from 'viem';
import { candidateErrorMessage, candidateChainFor, candidateFundingAbi, type CandidateDeployment, type CandidateLine } from './candidateFunding';
import { assertGatewayFundingResolved, assertCandidateFundingResolved, assertPurchaseResolved, gatewayWalletLockKey } from './gatewayFundingGuard';
import { createSelfServicePurchase, createGuardedMainnetPurchase, type PurchaseRecord } from './selfServicePurchase.mjs';

export interface PublicService { name: string; provider: Address; endpoint: string; providerUrl: string; principal: string; sourcePayment: string; requestKind?: 'arc-wallet' }
export function PublicPurchase({ account, correctNetwork, deployment, service, client, busy, setBusy, fundingPending, lineId, onLineIdChange, onPurchaseChanged, loadedLine = null, active = true }: {
  account: Address | null; correctNetwork: boolean; deployment: CandidateDeployment; service: PublicService; client: PublicClient;
  busy: string; setBusy(value: string): void; fundingPending: boolean; lineId: string; onLineIdChange(value: string): void; onPurchaseChanged(lineId: string, transactionHash?: Hex): Promise<void>; loadedLine?: Pick<CandidateLine, 'lineId' | 'stateName'> | null; active?: boolean;
}) {
  const closedLine = loadedLine?.stateName === 'CLOSED' && loadedLine.lineId.toLowerCase() === lineId.trim().toLowerCase();
  const mainnet = deployment.chainId === 5042;
  const network = mainnet ? 'Arc mainnet' : 'Arc testnet';
  const currency = mainnet ? 'USDC' : 'test USDC';
  const chain = useMemo(() => candidateChainFor(deployment), [deployment]);
  const [record, setRecord] = useState<PurchaseRecord | null>(null);
  const [signingLineError, setSigningLineError] = useState('');
  const [signingLineCheck, setSigningLineCheck] = useState<{key:string; state:number} | null>(null);
  const signingKey = record ? `${record.intent.digest}:${record.stage}` : null;
  const signingLineVerified = signingKey !== null && signingLineCheck?.key === signingKey;
  const recordLineClosed = (closedLine && String(record?.intent.typedData.message.lineId ?? '').toLowerCase() === lineId.trim().toLowerCase()) || (signingLineVerified && signingLineCheck?.state === 4);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState('');
  const [refusedDigest, setRefusedDigest] = useState<string | null>(null);
  const [receiptCheck, setReceiptCheck] = useState<{ key: string; status: number } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [automaticChecking, setAutomaticChecking] = useState(false);
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const walletWorkKey = `${deployment.chainId}:${account}`;
  useEffect(() => subscribeRecoverySettlement(() => setRecoveryEpoch(value => value + 1)), []);
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState === 'visible');
  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const [history, setHistory] = useState<PurchaseRecord[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [archivedResult, setArchivedResult] = useState<{record: PurchaseRecord; text: string} | null>(null);
  const location = useLocation();
  const route = useRef(location.key);
  const routeGeneration = useRef(0);
  if (route.current !== location.key) { route.current = location.key; routeGeneration.current++; }
  const currentView = useRef({ active, correctNetwork, busy, account, deployment });
  currentView.current = { active, correctNetwork, busy, account, deployment };
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const visible = useRef(active);
  visible.current = active;
  const revision = useRef(0);
  const setup = useMemo(() => { try { return { engine: account && window.ethereum ? (mainnet ? createGuardedMainnetPurchase : createSelfServicePurchase)({
    client, wallet: createWalletClient({ chain, transport: custom(window.ethereum), account }),
    storage: window.localStorage,
    onProgress: setBusy,
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
  function refreshHistory() {
    try { setHistory(engine?.listArchived() ?? []); setHistoryError(''); }
    catch (cause) { setHistory([]); setHistoryError(candidateErrorMessage(cause)); }
  }
  useEffect(() => {
    revision.current++; setSigningLineCheck(null); setSigningLineError(''); setHistory([]); setHistoryError(''); setArchivedResult(null); setHistoryBusy(false); setReviewing(false); setRecord(null); setResult(''); setRefusedDigest(null); setReceiptCheck(null); setError(setup.error); setNotice('');
    const refresh = () => { try { setRecord(engine?.load() ?? null); } catch (cause) { setError(candidateErrorMessage(cause)); } refreshHistory(); };
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
  useEffect(() => {
    setSigningLineError('');
    if (!record || !engine || (record.stage !== 'prepared' && record.stage !== 'accepted') || !correctNetwork) return;
    let current = true;
    const key = `${record.intent.digest}:${record.stage}`;
    setSigningLineCheck(null);
    void client.readContract({address:deployment.address,abi:candidateFundingAbi,functionName:'getLine',args:[record.intent.typedData.message.lineId]})
      .then(raw => { if (current) { const state = Number((raw as {state:bigint}).state); if (!Number.isInteger(state) || state < 0 || state > 4) throw new Error('Funding line state could not be verified. No signature was requested.'); setSigningLineCheck({key,state}); } })
      .catch(cause => { if (current) setSigningLineError(candidateErrorMessage(cause)); });
    return () => { current = false; };
  }, [client, deployment.address, engine, record?.intent.digest, record?.stage, correctNetwork, recoveryEpoch]);
  const refused = refusedDigest === record?.intent.digest;
  const receiptCheckKey = record ? `${record.intent.digest}:${record.stage}` : null;
  const receiptChecked = receiptCheckKey !== null && receiptCheck?.key === receiptCheckKey;
  const receiptUnconfirmed = Boolean(record && !receiptChecked);
  const reviewable = record?.stage === 'prepared' || record?.stage === 'accepted';
  const signable = Boolean(reviewable && receiptChecked && receiptCheck?.status === 0 && !refused && !recordLineClosed && signingLineVerified && signingLineCheck?.state === 1);
  const checkingStatus = reviewable && !refused && receiptUnconfirmed;
  const paidPending = Boolean(record && !refused && record.stage !== 'delivered' && receiptChecked && receiptCheck?.status === 2);
  useEffect(() => {
    if (reviewing && record && signable && !dialog.current?.open) dialog.current?.showModal();
    else if (!reviewing || !record || !signable) dialog.current?.close();
  }, [record?.intent.digest, reviewing, signable]);
  useEffect(() => { if (!active) setReviewing(false); }, [active]);

  const needsRecovery = Boolean(record && !refused && (record.stage === 'submitted' || paidPending || record.stage === 'delivered' && !result));
  useEffect(() => {
    if (!engine || !record || !active || !correctNetwork || busy || !needsRecovery || !documentVisible) return;
    let cancelled = false;
    const generation = routeGeneration.current, current = revision.current;
    const digest = record.intent.digest;
    const sessionKey = `${deployment.chainId}:${deployment.address}:${deployment.runtimeHash}:${account}:${digest}`;
    const budget = recoverySession(sessionKey);
    if (budget.stopped) { setNotice('Automatic checks remain stopped for this purchase. Check the original payment below; this never sends another payment.'); return; }
    const isCurrent = () => !cancelled && revision.current === current && routeGeneration.current === generation &&
      currentView.current.active && currentView.current.correctNetwork && !currentView.current.busy &&
      currentView.current.account === account && currentView.current.deployment === deployment && document.visibilityState === 'visible';
    const publishRecovered = (recovered: RecoveryResult) => {
        setRecord(recovered.record);
        setReceiptCheck({ key: `${digest}:${recovered.record.stage}`, status: recovered.status === 'blocked' ? 1 : recovered.status === 'delivered' ? 2 : 0 });
        if (recovered.status === 'blocked') { setRefusedDigest(digest); setNotice('The contract refused this purchase. No provider payment was made for this intent.'); }
        else if (recovered.bytes) {
          try { setResult(new TextDecoder('utf-8', { fatal: true }).decode(recovered.bytes)); setError(''); setNotice('Payment confirmed and the original service result recovered.'); }
          catch { budget.stopped = true; setError('The verified service result is not readable UTF-8 text. Keep the original purchase.'); }
          void Promise.resolve().then(() => onPurchaseChanged(recovered.record.intent.typedData.message.lineId)).catch(() => { /* receipt remains verified; balances can refresh separately */ });
        } else setNotice('Checking the original payment. Do not submit another purchase while confirmation is unclear.');
      };
    const deferred = budget.deferred;
    if (deferred) {
      try {
        if (engine.load()?.intent.digest === digest) {
          publishRecovered(deferred); return;
        }
      } catch (cause) { budget.stopped = true; setError(candidateErrorMessage(cause)); return; }
    }
    // The old read's finally schedules a new effect. Do not spend this view's
    // budget while it is still settling, including a canceled sixth attempt.
    if (inFlight.current || recoveryWalletBusy(walletWorkKey)) return;
    setAutomaticChecking(true);
    void recoverOriginalPurchase({
      isCurrent,
      budget,
      isBusy: () => inFlight.current || recoveryWalletBusy(walletWorkKey),
      recover: async () => {
        if (inFlight.current) throw new Error('Another wallet action is in progress. Check the original purchase afterward.');
        if (engine.load()?.intent.digest !== digest) throw new Error('The saved purchase changed.');
        inFlight.current = true; beginRecoveryWalletWork(walletWorkKey); setRecovering(true);
        try {
          const recovered = await engine.recover();
          retainRecoveryTerminal(budget, recovered);
          return recovered;
        }
        finally {
          inFlight.current = false;
          if (isCurrent()) setRecovering(false);
          finishRecoveryWalletWork(walletWorkKey, !isCurrent());
        }
      },
      onResult: publishRecovered,
      onStop: cause => { budget.stopped = true; setRecovering(false); setAutomaticChecking(false); setNotice('Automatic checks have stopped. Check the original payment again below; this never sends another payment.'); if (cause) setError(candidateErrorMessage(cause)); },
    }).finally(() => { if (isCurrent()) setAutomaticChecking(false); });
    return () => { cancelled = true; setRecovering(false); setAutomaticChecking(false); };
  }, [engine, record?.intent.digest, active, correctNetwork, busy, needsRecovery, location.key, documentVisible, recoveryEpoch]);

  async function action(kind: 'prepare' | 'submit' | 'recover' | 'archive') {
    if (!engine || ((kind === 'prepare' && closedLine) || (kind === 'submit' && recordLineClosed)) || inFlight.current || recoveryWalletBusy(walletWorkKey) || busy || !correctNetwork || (refused && (kind === 'prepare' || kind === 'submit')) || (kind === 'submit' && !signable) || (fundingPending && (kind === 'prepare' || kind === 'submit'))) return;
    inFlight.current = true; beginRecoveryWalletWork(walletWorkKey);
    const current = revision.current;
    let recoveryFailed = false;
    setError(''); setNotice(''); setBusy(kind === 'submit' ? 'Confirm the purchase signature, then the transaction in your wallet…' : 'Checking your purchase…');
    try {
      if (kind === 'prepare') {
        const job = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
        await engine.prepare(lineId, service.requestKind === 'arc-wallet' ? `arc-wallet:${job}:${account}` : `report:${job}:${service.sourcePayment}`);
        if (revision.current === current && visible.current) setReviewing(true);
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
        const freshLine = await client.readContract({address:deployment.address,abi:candidateFundingAbi,functionName:'getLine',args:[record.intent.typedData.message.lineId]});
        if (revision.current !== current || !visible.current || currentView.current.account !== account || currentView.current.deployment !== deployment || !currentView.current.correctNetwork) return;
        const freshState = Number((freshLine as {state:bigint}).state);
        setSigningLineCheck({key:receiptCheckKey,state:freshState});
        if (freshState !== 1) throw new Error('Funding line is not open. No signature was requested.');
        await engine.submit();
        if (revision.current === current) { setReviewing(false); setNotice('Transaction requested. Check payment and recover the result below; do not submit a new purchase.'); }
      } else if (kind === 'recover') {
        if (record) resetRecoverySession(`${deployment.chainId}:${deployment.address}:${deployment.runtimeHash}:${account}:${record.intent.digest}`);
        const recovered = await engine.recover();
        retainRecoveryTerminal(recoverySession(`${deployment.chainId}:${deployment.address}:${deployment.runtimeHash}:${account}:${recovered.record.intent.digest}`), recovered);
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
    } catch (cause) { if (kind === 'recover') recoveryFailed = true; if (kind === 'submit') setSigningLineCheck(null); if (revision.current === current) { setError(candidateErrorMessage(cause)); setReviewing(false); } }
    finally {
      if (revision.current === current) {
        try {
          const saved = engine.load();
          setRecord(saved);
          refreshHistory();
          if (!saved) { setRefusedDigest(null); setReceiptCheck(null); }
          // Even a delivery failure can follow a confirmed payment. Refresh from
          // chain after submission/recovery, never infer balances from delivery.
          if (saved && (kind === 'recover' || (kind === 'submit' && saved.txHash))) {
            await onPurchaseChanged(saved.intent.typedData.message.lineId, kind === 'submit' ? saved.txHash as Hex : undefined);
          }
          // A failed recovery leaves the saved stage unchanged, so read the receipt status again.
          if (saved && recoveryFailed) {
            const status = Number(await client.readContract({ address: deployment.address, abi: candidateFundingAbi, functionName: 'receiptStatus', args: [saved.intent.digest] }));
            if (revision.current === current) {
              setReceiptCheck({ key: `${saved.intent.digest}:${saved.stage}`, status });
              if (status === 1) setRefusedDigest(saved.intent.digest);
            }
          }
        } catch (cause) { setError(candidateErrorMessage(cause)); }
      }
      inFlight.current = false; finishRecoveryWalletWork(walletWorkKey); setBusy('');
    }
  }
  const earlierReadPending = recoveryWalletBusy(walletWorkKey);
  async function openArchived(digest: string) {
    if (!engine || !account || !correctNetwork || busy || recovering || inFlight.current || recoveryWalletBusy(walletWorkKey)) return;
    const current = revision.current, generation = routeGeneration.current;
    const isCurrent = () => revision.current === current && routeGeneration.current === generation && visible.current &&
      currentView.current.account === account && currentView.current.deployment === deployment && currentView.current.correctNetwork;
    inFlight.current = true; beginRecoveryWalletWork(walletWorkKey); setHistoryBusy(true); setHistoryError(''); setArchivedResult(null);
    try {
      const recovered = await engine.recoverArchived(digest);
      const text = new TextDecoder('utf-8', {fatal:true}).decode(recovered.bytes);
      if (isCurrent()) setArchivedResult({record:recovered.record,text});
    } catch (cause) { if (isCurrent()) setHistoryError(candidateErrorMessage(cause)); }
    finally { inFlight.current = false; if (revision.current === current) setHistoryBusy(false); finishRecoveryWalletWork(walletWorkKey); }
  }
  const recoveryDisabled = !account || !correctNetwork || Boolean(busy) || recovering || historyBusy || earlierReadPending;
  const disabled = recoveryDisabled || fundingPending;
  const completedView = closedLine && !record;
  const visibleHistory = completedView ? history.filter(item => String(item.intent.typedData.message.lineId).toLowerCase() === lineId.trim().toLowerCase()) : history;
  const blocker = !account ? (completedView ? null : 'Connect the agent wallet to continue.') : !correctNetwork ? `Switch to ${network} to continue.`
    : busy ? busy : earlierReadPending && !inFlight.current ? 'Another operation for this wallet is finishing. The original purchase will be checked afterward.' : recordLineClosed ? 'This line is closed. Check the original payment or view its saved report; no new purchase can be signed.' : fundingPending ? 'Resolve the saved funding transaction before a new purchase. You can still check payment and recover or archive this purchase.' : reviewable && (!signingLineVerified || signingLineCheck?.state !== 1) ? 'Verify that the funding line is open before wallet review. If the check failed, refresh this page; payment recovery remains available.' : checkingStatus ? 'Confirm the saved purchase status before wallet review.' : paidPending ? 'A payment receipt is recorded. Check payment and recover the result before continuing.' : setup.error || null;
  const message = record?.intent.typedData.message;
  return <section className="fundingPanel purchasePanel" aria-labelledby="purchase-title">
    <h2 id="purchase-title">{completedView ? 'Reports from your completed line' : 'Buy a service with your agent’s budget'}</h2>
    {completedView ? <p>{service.name}. Opening a saved report does not send a payment.</p> : <p>{service.name} · {formatUnits(BigInt(service.principal), 6)} {currency}. {service.requestKind === 'arc-wallet' ? 'Receive a report of your connected wallet’s USDC balance, checked at a confirmed block using two RPC providers.' : 'Receive a report verifying a recorded Shadow payment and repayment. This test service uses public transaction data.'}</p>}
    {completedView ? <p>This funding line is closed. View its saved reports below. Open another funding line for new purchases.</p> : <p>Connect the agent’s browser wallet to sign and execute the purchase. It pays {mainnet ? 'mainnet' : 'testnet'} gas in USDC. The sponsor’s line covers the service price and records the repayment obligation.</p>}
    {!completedView && <ol className="purchaseSteps" role="list" aria-label="Purchase steps">
      <li data-state={!record ? 'current' : 'complete'} aria-current={!record ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">1</span><span className="purchaseStepLabel">Line</span></li>
      <li data-state={signable ? reviewing && busy ? 'complete' : 'current' : checkingStatus ? 'current' : !record ? 'upcoming' : 'complete'} aria-current={signable && !(reviewing && busy) || checkingStatus ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">2</span><span className="purchaseStepLabel">{checkingStatus ? 'Checking status' : 'Review terms'}</span></li>
      <li data-state={signable && reviewing && busy ? 'current' : !record || reviewable && !refused && (signable || receiptUnconfirmed) ? 'upcoming' : 'complete'} aria-current={signable && reviewing && Boolean(busy) ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">3</span><span className="purchaseStepLabel">Sign and submit</span></li>
      <li data-state={refused || paidPending ? 'complete' : record?.stage === 'submitted' ? 'current' : record?.stage === 'delivered' ? 'complete' : 'upcoming'} aria-current={!refused && !paidPending && record?.stage === 'submitted' ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">4</span><span className="purchaseStepLabel">{refused ? 'Payment refused' : 'Payment'}</span></li>
      <li data-state={!refused && record?.stage === 'delivered' ? result ? 'complete' : 'current' : paidPending ? 'current' : 'upcoming'} aria-current={!refused && record?.stage === 'delivered' && !result || paidPending ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">5</span><span className="purchaseStepLabel">Result</span></li>
      <li data-state={refused || record?.stage === 'delivered' && result ? 'current' : 'upcoming'} aria-current={refused || record?.stage === 'delivered' && result ? 'step' : undefined}><span className="purchaseStepNumber" aria-hidden="true">6</span><span className="purchaseStepLabel">Recover or archive</span></li>
    </ol>}
    {blocker && <p id="purchase-blocker" role="status">{blocker}</p>}
    {!record && !completedView && <form onSubmit={event => { event.preventDefault(); void action('prepare'); }}>
      <div className="fundingField"><label htmlFor="purchase-line">Funding line ID</label>
        <input id="purchase-line" value={lineId} onChange={event => onLineIdChange(event.target.value)} required disabled={Boolean(busy)} autoComplete="off" spellCheck={false} />
      </div><button type="submit" className="fundingPrimary" disabled={disabled} aria-describedby={blocker ? 'purchase-blocker' : undefined}>Review service purchase</button>
    </form>}
    {completedView && <dl className="fundingDetails"><div><dt>Closed line</dt><dd><code>{lineId}</code></dd></div></dl>}
    {record && <>
      <p>Saved purchase: <strong>{refused ? 'Refused by contract' : record.stage === 'delivered' ? 'Delivered' : receiptUnconfirmed ? 'Checking status' : paidPending ? 'Payment receipt found' : record.stage === 'submitted' ? 'Awaiting confirmation' : 'Ready for wallet review'}</strong>. Keep this browser’s site data until resolved.</p>
      <dl className="fundingDetails"><div><dt>Line</dt><dd><code>{message?.lineId}</code></dd></div><div><dt>Purchase ID</dt><dd><code>{record.intent.digest}</code></dd></div></dl>
      {record.txHash && <a href={`${chain.blockExplorers.default.url}/tx/${record.txHash}`} target="_blank" rel="noreferrer">View original transaction</a>}
      <div className="fundingActions">
        {reviewable && !refused && <button type="button" disabled={disabled || !signable} aria-describedby={(disabled || !signable) && blocker ? 'purchase-blocker' : undefined} onClick={() => setReviewing(true)}>Review saved purchase</button>}
        <button type="button" disabled={recoveryDisabled} aria-describedby={recoveryDisabled && blocker ? 'purchase-blocker' : undefined} onClick={() => void action('recover')}>Check payment & recover result</button>
        <button type="button" disabled={recoveryDisabled} aria-describedby={recoveryDisabled && blocker ? 'purchase-blocker' : undefined} onClick={() => void action('archive')}>{record.stage === 'delivered' ? 'Archive completed report' : 'Resolve refused or expired purchase'}</button>
      </div>
      <p>Recovery never resends a payment. An unknown payment remains held until confirmed or its unpaid authorization has expired. Repay debt and reclaim eligible funds under “Manage a line.”</p>
    </>}
    <div aria-live="polite">{notice && <p role="status">{notice}</p>}{error && <p className="fundingError" role="alert">{error}</p>}{signingLineError && <p className="fundingError" role="alert">{signingLineError}</p>}</div>
    {automaticChecking && <p role="status">Automatic checks are running for the original payment and report. These checks never send another payment.</p>}
    {result && record && account && <VerifiedServiceReport text={result} record={record} account={account} chainId={deployment.chainId} />}
    <section aria-labelledby="report-history-title">
      <h3 id="report-history-title">Reports saved in this browser</h3>
      <p>{completedView ? 'Reports for this line from this browser’s recent history.' : 'Up to 20 completed reports for this wallet, network and service.'} Opening a report rechecks its payment and signed result. Clearing site data removes local history.</p>
      {visibleHistory.length ? <ul>{visibleHistory.map(item => <li key={item.intent.digest}>
        <button type="button" disabled={recoveryDisabled || historyBusy} onClick={() => void openArchived(item.intent.digest)}>Open report {item.intent.digest.slice(0,10)}…{item.intent.digest.slice(-4)}</button>
      </li>)}</ul> : <p>{account ? completedView ? 'No report for this line is saved in this browser’s recent history.' : 'No completed reports are archived for this wallet and service.' : 'Connect the purchase wallet to view reports saved in this browser.'}</p>}
      {historyBusy && <p role="status">Checking the saved report receipt. No payment is being sent.</p>}
      {historyError && <p className="fundingError" role="alert">{historyError}</p>}
      {archivedResult && account && <VerifiedServiceReport text={archivedResult.text} record={archivedResult.record} account={account} chainId={deployment.chainId} />}
    </section>
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
