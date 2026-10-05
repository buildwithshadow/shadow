import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { createPublicClient, createWalletClient, custom, formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";
import { createRpcReadTransport } from "../scripts/rpc-read-transport.mjs";
import {
  CANDIDATE_FUNDING as LEGACY_FUNDING, candidateErrorMessage, candidateFundingChain, candidateChainFor, createCandidateFundingKit, createGuardedMainnetFundingKit,
  type CandidateDeployment, type CandidateLine, type CandidateOpenInput, type CandidatePending, type CandidatePrepared,
  type CandidateResolution, type CandidateSnapshot,
} from "./candidateFunding";
import "./candidateFunding.css";
import { PublicPurchase, type PublicService } from "./PublicPurchase";
import { GatewayFunding } from "./GatewayFunding";
import { assertGatewayFundingResolved, assertCandidateFundingResolved, gatewayWalletLockKey } from "./gatewayFundingGuard";
import { CircleAgentHandoff } from "./CircleAgentHandoff";
import { findSentTransactionHash } from "./savedTransactionLookup";

const legacyClient = createPublicClient({ chain: candidateFundingChain, transport: createRpcReadTransport("https://rpc.testnet.arc.network", {
  timeout: 15_000, queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3_000 },
}) });
const initialForm: CandidateOpenInput = {
  agent: "", provider: "", endpoint: "", reserve: "0.10", lineSpendCap: "0.15", dailySpendCap: "0.10",
  providerPerSpendCap: "0.05", providerDailyCap: "0.10", expiryDays: "7", repaymentHours: "24",
};

const usdc = (value: bigint) => formatUnits(value, 6);
const compact = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const when = (value: bigint) => new Date(Number(value) * 1000).toLocaleString();
const messageOf = candidateErrorMessage;
type Provider = NonNullable<Window["ethereum"]> & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

function Field({ label, name, value, onChange, hint, error: fieldError, decimal = false, required = true, disabled = false }: {
  label: string; name: string; value: string; onChange: (value: string) => void; hint?: string; error?: string; decimal?: boolean; required?: boolean; disabled?: boolean;
}) {
  return <div className="fundingField">
    <label htmlFor={`funding-${name}`}>{label}</label>
    <input id={`funding-${name}`} name={name} value={value} onChange={(event) => onChange(event.target.value)}
      inputMode={decimal ? "decimal" : "text"} autoComplete="off" spellCheck={false} required={required} disabled={disabled}
      aria-invalid={fieldError ? true : undefined}
      aria-describedby={[hint && `funding-${name}-hint`, fieldError && `funding-${name}-error`].filter(Boolean).join(" ") || undefined} />
    {hint && <small id={`funding-${name}-hint`}>{hint}</small>}
    {fieldError && <small id={`funding-${name}-error`} role="alert">{fieldError}</small>}
  </div>;
}

