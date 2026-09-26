import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { createPublicClient, createWalletClient, custom, formatUnits, getAddress, isAddress, type Address } from "viem";
import { createRpcReadTransport } from "../scripts/rpc-read-transport.mjs";
import {
  CANDIDATE_FUNDING, candidateErrorMessage, candidateFundingChain, createCandidateJournal, executeCandidateCall,
  prepareCandidateOpen, prepareCandidateReclaim, prepareCandidateRepay,
  readCandidateLine, readCandidateSnapshot, reconcileCandidatePending,
  type CandidateLine, type CandidateOpenInput, type CandidatePending, type CandidatePrepared,
  type CandidateResolution, type CandidateSnapshot,
} from "./candidateFunding";
import "./candidateFunding.css";

const client = createPublicClient({ chain: candidateFundingChain, transport: createRpcReadTransport("https://rpc.testnet.arc.network", {
  timeout: 15_000, queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3_000 },
}) });
const initialForm: CandidateOpenInput = {
  agent: "", provider: "", endpoint: "", reserve: "0.10", lineSpendCap: "0.15", dailySpendCap: "0.10",
  providerPerSpendCap: "0.05", providerDailyCap: "0.10", expiryDays: "7", repaymentHours: "24",
};
const explorer = "https://testnet.arcscan.app";
const usdc = (value: bigint) => formatUnits(value, 6);
const compact = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const when = (value: bigint) => new Date(Number(value) * 1000).toLocaleString();
const messageOf = candidateErrorMessage;
type Provider = NonNullable<Window["ethereum"]> & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

function Field({ label, name, value, onChange, hint, decimal = false, required = true, disabled = false }: {
  label: string; name: string; value: string; onChange: (value: string) => void; hint?: string; decimal?: boolean; required?: boolean; disabled?: boolean;
}) {
  return <div className="fundingField">
    <label htmlFor={`funding-${name}`}>{label}</label>
    <input id={`funding-${name}`} name={name} value={value} onChange={(event) => onChange(event.target.value)}
      inputMode={decimal ? "decimal" : "text"} autoComplete="off" spellCheck={false} required={required} disabled={disabled}
      aria-describedby={hint ? `funding-${name}-hint` : undefined} />
    {hint && <small id={`funding-${name}-hint`}>{hint}</small>}
  </div>;
}

