import { useEffect, useMemo, useRef, useState } from 'react';
import { createWalletClient, custom, formatUnits, type Address, type PublicClient } from 'viem';
import { candidateErrorMessage, candidateFundingChain, type CandidateDeployment } from './candidateFunding';
import { createSelfServicePurchase, type PurchaseRecord } from './selfServicePurchase.mjs';

export interface PublicService { name: string; provider: Address; endpoint: string; providerUrl: string; principal: string; sourcePayment: string }
export function PublicPurchase({ account, correctNetwork, deployment, service, client, busy, setBusy, fundingPending, lineId, onLineIdChange }: {
  account: Address | null; correctNetwork: boolean; deployment: CandidateDeployment; service: PublicService; client: PublicClient;
  busy: string; setBusy(value: string): void; fundingPending: boolean; lineId: string; onLineIdChange(value: string): void;
}) {
  const [record, setRecord] = useState<PurchaseRecord | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const setup = useMemo(() => { try { return { engine: account && window.ethereum ? createSelfServicePurchase({
    client, wallet: createWalletClient({ chain: candidateFundingChain, transport: custom(window.ethereum), account }),
    storage: window.localStorage,
    config: { chainId: deployment.chainId, account, contract: deployment.address, runtimeHash: deployment.runtimeHash,
      provider: service.provider, providerUrl: service.providerUrl, endpoint: service.endpoint, principal: service.principal },
  }) : null, error: '' }; } catch (cause) { return { engine: null, error: candidateErrorMessage(cause) }; } }, [account, client, deployment, service]);
  const engine = setup.engine;
  useEffect(() => {
    revision.current++; setReviewing(false); setRecord(null); setResult(''); setError(setup.error); setNotice('');
    const refresh = () => { try { setRecord(engine?.load() ?? null); } catch (cause) { setError(candidateErrorMessage(cause)); } };
    refresh(); window.addEventListener('storage', refresh);
    return () => { revision.current++; window.removeEventListener('storage', refresh); };
  }, [engine, correctNetwork, setup.error]);
  useEffect(() => { if (reviewing && !dialog.current?.open) dialog.current?.showModal(); else if (!reviewing) dialog.current?.close(); }, [reviewing]);

  async function action(kind: 'prepare' | 'submit' | 'recover' | 'archive') {
    if (!engine || inFlight.current || busy || !correctNetwork || fundingPending) return;
    inFlight.current = true;
    const current = revision.current;
    setError(''); setNotice(''); setBusy(kind === 'submit' ? 'Confirm the purchase signature, then the transaction in your wallet…' : 'Checking your purchase…');
    try {
      if (kind === 'prepare') {
        const job = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
        await engine.prepare(lineId, `report:${job}:${service.sourcePayment}`);
        if (revision.current === current) setReviewing(true);
      } else if (kind === 'submit') {
        await engine.submit();
        if (revision.current === current) { setReviewing(false); setNotice('Transaction requested. Check payment and recover the result below; do not submit a new purchase.'); }
      } else if (kind === 'recover') {
        const recovered = await engine.recover();
        if (revision.current === current) {
          setNotice(recovered.status === 'delivered' ? 'Payment confirmed and the original service result recovered.' : recovered.status === 'blocked' ? 'The contract refused this purchase. No provider payment was made for this intent.' : 'No confirmed payment found yet. Finish any wallet prompt, then check again. This does not resend a transaction.');
          if (recovered.bytes) setResult(new TextDecoder('utf-8', { fatal: true }).decode(recovered.bytes));
        }
      } else {
        await engine.archive();
        if (revision.current === current) { setResult(''); setReviewing(false); setNotice('Purchase resolved and archived in this browser. You can prepare another purchase when the line permits it.'); }
      }
    } catch (cause) { if (revision.current === current) { setError(candidateErrorMessage(cause)); setReviewing(false); } }
    finally {
      if (revision.current === current) { try { setRecord(engine.load()); } catch (cause) { setError(candidateErrorMessage(cause)); } }
      inFlight.current = false; setBusy('');
    }
  }
  const disabled = !account || !correctNetwork || Boolean(busy) || fundingPending;
  const signable = record?.stage === 'prepared' || record?.stage === 'accepted';
  const message = record?.intent.typedData.message;
  return <section className="fundingPanel" aria-labelledby="purchase-title">
    <h2 id="purchase-title">Buy a service with your agent’s budget</h2>
    <p>{service.name} · {formatUnits(BigInt(service.principal), 6)} test USDC. Receive a report verifying a recorded Shadow payment and repayment. This test service uses public transaction data.</p>
    <p>Connect the agent’s browser wallet to sign and execute the purchase. It pays testnet gas. The sponsor’s line covers the service price and records the repayment obligation.</p>
    {!record && <form onSubmit={event => { event.preventDefault(); void action('prepare'); }}>
      <div className="fundingField"><label htmlFor="purchase-line">Funding line ID</label>
        <input id="purchase-line" value={lineId} onChange={event => onLineIdChange(event.target.value)} required disabled={Boolean(busy)} autoComplete="off" spellCheck={false} />
      </div><button type="submit" className="fundingPrimary" disabled={disabled}>Review service purchase</button>
    </form>}
    {record && <>
      <p>Saved purchase: <strong>{record.stage === 'submitted' ? 'Awaiting confirmation' : record.stage === 'delivered' ? 'Delivered' : 'Ready for wallet review'}</strong>. Keep this browser’s site data until resolved.</p>
      <dl className="fundingDetails"><div><dt>Line</dt><dd><code>{message?.lineId}</code></dd></div><div><dt>Purchase ID</dt><dd><code>{record.intent.digest}</code></dd></div></dl>
      {record.txHash && <a href={`https://testnet.arcscan.app/tx/${record.txHash}`} target="_blank" rel="noreferrer">View original transaction</a>}
      <div className="fundingActions">
        {signable && <button type="button" disabled={disabled} onClick={() => setReviewing(true)}>Review saved purchase</button>}
        <button type="button" disabled={disabled} onClick={() => void action('recover')}>Check payment & recover result</button>
        <button type="button" disabled={disabled} onClick={() => void action('archive')}>Resolve completed or expired purchase</button>
      </div>
      <p>Recovery never resends a payment. An unknown payment remains held until confirmed or its unpaid authorization has expired. Repay debt and reclaim eligible funds under “Manage a line.”</p>
    </>}
    <div aria-live="polite">{notice && <p role="status">{notice}</p>}{error && <p className="fundingError" role="alert">{error}</p>}</div>
    {result && <details open><summary>Your verified service result</summary><pre className="publicServiceResult">{result}</pre></details>}
    <dialog ref={dialog} className="fundingDialog" role="alertdialog" aria-labelledby="purchase-review-title" aria-describedby="purchase-review-description" onCancel={event => { if (inFlight.current) event.preventDefault(); else setReviewing(false); }}>
      {message && <><h2 id="purchase-review-title">Review this service purchase</h2>
        <p id="purchase-review-description">Pay {formatUnits(BigInt(message.principal), 6)} test USDC from the sponsor’s line. This creates an equal repayment obligation. A payment does not guarantee service delivery.</p>
        <dl className="fundingDetails"><div><dt>Provider</dt><dd><code>{message.provider}</code></dd></div><div><dt>Sponsor</dt><dd><code>{message.sponsor}</code></dd></div><div><dt>Agent / executor</dt><dd><code>{message.agent}</code></dd></div><div><dt>Repayment due</dt><dd>{new Date(Number(message.dueAt) * 1000).toLocaleString()}</dd></div></dl>
        <p>Your wallet will request a purchase signature and a separate Arc testnet transaction. Leave other wallet transactions closed until it finishes.</p>
        <div className="fundingActions"><button type="button" autoFocus disabled={Boolean(busy)} onClick={() => setReviewing(false)}>Back</button><button type="button" className="fundingPrimary" disabled={disabled || !signable} onClick={() => void action('submit')}>Sign & submit in wallet</button></div>
        {busy && <p role="status">{busy}</p>}
      </>}
    </dialog>
  </section>;
}