export function CandidateFundingDesk({ deployment = LEGACY_FUNDING, service }: { deployment?: CandidateDeployment; service?: PublicService }) {
  const CANDIDATE_FUNDING = deployment;
  const mainnet = deployment.chainId === 5042;
  const chain = useMemo(() => candidateChainFor(deployment), [deployment]);
  const network = mainnet ? 'Arc mainnet' : 'Arc testnet';
  const explorer = chain.blockExplorers.default.url;
  const { createCandidateJournal, executeCandidateCall, prepareCandidateOpen, prepareCandidateReclaim, prepareCandidateRepay,
    readCandidateLine, readCandidateSnapshot, reconcileCandidatePending, prepareCandidateRegistration } = useMemo(() => (mainnet ? createGuardedMainnetFundingKit : createCandidateFundingKit)(deployment), [deployment, mainnet]);
  const client = useMemo(() => mainnet ? createPublicClient({ chain, transport: createRpcReadTransport('https://rpc.mainnet.arc.io', {
    timeout: 15_000, fallbackUrls: ['https://rpc.blockdaemon.mainnet.arc.io'], expectedChainId: 5042,
    queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3_000 },
  }) }) : deployment.selfRegistration ? createPublicClient({ chain: candidateFundingChain,
    transport: createRpcReadTransport("https://rpc.drpc.testnet.arc.io", { timeout: 15_000,
      fallbackUrls: ["https://rpc.blockdaemon.testnet.arc.io", "https://rpc.testnet.arc.network"], expectedChainId: deployment.chainId,
      queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3_000 } }) }) : legacyClient, [deployment, chain, mainnet]);
  const [mode, setMode] = useState<"open" | "manage">(() => new URLSearchParams(window.location.search).has("line") ? "manage" : "open");
  const [role, setRole] = useState<"sponsor" | "agent" | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return !service ? null : params.has("agent") ? "sponsor" : params.has("line") ? "agent" : null;
  });
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [form, setForm] = useState(() => ({ ...initialForm,
    agent: service ? new URLSearchParams(window.location.search).get("agent") || "" : "",
    ...(service ? { provider: service.provider, endpoint: service.endpoint } : {}),
    ...(mainnet ? { lineSpendCap: '0.005', dailySpendCap: '0.005', providerPerSpendCap: '0.005', providerDailyCap: '0.005' } : {}),
  }));
  const [providerAgreed, setProviderAgreed] = useState(false);
  const [snapshot, setSnapshot] = useState<CandidateSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  const [lineId, setLineId] = useState(() => new URLSearchParams(window.location.search).get("line") || "");
  const [lineInputError, setLineInputError] = useState("");
  const [line, setLine] = useState<CandidateLine | null>(null);
  const [pending, setPending] = useState<CandidatePending | null>(null);
  const [journalError, setJournalError] = useState("");
  const [gatewayHeld, setGatewayHeld] = useState(false);
  const gatewayEnabled = Boolean(!mainnet && service && import.meta.env.VITE_SHADOW_GATEWAY_TESTNET === "true");
  const [recoveryHash, setRecoveryHash] = useState("");
  const [prepared, setPrepared] = useState<CandidatePrepared | null>(null);
  const [reviewInput, setReviewInput] = useState<CandidateOpenInput | null>(null);
  const [resolution, setResolution] = useState<CandidateResolution | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  const activeAccount = useRef<Address | null>(null);
  const walletReadSequence = useRef(0);
  const submitting = useRef(false);
  const autoChecked = useRef("");
  const correctNetwork = chainId === CANDIDATE_FUNDING.chainId;
  const canWrite = Boolean(account && correctNetwork && !busy && !pending && !journalError && !gatewayHeld);

  function invalidate() {
    revision.current += 1;
    setPrepared(null);
    setReviewInput(null);
    setResolution(null);
    setNotice("");
  }
  function updateLineId(value: string) {
    invalidate();
    setLine(null);
    setLineInputError("");
    setLineId(value);
  }
  function updateForm(key: keyof CandidateOpenInput, value: string) {
    invalidate();
    if (key === "provider" || key === "endpoint") setProviderAgreed(false);
    setForm((previous) => ({ ...previous, [key]: value }));
  }
  function loadJournal(forAccount: Address) {
    if (activeAccount.current !== forAccount) return;
    try {
      const saved = createCandidateJournal(window.localStorage, forAccount).load();
      setPending(saved);
      if (!saved) setRecoveryHash("");
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
    setSnapshotError("");
    setPending(null);
    setRecoveryHash("");
    setJournalError("");
    if (!account) return;
    let active = true;
    loadJournal(account);
    const changed = () => loadJournal(account);
    window.addEventListener("storage", changed);
    readCandidateSnapshot(client, { sponsor: account }).then((value) => { if (active) setSnapshot(value); })
      .catch((cause) => { if (active) setSnapshotError(`Could not read your sponsor status. ${messageOf(cause)} Reload the page to try again.`); });
    return () => { active = false; window.removeEventListener("storage", changed); };
  }, [account]);

  useEffect(() => {
    if (prepared && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!prepared && dialog.current?.open) dialog.current.close();
  }, [prepared]);

  useEffect(() => {
    if (error) feedback.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  // Check a saved transaction once when it appears. recover() only reads and reconciles; it never resends.
  useEffect(() => {
    if (!pending || busy) return;
    const key = `${pending.account}:${pending.nonce}`;
    if (autoChecked.current === key) return;
    autoChecked.current = key;
    void recover();
  }, [pending, busy]);

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
    setBusy(`Switching to ${network}…`);
    try {
      if (!window.ethereum) throw new Error("Connect your browser wallet first.");
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${CANDIDATE_FUNDING.chainId.toString(16)}` }] });
      } catch (cause) {
        if ((cause as { code?: number }).code !== 4902) throw cause;
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
          chainId: `0x${CANDIDATE_FUNDING.chainId.toString(16)}`, chainName: chain.name,
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [...chain.rpcUrls.default.http], blockExplorerUrls: [explorer],
        }] });
      }
      invalidate();
      setChainId(Number(await window.ethereum.request({ method: "eth_chainId" })));
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(""); }
  }

  async function review(action: "register" | "open" | "repay" | "reclaim", event?: FormEvent) {
    event?.preventDefault();
    if (!account || !canWrite) return;
    if (action === "open" && !providerAgreed) { setError("Confirm the provider accepts Shadow payments for this endpoint before funding it."); return; }
    const currentRevision = revision.current;
    setError(""); setNotice(""); setResolution(null); setBusy("Checking current limits and preparing your review…");
    try {
      if (action !== "open" && action !== "register" && !line) throw new Error("Load the funding line before reviewing an action.");
      const value = action === "register" ? await prepareCandidateRegistration(client, account) : action === "open" ? await prepareCandidateOpen(client, account, form)
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
    id = id.trim();
    invalidate(); setError(""); setLine(null); setLineInputError("");
    if (!/^0x[0-9a-fA-F]{64}$/.test(id) || /^0x0{64}$/.test(id)) {
      setLineInputError("Enter the full funding line ID from your opening receipt: 0x followed by 64 hexadecimal characters.");
      return;
    }
    setBusy("Reading the funding line…");
    const currentRevision = revision.current;
    try {
      const value = await readCandidateLine(client, id);
      if (revision.current === currentRevision) setLine(value);
    }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(""); }
  }

  // Capture the view that launched the purchase; a late response must not
  // replace a different line or an account/network selection made meanwhile.
  const purchaseViewRevision = revision.current;
  async function refreshPurchaseLine(id: string, transactionHash?: Hex) {
    const isCurrent = () => revision.current === purchaseViewRevision &&
      (!lineId.trim() || lineId.trim().toLowerCase() === id.trim().toLowerCase());
    if (!isCurrent()) return;
    setLineId(id);
    setLine(null);
    setError("");
    setBusy(transactionHash ? "Waiting for purchase confirmation and updating the balance…" : "Updating the funding line balance…");
    try {
      if (transactionHash) {
        await client.waitForTransactionReceipt({ hash: transactionHash, timeout: 45_000 });
        if (!isCurrent()) return;
      }
      const value = await readCandidateLine(client, id);
      if (isCurrent()) { setLineId(id); setLine(value); setMode("manage"); }
    } catch (cause) {
      if (isCurrent()) setError(`Could not confirm the latest line balance. Use “Check payment & recover result” when your connection recovers; do not submit another purchase. ${messageOf(cause)}`);
    }
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
      await navigator.locks.request(gatewayWalletLockKey(account, deployment.chainId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("Another Shadow tab is handling this wallet. Finish that transaction there first.");
        if (!mainnet) assertGatewayFundingResolved(sender);
        assertCandidateFundingResolved(sender, window.localStorage, deployment.chainId);
        const result = await executeCandidateCall({
          publicClient: client,
          walletClient: createWalletClient({ chain, transport: custom(window.ethereum!), account: sender }),
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
    setError(""); setNotice(""); setBusy("Checking the recorded transaction…");
    try {
      if (!navigator.locks) throw new Error("Use a current browser over HTTPS to check transaction recovery.");
      const journal = createCandidateJournal(window.localStorage, account);
      await navigator.locks.request(gatewayWalletLockKey(account, deployment.chainId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("A wallet request is still open in another Shadow tab. Finish it there first.");
        const saved = journal.load();
        if (!saved) { if (isCurrent()) { setPending(null); setRecoveryHash(""); } return; }
        // With no hash saved or entered, look up the transaction that used the saved nonce. A failed
        // lookup leaves the hash field as the way to resolve it.
        const typed = recoveryHash.trim();
        let lookupFailed = false;
        const found = (typed || saved.txHash) ? undefined : await findSentTransactionHash({
          chainId: saved.chainId, account: saved.account, nonce: saved.nonce,
          readNextNonce: () => client.getTransactionCount({ address: saved.account, blockTag: "latest" }),
        }).then((hash) => hash ?? undefined, () => { lookupFailed = true; return undefined; });
        const result = await reconcileCandidatePending(client, saved, typed || found);
        if (result.status === "confirmed") result.message = `Earlier transaction: ${result.message} No new transaction was sent during recovery.`;
        // A found hash that belongs to a different transaction could mean the wallet sent this action
        // with another nonce, so only the person, after checking the wallet, may clear it as replaced.
        const foundOther = found !== undefined && result.status === "replaced";
        if (result.status !== "unknown" && !foundOther) journal.clear();
        if (!isCurrent()) return;
        if (foundOther) setRecoveryHash(found);
        if (lookupFailed) setNotice("The automatic lookup failed. Paste the transaction hash from your wallet instead.");
        setResolution(foundOther ? { status: "unknown", txHash: found, message: "Another transaction used this wallet’s saved nonce. Check your wallet activity for this Shadow action before continuing. If it was never sent, choose Check confirmation to clear this record with the hash filled in." } : result);
        loadJournal(account);
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
  const shareable = Boolean(service && line && isSponsor && line.stateName === "OPEN" && line.expiry > line.observedTimestamp &&
    line.sponsorAllowed && !line.spendsPaused);
  const openBlocker = !account ? "Connect your wallet to review and fund." : !correctNetwork ? `Switch to ${network} to continue.`
    : gatewayHeld ? "Resolve Gateway funding above before opening a line." : pending ? "Check the previous transaction above before funding." : journalError ? "Transaction recovery is unavailable in this browser. See the message above."
    : snapshot?.openingsPaused ? "New lines are currently paused."
    : snapshot?.sponsorAllowed === false ? (deployment.selfRegistration ? "Register this wallet above before funding." : "This wallet is not approved as a sponsor yet.")
    : !providerAgreed ? "Confirm the provider agreement above to continue." : null;
  const lineBlocker = !account ? "Connect your wallet to repay." : !correctNetwork ? `Switch to ${network} to continue.`
    : gatewayHeld ? "Resolve Gateway funding above before continuing." : pending ? "Check the previous transaction above before continuing." : journalError ? "Transaction recovery is unavailable in this browser. See the message above." : null;

  return <div className="routePage fundingDesk">
    <header className="fundingHead">
      <div><p className="pageEyebrow">{mainnet ? "Arc mainnet · Controlled participant candidate" : service ? "Arc testnet · Agent funding" : "Arc testnet · Earlier candidate"}</p>
        <h1>{service ? <>Fund an agent.<br />Keep the limits.</> : "Earlier candidate"}</h1>
        <p>{service ? "Set aside USDC for an agent’s purchases. Track what it owes and reclaim eligible funds from your own wallet." : <>Shadow’s earlier testnet contract. Approved sponsors can open lines here and manage existing ones. To fund an agent without operator approval and buy a service, use <Link to="/start">Fund an agent</Link>.</>}</p>
      </div>
      <div className="fundingWallet">
        <span>{account ? "Connected browser wallet" : "Your wallet stays in control"}</span>
        {account && <code title={account}>{compact(account)}</code>}
        <button type="button" onClick={connect} disabled={Boolean(busy)}>{account ? "Refresh wallet" : "Connect wallet"}</button>
        {account && !correctNetwork && <button type="button" onClick={switchNetwork} disabled={Boolean(busy)}>Switch to {network}</button>}
        {account && correctNetwork && <small>{network} connected</small>}
      </div>
    </header>

    <p className="fundingScope">{mainnet ? "Real USDC on Arc mainnet. This controlled candidate is limited to admitted sponsors, 0.10 USDC reserve and 0.005 USDC total purchases per line. Funding and purchases may be paused; repayment and eligible reclaim remain available." : service ? "Use test USDC to fund an agent and buy a service. Register and approve your own budget from a browser wallet; no operator enrollment is needed. Testnet gas is paid by each wallet." : "Test USDC only. Approved sponsors can fund lines here. Circle smart wallets can be the agent; funding and repayment here use a browser wallet."}</p>
    {service && !mainnet && <p className="fundingScope">Need test USDC? <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Open Circle’s faucet</a> and choose Arc testnet. The sponsor needs funds for its budget and gas; the agent needs gas to submit a purchase. Repayment needs separate test USDC from the repaying wallet—the line’s reserve cannot repay its own debt.</p>}
    {service && <div className="fundingModes" role="group" aria-labelledby="funding-role-title">
      <span id="funding-role-title">Which are you?</span>
      <button type="button" aria-pressed={role === "sponsor"} onClick={() => setRole(role === "sponsor" ? null : "sponsor")} disabled={Boolean(busy)}>I am sponsoring</button>
      <button type="button" aria-pressed={role === "agent"} onClick={() => { if (role === "agent") setRole(null); else { invalidate(); setMode("manage"); setRole("agent"); } }} disabled={Boolean(busy)}>I am the agent</button>
    </div>}
    {service && account && <section className="fundingPanel" aria-labelledby="agent-invite-title" hidden={role === "sponsor"}>
      <h2 id="agent-invite-title">Ask a sponsor to fund your agent</h2>
      <p>Share this link with your sponsor. It includes your connected wallet as the agent; they review the address and choose the budget themselves.</p>
      <div className="fundingField"><label htmlFor="agent-funding-link">Your agent funding link</label><input id="agent-funding-link" readOnly value={`${window.location.origin}${window.location.pathname}?agent=${account}`} /></div>
      <button type="button" disabled={Boolean(busy)} onClick={() => { invalidate(); setForm(previous => ({ ...previous, agent: account })); setMode("open"); setRole(null); }}>Use my wallet as the agent</button>
    </section>}
    <div className="fundingModes" aria-label="Funding actions" hidden={role === "agent"}>
      <button type="button" aria-pressed={mode === "open"} onClick={() => { invalidate(); setMode("open"); }} disabled={Boolean(busy)}>Open a funding line</button>
      <button type="button" aria-pressed={mode === "manage"} onClick={() => { invalidate(); setMode("manage"); }} disabled={Boolean(busy)}>Manage a line</button>
    </div>

    <div className="fundingFeedback" ref={feedback} aria-live="polite" aria-atomic="true">
      {busy && <p role="status">{busy}</p>}
      {error && <p className="fundingError" role="alert">{error}</p>}
      {journalError && <p className="fundingError" role="alert">{journalError} New transactions are disabled until recovery is available.</p>}
      {notice && <p>{notice}</p>}
      {resolution && <p className={resolution.status === "confirmed" ? "fundingSuccess" : ""}>
        {resolution.message} {resolution.txHash && <a href={`${explorer}/tx/${resolution.txHash}`} target="_blank" rel="noreferrer">View transaction</a>}
      </p>}
    </div>
    {snapshotError && !snapshot && <p className="fundingCallout" role="alert">{snapshotError}</p>}

    {pending && <section className="fundingRecovery" aria-labelledby="funding-recovery-title">
      <h2 id="funding-recovery-title">Check the previous transaction first</h2>
      <p>A {pending.kind === "register" ? "sponsor registration" : pending.kind === "approve" ? "USDC approval" : pending.kind === "open" ? "line opening" : pending.kind === "repay" ? "repayment" : "reclaim"} has not been resolved. New transactions from this wallet are paused here so a retry cannot accidentally send it again.</p>
      <p>Finish any open wallet prompt. Then check its status. Keep this browser’s site data until it is resolved.</p>
      {pending.txHash && <a href={`${explorer}/tx/${pending.txHash}`} target="_blank" rel="noreferrer">Open the saved transaction</a>}
      <Field name="recovery-hash" label="Transaction hash from your wallet (optional)" value={recoveryHash} onChange={setRecoveryHash} required={false} disabled={Boolean(busy)}
        hint="Leave this empty to check the saved wallet transaction or look it up. You can also paste its original hash. A replacement is accepted only when it is tied to the original transaction; an unrelated payment cannot clear this check." />
      <button type="button" onClick={recover} disabled={Boolean(busy)}>Check confirmation</button>
      <details><summary>No transaction hash in your wallet?</summary>
        <p>A missing hash does not prove the request was cancelled. Your wallet may have changed the proposed nonce. Check its activity for the original request and copy that transaction’s hash here. If the wallet cannot identify it, keep this record and ask for help before sending again.</p>
        <dl className="fundingDetails"><div><dt>Account</dt><dd><code>{pending.account}</code></dd></div><div><dt>Saved transaction nonce</dt><dd>{pending.nonce}</dd></div></dl>
      </details>
    </section>}

    {gatewayEnabled && <div className="fundingSlot" hidden={role === "agent" && !gatewayHeld}><GatewayFunding account={account} correctNetwork={correctNetwork} deployment={deployment}
      reserve={form.reserve} busy={busy} setBusy={setBusy} onHold={setGatewayHeld} onReady={() => {
        const sponsor = account;
        if (sponsor) void readCandidateSnapshot(client, {sponsor}).then(value => { if (activeAccount.current === sponsor) setSnapshot(value); }).catch(cause => setSnapshotError(messageOf(cause)));
      }} /></div>}

    {mode === "open" ? <form className="fundingPanel" onSubmit={(event) => void review("open", event)}>
      <div className="fundingPanelHead"><div><h2>Set the purchase budget</h2><p>One agent, one approved provider, one outstanding purchase at a time.</p></div>
        {snapshot && <span className="fundingBalance">{usdc(snapshot.balance)} USDC available</span>}
      </div>
      {snapshot && !snapshot.sponsorAllowed && <p className="fundingCallout">{deployment.selfRegistration ? <>Register this wallet before funding. No token approval or transfer is included. <button type="button" disabled={!canWrite || snapshot.openingsPaused} onClick={() => void review("register")}>Review sponsor registration</button></> : "This wallet is not approved as a sponsor yet. Ask the Shadow operator to approve its public address. You can still inspect a line under “Manage a line.”"}</p>}
      {snapshot?.openingsPaused && <p className="fundingCallout">New lines are currently paused. Existing repayment and eligible reclaim remain available.</p>}
      <fieldset disabled={Boolean(busy)}><legend>Who will use the budget?</legend><div className="fundingGrid">
        <Field name="agent" label="Agent wallet address" value={form.agent} onChange={(value) => updateForm("agent", value)} hint={service ? "The wallet from your agent’s invitation, or use your own wallet to try the full flow." : "The wallet that will sign each purchase. A deployed Circle Modular Wallet is supported as the agent."} />
        <Field name="provider" label="Provider payment address" value={form.provider} onChange={(value) => updateForm("provider", value)} disabled={Boolean(service)} hint="Confirm this destination with the provider before funding." />
        <div className="fundingWide"><Field name="endpoint" label="Agreed service endpoint" value={form.endpoint} onChange={(value) => updateForm("endpoint", value)} disabled={Boolean(service)} hint="Paste the exact HTTPS endpoint agreed with the provider. Shadow binds purchases to this text; this form does not contact the endpoint." /></div>
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
        <span>I accept that spent funds are unsecured credit to the agent operator: Shadow cannot enforce repayment or guarantee delivery, and unpaid spent principal cannot be reclaimed. Other sponsors may separately fund the same agent.</span></label>
      <div className="fundingActions"><button className="fundingPrimary" type="submit" disabled={Boolean(busy) || openBlocker !== null} aria-describedby="funding-open-hint">Review funding line</button>
        <small id="funding-open-hint">{openBlocker ?? (!snapshot && !snapshotError ? "Checking this wallet’s sponsor status…" : "Review first. Any USDC approval and funding transaction need separate wallet confirmations.")}</small></div>
    </form> : <section className="fundingPanel" aria-labelledby="funding-manage-title">
      <div className="fundingPanelHead"><div><h2 id="funding-manage-title">Find your funding line</h2><p>Read its balance without connecting a wallet. Connect to repay or reclaim.</p></div></div>
      <form className="fundingLookup" onSubmit={(event) => void lookup(event)}>
        <Field name="line" label="Funding line ID" value={lineId} error={lineInputError} onChange={updateLineId} disabled={Boolean(busy)} hint="The 0x identifier from your line-opening receipt." />
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
        {shareable &&
          <div className="fundingField"><label htmlFor="line-share-link">Send this link to your agent</label>
          <input id="line-share-link" readOnly aria-describedby="line-share-link-hint" value={`${window.location.origin}${window.location.pathname}?line=${line.lineId}`} />
          <small id="line-share-link-hint">It opens this page with the line filled in. The agent’s page checks the line again before any payment is sent.</small></div>}
        <div className="fundingActions">
          {repayable && <button className="fundingPrimary" type="button" disabled={!canWrite} aria-describedby={lineBlocker ? "funding-line-action-hint" : undefined} onClick={() => void review("repay")}>Review full repayment</button>}
          {reclaimable && <button className="fundingPrimary" type="button" disabled={!canWrite} aria-describedby={lineBlocker ? "funding-line-action-hint" : undefined} onClick={() => void review("reclaim")}>{line.stateName === "DEFAULTED" ? "Review recovery claim" : "Review close and reclaim"}</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => void lookup()}>Refresh line</button>
          {line.stateName === "OPEN" && line.principalOutstanding === 0n && !isSponsor && <small>Only the sponsor can close this line and reclaim its reserve.</small>}
          {(repayable || reclaimable) && lineBlocker && <small id="funding-line-action-hint">{lineBlocker}</small>}
        </div>
        <details><summary>Line details</summary>
          <dl className="fundingDetails"><div><dt>Line ID</dt><dd><code>{line.lineId}</code></dd></div><div><dt>Sponsor</dt><dd><code>{line.sponsor}</code></dd></div>
            <div><dt>Agent</dt><dd><code>{line.agent}</code></dd></div><div><dt>Expires</dt><dd>{when(line.expiry)}</dd></div>
            <div><dt>Line daily limit</dt><dd>{usdc(line.dailySpendCap)} USDC</dd></div><div><dt>Line epoch</dt><dd>{line.epoch.toString()}</dd></div></dl>
          <p>{service ? "The agent buys the service below, signing with its own wallet; this line pays the price. This section manages funding, repayment and reclaim." : <>The agent signs a purchase and an executor submits it using the <a href="https://github.com/buildwithshadow/shadow/blob/main/docs/SHADOW_FLOAT_MAINNET_PARTICIPANT_TOOLS.md" target="_blank" rel="noreferrer">candidate participant tools</a>. This page manages funding, repayment and reclaim.</>}</p>
        </details>
        {service && !mainnet && <CircleAgentHandoff key={line.lineId} lineId={line.lineId} agent={line.agent} />}
      </div>}
    </section>}

    {service && <div className="fundingSlot" hidden={role === "sponsor"}><PublicPurchase account={account} correctNetwork={correctNetwork} deployment={deployment} service={service}
      client={client} busy={busy} setBusy={setBusy} fundingPending={Boolean(pending || journalError || gatewayHeld)} onPurchaseChanged={refreshPurchaseLine} lineId={lineId} onLineIdChange={updateLineId} /></div>}
    <footer className="fundingFoot">{service && !mainnet && <p><Link to="/funding">Manage a line on the earlier candidate</Link></p>}<p>Candidate contract: <a href={`${explorer}/address/${CANDIDATE_FUNDING.address}`} target="_blank" rel="noreferrer">{compact(CANDIDATE_FUNDING.address)}</a> · {network}</p>
      <p>Looking for the earlier integration? <Link to="/builders">Open Float V2 tools</Link>.</p></footer>

    <dialog ref={dialog} className="fundingDialog" role="alertdialog" aria-labelledby="funding-review-title" aria-describedby="funding-review-description"
      onCancel={(event) => { if (submitting.current) event.preventDefault(); else setPrepared(null); }}>
      {prepared && <><p className="pageEyebrow">{network} · Wallet confirmation</p>
        <h2 id="funding-review-title">{prepared.kind === "register" ? "Register your sponsor wallet" : prepared.kind === "approve" ? "Approve this USDC amount" : prepared.kind === "open" ? "Open this funding line" : prepared.kind === "repay" ? "Repay this amount" : "Reclaim eligible funds"}</h2>
        <p id="funding-review-description">{prepared.summary}</p>
        <dl className="fundingDetails"><div><dt>Wallet</dt><dd><code>{prepared.account}</code></dd></div>
          <div><dt>Amount</dt><dd>{usdc(prepared.amount)} {mainnet ? 'USDC' : 'test USDC'}</dd></div>
          <div><dt>Contract receiving the call</dt><dd><code>{prepared.to}</code></dd></div>
          {prepared.lineId && <div><dt>Line ID</dt><dd><code>{prepared.lineId}</code></dd></div>}
        </dl>
        {reviewInput && <dl className="fundingDetails"><div><dt>Agent</dt><dd><code>{reviewInput.agent}</code></dd></div><div><dt>Provider</dt><dd><code>{reviewInput.provider}</code></dd></div>
          <div><dt>Endpoint</dt><dd>{reviewInput.endpoint}</dd></div><div><dt>Total / daily / per purchase</dt><dd>{reviewInput.lineSpendCap} / {reviewInput.dailySpendCap} / {reviewInput.providerPerSpendCap} USDC</dd></div></dl>}
        <p>{prepared.kind === "register" ? "Registration enables funding from this wallet only. Your tokens remain in your wallet." : prepared.kind === "approve" ? "This approval does not open a line or repay debt. You will review that transaction separately." : prepared.kind === "repay" ? "Review the repayment scope above. Legacy lines pay current debt at execution and can settle a newer purchase if approval is delayed; guarded lines reject a different purchase. Check confirmation before retrying." : prepared.kind === "open" ? "The sponsor bears repayment risk. A paid provider can leave debt outstanding even if delivery fails." : "Closing an open line ends its purchase access and returns eligible reserve to its sponsor."}</p>
        <p>Finish other transactions from this account first. If you submit one elsewhere while this wallet prompt is open, cancel this request and review it again. Shadow cannot reserve a wallet nonce across other apps or devices.</p>
        <div className="fundingActions"><button autoFocus type="button" onClick={() => setPrepared(null)} disabled={Boolean(busy)}>Back</button>
          <button className="fundingPrimary" type="button" onClick={() => void sendReviewed()} disabled={Boolean(busy)}>Confirm in wallet</button></div>
        {busy && <p role="status">{busy}</p>}
      </>}
    </dialog>
  </div>;
}