export function CandidateFundingDesk() {
  const [mode, setMode] = useState<"open" | "manage">(() => new URLSearchParams(window.location.search).has("line") ? "manage" : "open");
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [form, setForm] = useState(initialForm);
  const [providerAgreed, setProviderAgreed] = useState(false);
  const [snapshot, setSnapshot] = useState<CandidateSnapshot | null>(null);
  const [lineId, setLineId] = useState(() => new URLSearchParams(window.location.search).get("line") || "");
  const [line, setLine] = useState<CandidateLine | null>(null);
  const [pending, setPending] = useState<CandidatePending | null>(null);
  const [journalError, setJournalError] = useState("");
  const [recoveryHash, setRecoveryHash] = useState("");
  const [prepared, setPrepared] = useState<CandidatePrepared | null>(null);
  const [reviewInput, setReviewInput] = useState<CandidateOpenInput | null>(null);
  const [resolution, setResolution] = useState<CandidateResolution | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);
  const activeAccount = useRef<Address | null>(null);
  const walletReadSequence = useRef(0);
  const submitting = useRef(false);
  const correctNetwork = chainId === CANDIDATE_FUNDING.chainId;
  const canWrite = Boolean(account && correctNetwork && !busy && !pending && !journalError);

  function invalidate() {
    revision.current += 1;
    setPrepared(null);
    setReviewInput(null);
    setResolution(null);
    setNotice("");
  }
  function updateForm(key: keyof CandidateOpenInput, value: string) {
    invalidate();
    if (key === "provider" || key === "endpoint") setProviderAgreed(false);
    setForm((previous) => ({ ...previous, [key]: value }));
  }
  function loadJournal(forAccount: Address) {
    if (activeAccount.current !== forAccount) return;
    try {
      setPending(createCandidateJournal(window.localStorage, forAccount).load());
      setJournalError("");
    } catch (cause) {
      setJournalError(`Transaction recovery is unavailable. ${messageOf(cause)}`);
    }
  }

  useEffect(() => {
    const provider = window.ethereum as Provider | undefined;
    if (!provider) return;
    let active = true;
    const refreshWallet = async () => {
      const sequence = ++walletReadSequence.current;
      try {
        const [accounts, network] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
        if (!active || walletReadSequence.current !== sequence) return;
        invalidate();
        const first = Array.isArray(accounts) && typeof accounts[0] === "string" && isAddress(accounts[0]) ? getAddress(accounts[0]) : null;
        activeAccount.current = first;
        setAccount(first);
        setChainId(typeof network === "string" ? Number(network) : null);
      } catch { if (active && walletReadSequence.current === sequence) { activeAccount.current = null; setAccount(null); setChainId(null); } }
    };
    const changed = () => {
      invalidate(); activeAccount.current = null; setAccount(null); setChainId(null);
      void refreshWallet();
    };
    void refreshWallet();
    provider.on?.("accountsChanged", changed);
    provider.on?.("chainChanged", changed);
    return () => {
      active = false;
      provider.removeListener?.("accountsChanged", changed);
      provider.removeListener?.("chainChanged", changed);
    };
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setPending(null);
    setJournalError("");
    if (!account) return;
    let active = true;
    loadJournal(account);
    const changed = () => loadJournal(account);
    window.addEventListener("storage", changed);
    readCandidateSnapshot(client, { sponsor: account }).then((value) => { if (active) setSnapshot(value); })
      .catch((cause) => { if (active) setError(`Could not read your sponsor status. ${messageOf(cause)}`); });
    return () => { active = false; window.removeEventListener("storage", changed); };
  }, [account]);

  useEffect(() => {
    if (prepared && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!prepared && dialog.current?.open) dialog.current.close();
  }, [prepared]);

  async function connect() {
    setError("");
    if (!window.ethereum) { setError("Open Shadow in a browser with Rabby, MetaMask or another Ethereum wallet, then connect here."); return; }
    setBusy("Connecting wallet…");
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      const sequence = ++walletReadSequence.current;
      const [accounts, network] = await Promise.all([
        window.ethereum.request({ method: "eth_accounts" }),
        window.ethereum.request({ method: "eth_chainId" }),
      ]);
      if (sequence !== walletReadSequence.current) return;
      if (!Array.isArray(accounts) || !isAddress(accounts[0])) throw new Error("No account was shared. Choose an account in your wallet.");
      invalidate();
      activeAccount.current = getAddress(accounts[0]);
      setAccount(activeAccount.current);
      setChainId(Number(network));
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(""); }
  }

  async function switchNetwork() {
    setError("");
    setBusy("Switching to Arc testnet…");
    try {
      if (!window.ethereum) throw new Error("Connect your browser wallet first.");
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${CANDIDATE_FUNDING.chainId.toString(16)}` }] });
      } catch (cause) {
        if ((cause as { code?: number }).code !== 4902) throw cause;
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
          chainId: `0x${CANDIDATE_FUNDING.chainId.toString(16)}`, chainName: "Arc Testnet",
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: ["https://rpc.testnet.arc.network"], blockExplorerUrls: [explorer],
        }] });
      }
      invalidate();
      setChainId(Number(await window.ethereum.request({ method: "eth_chainId" })));
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(""); }
  }

  async function review(action: "open" | "repay" | "reclaim", event?: FormEvent) {
    event?.preventDefault();
    if (!account || !canWrite) return;
    if (action === "open" && !providerAgreed) { setError("Confirm the provider accepts Shadow payments for this endpoint before funding it."); return; }
    const currentRevision = revision.current;
    setError(""); setNotice(""); setResolution(null); setBusy("Checking current limits and preparing your review…");
    try {
      if (action !== "open" && !line) throw new Error("Load the funding line before reviewing an action.");
      const value = action === "open" ? await prepareCandidateOpen(client, account, form)
        : action === "repay" ? await prepareCandidateRepay(client, account, line!.lineId)
        : await prepareCandidateReclaim(client, account, line!.lineId);
      if (revision.current !== currentRevision) throw new Error("The wallet or form changed. Review the current details again.");
      setReviewInput(action === "open" ? { ...form } : null);
      setPrepared(value);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(""); }
  }

  async function lookup(event?: FormEvent, id = lineId) {
    event?.preventDefault();
    invalidate(); setError(""); setLine(null); setBusy("Reading the funding line…");
    const currentRevision = revision.current;
    try {
      const value = await readCandidateLine(client, id);
      if (revision.current === currentRevision) setLine(value);
    }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(""); }
  }

  async function refreshAfter(result: CandidateResolution, forAccount: Address, currentRevision: number) {
    if (result.status !== "confirmed") return;
    const isCurrent = () => activeAccount.current === forAccount && revision.current === currentRevision;
    try {
      const refreshed = await readCandidateSnapshot(client, { sponsor: forAccount });
      if (!isCurrent()) return;
      setSnapshot(refreshed);
      const id = result.lineId || line?.lineId;
      if (id) {
        const refreshedLine = await readCandidateLine(client, id);
        if (!isCurrent()) return;
        setLineId(id); setLine(refreshedLine);
        if (result.lineId) setMode("manage");
      }
    } catch {
      if (isCurrent()) setNotice("The transaction is confirmed. The latest balance could not be loaded; refresh the line when your connection recovers.");
    }
  }

  async function sendReviewed() {
    if (!account || !prepared || !window.ethereum || submitting.current) return;
    const intent = prepared;
    const sender = account;
    const currentRevision = revision.current;
    const isCurrent = () => activeAccount.current === sender && revision.current === currentRevision;
    submitting.current = true;
    setBusy("Check and approve this transaction in your wallet…"); setError("");
    try {
      if (!navigator.locks) throw new Error("This browser cannot protect concurrent transactions. Use a current browser over HTTPS.");
      const journal = createCandidateJournal(window.localStorage, sender);
      await navigator.locks.request(journal.key, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("Another Shadow tab is handling this wallet. Finish that transaction there first.");
        const result = await executeCandidateCall({
          publicClient: client,
          walletClient: createWalletClient({ chain: candidateFundingChain, transport: custom(window.ethereum!), account: sender }),
          account: sender, journal,
          onStage: (value) => { if (isCurrent()) { setPending(value); setBusy(value.txHash ? "Checking transaction confirmation…" : "Check and approve this transaction in your wallet…"); } },
        }, intent);
        if (!isCurrent()) return;
        setResolution(result);
        setPrepared(null);
        loadJournal(sender);
        if (result.status === "confirmed" && intent.kind === "approve") {
          setNotice(`USDC approval confirmed. ${intent.nextAction === "open" ? "Review the funding line again to open it." : "Review repayment again to pay the current debt."}`);
        }
        await refreshAfter(result, sender, currentRevision);
      });
    } catch (cause) {
      if (isCurrent()) { setError(messageOf(cause)); setPrepared(null); loadJournal(sender); }
    } finally { submitting.current = false; setBusy(""); }
  }

  async function recover() {
    if (!account || busy) return;
    const currentRevision = revision.current;
    const isCurrent = () => activeAccount.current === account && revision.current === currentRevision;
    setError(""); setBusy("Checking the recorded transaction…");
    try {
      if (!navigator.locks) throw new Error("Use a current browser over HTTPS to check transaction recovery.");
      const journal = createCandidateJournal(window.localStorage, account);
      await navigator.locks.request(journal.key, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("A wallet request is still open in another Shadow tab. Finish it there first.");
        const saved = journal.load();
        if (!saved) { if (isCurrent()) setPending(null); return; }
        const result = await reconcileCandidatePending(client, saved, recoveryHash.trim() || undefined);
        if (result.status !== "unknown") journal.clear();
        if (!isCurrent()) return;
        setResolution(result); loadJournal(account);
        await refreshAfter(result, account, currentRevision);
      });
    } catch (cause) { if (isCurrent()) setError(messageOf(cause)); }
    finally { setBusy(""); }
  }

  const isSponsor = Boolean(account && line && account.toLowerCase() === line.sponsor.toLowerCase());
  const remaining = line ? (line.lineSpendCap > line.cumulativePrincipalPaid ? line.lineSpendCap - line.cumulativePrincipalPaid : 0n) : 0n;
  const repayable = line && (line.stateName === "DRAWN" || line.stateName === "DEFAULTED") && line.principalOutstanding > 0n;
  const reclaimable = line && isSponsor && ((line.stateName === "OPEN" && line.principalOutstanding === 0n) ||
    (line.stateName === "DEFAULTED" && line.availableReserve + line.recoveryAvailable > 0n));

  return <div className="routePage fundingDesk">
    <header className="fundingHead">
      <div><p className="pageEyebrow">Arc testnet · Candidate funding</p>
        <h1>Fund an agent.<br />Keep the limits.</h1>
        <p>Set aside USDC for an agent’s purchases. Track what it owes and reclaim eligible funds from your own wallet.</p>
      </div>
      <div className="fundingWallet">
        <span>{account ? "Connected browser wallet" : "Your wallet stays in control"}</span>
        {account && <code title={account}>{compact(account)}</code>}
        <button type="button" onClick={connect} disabled={Boolean(busy)}>{account ? "Refresh wallet" : "Connect wallet"}</button>
        {account && !correctNetwork && <button type="button" onClick={switchNetwork} disabled={Boolean(busy)}>Switch to Arc testnet</button>}
        {account && correctNetwork && <small>Arc testnet connected</small>}
      </div>
    </header>

    <p className="fundingScope">Test USDC only. Approved sponsors can fund lines here. Circle smart wallets can be the agent; funding and repayment here use a browser wallet.</p>
    <div className="fundingModes" aria-label="Funding actions">
      <button type="button" aria-pressed={mode === "open"} onClick={() => { invalidate(); setMode("open"); }} disabled={Boolean(busy)}>Open a funding line</button>
      <button type="button" aria-pressed={mode === "manage"} onClick={() => { invalidate(); setMode("manage"); }} disabled={Boolean(busy)}>Manage a line</button>
    </div>

    <div className="fundingFeedback" aria-live="polite" aria-atomic="true">
      {busy && <p role="status">{busy}</p>}
      {error && <p className="fundingError" role="alert">{error}</p>}
      {journalError && <p className="fundingError" role="alert">{journalError} New transactions are disabled until recovery is available.</p>}
      {notice && <p>{notice}</p>}
      {resolution && <p className={resolution.status === "confirmed" ? "fundingSuccess" : ""}>
        {resolution.message} {resolution.txHash && <a href={`${explorer}/tx/${resolution.txHash}`} target="_blank" rel="noreferrer">View transaction</a>}
      </p>}
    </div>

    {pending && <section className="fundingRecovery" aria-labelledby="funding-recovery-title">
      <h2 id="funding-recovery-title">Check the previous transaction first</h2>
      <p>A {pending.kind === "approve" ? "USDC approval" : pending.kind === "open" ? "line opening" : pending.kind === "repay" ? "repayment" : "reclaim"} has not been resolved. New transactions from this wallet are paused here so a retry cannot accidentally send it again.</p>
      <p>Finish any open wallet prompt. Then check its status. Keep this browser’s site data until it is resolved.</p>
      {pending.txHash && <a href={`${explorer}/tx/${pending.txHash}`} target="_blank" rel="noreferrer">Open the saved transaction</a>}
      <Field name="recovery-hash" label="Transaction hash from your wallet (optional)" value={recoveryHash} onChange={setRecoveryHash} required={false}
        hint="Use the original transaction, or its confirmed replacement. An unrelated payment cannot clear this check." />
      <button type="button" onClick={recover} disabled={Boolean(busy)}>Check confirmation</button>
      <details><summary>No transaction hash in your wallet?</summary>
        <p>The request may not have been sent, but a missing hash cannot prove that. In your wallet, cancel or replace the request using this account and nonce, then enter the confirmed replacement hash above. That prevents the original nonce from executing later. Ask the Shadow operator for help if your wallet does not offer replacement controls.</p>
        <dl className="fundingDetails"><div><dt>Account</dt><dd><code>{pending.account}</code></dd></div><div><dt>Saved transaction nonce</dt><dd>{pending.nonce}</dd></div></dl>
      </details>
    </section>}

    {mode === "open" ? <form className="fundingPanel" onSubmit={(event) => void review("open", event)}>
      <div className="fundingPanelHead"><div><h2>Set the purchase budget</h2><p>One agent, one approved provider, one outstanding purchase at a time.</p></div>
        {snapshot && <span className="fundingBalance">{usdc(snapshot.balance)} USDC available</span>}
      </div>
      {snapshot && !snapshot.sponsorAllowed && <p className="fundingCallout">This wallet is not approved as a sponsor yet. Ask the Shadow operator to approve its public address. You can still inspect a line under “Manage a line.”</p>}
      {snapshot?.openingsPaused && <p className="fundingCallout">New lines are currently paused. Existing repayment and eligible reclaim remain available.</p>}
      <fieldset disabled={Boolean(busy)}><legend>Who will use the budget?</legend><div className="fundingGrid">
        <Field name="agent" label="Agent wallet address" value={form.agent} onChange={(value) => updateForm("agent", value)} hint="The wallet that will sign each purchase. A deployed Circle Modular Wallet is supported as the agent." />
        <Field name="provider" label="Provider payment address" value={form.provider} onChange={(value) => updateForm("provider", value)} hint="Confirm this destination with the provider before funding." />
        <div className="fundingWide"><Field name="endpoint" label="Agreed service endpoint" value={form.endpoint} onChange={(value) => updateForm("endpoint", value)} hint="Paste the exact HTTPS endpoint agreed with the provider. Shadow binds purchases to this text; this form does not contact the endpoint." /></div>
      </div></fieldset>
      <fieldset disabled={Boolean(busy)}><legend>How much can the agent use?</legend><div className="fundingGrid fundingThree">
        <Field name="reserve" label="USDC to set aside" value={form.reserve} onChange={(value) => updateForm("reserve", value)} decimal hint="Transferred into the line when it opens." />
        <Field name="lineSpendCap" label="Total purchase limit (USDC)" value={form.lineSpendCap} onChange={(value) => updateForm("lineSpendCap", value)} decimal hint="Cumulative across this line. Repayment does not reset it." />
        <Field name="dailySpendCap" label="Line daily limit (USDC)" value={form.dailySpendCap} onChange={(value) => updateForm("dailySpendCap", value)} decimal hint="Resets at midnight UTC." />
        <Field name="providerPerSpendCap" label="Maximum purchase (USDC)" value={form.providerPerSpendCap} onChange={(value) => updateForm("providerPerSpendCap", value)} decimal />
        <Field name="providerDailyCap" label="Provider daily limit (USDC)" value={form.providerDailyCap} onChange={(value) => updateForm("providerDailyCap", value)} decimal />
      </div></fieldset>
      <fieldset disabled={Boolean(busy)}><legend>When must it be repaid?</legend><div className="fundingGrid">
        <Field name="expiryDays" label="Line and provider approval duration (days)" value={form.expiryDays} onChange={(value) => updateForm("expiryDays", value)} decimal />
        <Field name="repaymentHours" label="Maximum repayment window (hours)" value={form.repaymentHours} onChange={(value) => updateForm("repaymentHours", value)} decimal hint="Each signed purchase sets its due time within this window." />
      </div></fieldset>
      <label className="fundingCheck"><input type="checkbox" checked={providerAgreed} onChange={(event) => { invalidate(); setProviderAgreed(event.target.checked); }} disabled={Boolean(busy)} />
        <span>The provider has agreed to accept Shadow’s payment proof and deliver this service. A token transfer alone does not guarantee delivery or repayment.</span></label>
      <div className="fundingActions"><button className="fundingPrimary" type="submit" disabled={!canWrite || !providerAgreed || snapshot?.sponsorAllowed === false || snapshot?.openingsPaused}>Review funding line</button>
        <small>{!account ? "Connect your wallet to review and fund." : !correctNetwork ? "Switch to Arc testnet to continue." : "Review first. Any USDC approval and funding transaction need separate wallet confirmations."}</small></div>
    </form> : <section className="fundingPanel" aria-labelledby="funding-manage-title">
      <div className="fundingPanelHead"><div><h2 id="funding-manage-title">Find your funding line</h2><p>Read its balance without connecting a wallet. Connect to repay or reclaim.</p></div></div>
      <form className="fundingLookup" onSubmit={(event) => void lookup(event)}>
        <Field name="line" label="Funding line ID" value={lineId} onChange={(value) => { invalidate(); setLine(null); setLineId(value); }} disabled={Boolean(busy)} hint="The 0x identifier from your line-opening receipt." />
        <button type="submit" disabled={Boolean(busy)}>Load line</button>
      </form>
      {line && <div className="fundingLine">
        <div className="fundingPanelHead"><h3>{line.stateName === "DRAWN" ? "Purchase awaiting repayment" : line.stateName === "OPEN" ? "Line open" : line.stateName === "CLOSED" ? "Line closed" : "Line defaulted"}</h3>
          <span>Updated at block {line.observedBlock.toString()}</span></div>
        <dl className="fundingMetrics">
          <div><dt>Available reserve</dt><dd>{usdc(line.availableReserve)} <small>USDC</small></dd></div>
          <div><dt>Outstanding debt</dt><dd>{usdc(line.principalOutstanding)} <small>USDC</small></dd></div>
          <div><dt>Total purchases</dt><dd>{usdc(line.cumulativePrincipalPaid)} <small>USDC</small></dd></div>
          <div><dt>Remaining total limit</dt><dd>{usdc(remaining)} <small>USDC</small></dd></div>
        </dl>
        <p>{line.stateName === "CLOSED" ? "This line is closed and cannot fund another purchase. Open a new line if you want to provide another budget." : "Repay a purchase in full before the next one. Repayment restores reserve; it does not reset the total purchase limit."}</p>
        {line.stateName === "DEFAULTED" && <p className="fundingCallout">Repayment supports sponsor recovery. This defaulted line will not reopen. Recoverable funds: {usdc(line.availableReserve + line.recoveryAvailable)} USDC.</p>}
        {line.principalOutstanding > 0n && <p>Repayment due: <strong>{when(line.dueAt)}</strong>. The obligation remains if service delivery is unresolved.</p>}
        {line.expiry <= line.observedTimestamp && <p className="fundingCallout">The line has expired for new purchases. Existing debt and eligible reclaim remain.</p>}
        {(!line.sponsorAllowed || line.spendsPaused) && <p className="fundingCallout">New purchases are currently restricted. You can still repay and reclaim eligible funds.</p>}
        <div className="fundingActions">
          {repayable && <button className="fundingPrimary" type="button" disabled={!canWrite} onClick={() => void review("repay")}>Review full repayment</button>}
          {reclaimable && <button className="fundingPrimary" type="button" disabled={!canWrite} onClick={() => void review("reclaim")}>{line.stateName === "DEFAULTED" ? "Review recovery claim" : "Review close and reclaim"}</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => void lookup()}>Refresh line</button>
          {line.stateName === "OPEN" && line.principalOutstanding === 0n && !isSponsor && <small>Only the sponsor can close this line and reclaim its reserve.</small>}
        </div>
        <details><summary>Line details</summary>
          <dl className="fundingDetails"><div><dt>Line ID</dt><dd><code>{line.lineId}</code></dd></div><div><dt>Sponsor</dt><dd><code>{line.sponsor}</code></dd></div>
            <div><dt>Agent</dt><dd><code>{line.agent}</code></dd></div><div><dt>Expires</dt><dd>{when(line.expiry)}</dd></div>
            <div><dt>Line daily limit</dt><dd>{usdc(line.dailySpendCap)} USDC</dd></div><div><dt>Line epoch</dt><dd>{line.epoch.toString()}</dd></div></dl>
          <p>The agent signs a purchase and an executor submits it using the <a href="https://github.com/buildwithshadow/shadow/blob/main/docs/SHADOW_FLOAT_MAINNET_PARTICIPANT_TOOLS.md" target="_blank" rel="noreferrer">candidate participant tools</a>. This page manages funding, repayment and reclaim.</p>
        </details>
      </div>}
    </section>}

    <footer className="fundingFoot"><p>Candidate contract: <a href={`${explorer}/address/${CANDIDATE_FUNDING.address}`} target="_blank" rel="noreferrer">{compact(CANDIDATE_FUNDING.address)}</a> · Arc testnet</p>
      <p>Looking for the earlier integration? <Link to="/builders">Open Float V2 tools</Link>.</p></footer>

    <dialog ref={dialog} className="fundingDialog" role="alertdialog" aria-labelledby="funding-review-title" aria-describedby="funding-review-description"
      onCancel={(event) => { if (submitting.current) event.preventDefault(); else setPrepared(null); }}>
      {prepared && <><p className="pageEyebrow">Arc testnet · Wallet confirmation</p>
        <h2 id="funding-review-title">{prepared.kind === "approve" ? "Approve this USDC amount" : prepared.kind === "open" ? "Open this funding line" : prepared.kind === "repay" ? "Repay this amount" : "Reclaim eligible funds"}</h2>
        <p id="funding-review-description">{prepared.summary}</p>
        <dl className="fundingDetails"><div><dt>Wallet</dt><dd><code>{prepared.account}</code></dd></div>
          <div><dt>Amount</dt><dd>{usdc(prepared.amount)} test USDC</dd></div>
          <div><dt>Contract receiving the call</dt><dd><code>{prepared.to}</code></dd></div>
          {prepared.lineId && <div><dt>Line ID</dt><dd><code>{prepared.lineId}</code></dd></div>}
        </dl>
        {reviewInput && <dl className="fundingDetails"><div><dt>Agent</dt><dd><code>{reviewInput.agent}</code></dd></div><div><dt>Provider</dt><dd><code>{reviewInput.provider}</code></dd></div>
          <div><dt>Endpoint</dt><dd>{reviewInput.endpoint}</dd></div><div><dt>Total / daily / per purchase</dt><dd>{reviewInput.lineSpendCap} / {reviewInput.dailySpendCap} / {reviewInput.providerPerSpendCap} USDC</dd></div></dl>}
        <p>{prepared.kind === "approve" ? "This approval does not open a line or repay debt. You will review that transaction separately." : prepared.kind === "repay" ? "This is a fixed repayment amount. Keep this wallet prompt brief and close it if the line changes. Check confirmation before retrying." : prepared.kind === "open" ? "The sponsor bears repayment risk. A paid provider can leave debt outstanding even if delivery fails." : "Closing an open line ends its purchase access and returns eligible reserve to its sponsor."}</p>
        <div className="fundingActions"><button autoFocus type="button" onClick={() => setPrepared(null)} disabled={Boolean(busy)}>Back</button>
          <button className="fundingPrimary" type="button" onClick={() => void sendReviewed()} disabled={Boolean(busy)}>Confirm in wallet</button></div>
        {busy && <p role="status">{busy}</p>}
      </>}
    </dialog>
  </div>;
}
