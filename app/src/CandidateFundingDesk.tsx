import { ARC_TESTNET_RPC_URL } from "../arcTestnetNetwork.mjs";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { FundingJourney } from "./FundingJourneyLayout";
import { fundingStep, guardedFundingStep, validAgent, budgetIssue, restoreWalletDraft, writeFundingDraft, fundingPath, type FundingStep } from "./fundingJourney";
import { createPublicClient, createWalletClient, custom, formatUnits, getAddress, isAddress, type Address, type Hash, type Hex } from "viem";
import { createRpcReadTransport } from "../scripts/rpc-read-transport.mjs";
import {
  CANDIDATE_FUNDING as LEGACY_FUNDING, candidateErrorMessage, candidateFundingChain, candidateChainFor, createCandidateFundingKit, createGuardedMainnetFundingKit,
  type CandidateDeployment, type CandidateLine, type CandidateOpenInput, type CandidatePending, type CandidatePrepared,
  type CandidateResolution, type CandidateSnapshot,
} from "./candidateFunding";
import "./candidateFunding.css";
import { PublicPurchase, type PublicService } from "./PublicPurchase";
import { GatewayFunding } from "./GatewayFunding";
import { assertGatewayFundingResolved, assertCandidateFundingResolved, assertPurchaseResolved, gatewayWalletLockKey } from "./gatewayFundingGuard";
import { CircleAgentHandoff } from "./CircleAgentHandoff";
import { findSentTransactionHash } from "./savedTransactionLookup";
import { startLineRefresh } from "./lineRefresh";
import publicTestnetManifest from "../../contracts/deployments/public-testnet/arc-testnet.manifest.json" with { type: "json" };
import { discoverAgentLineIds, MAX_AGENT_LINE_DISCOVERY_RESULTS, type AgentLineDiscoveryProgress } from "./agentLineDiscovery";
import { getAgentLineDiscoveryContinuationCursor, hasResumableDiscoveryProgress, mergeAgentLineDiscoveryCache, refreshAgentLineDiscoveryCachePage, type AgentLineDiscoveryCache } from "./agentLineDiscoveryCache";
import { ensureWalletChain, walletRequestHelp } from "./walletNetwork";

const legacyClient = createPublicClient({ chain: candidateFundingChain, transport: createRpcReadTransport(ARC_TESTNET_RPC_URL, {
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
  const location = useLocation();
  const navigate = useNavigate();
  const guided = Boolean(service && deployment.selfRegistration);
  const requestedStep = fundingStep(location.pathname, location.search);
  const CANDIDATE_FUNDING = deployment;
  const mainnet = deployment.chainId === 5042;
  const guardedTestnet = !mainnet && deployment.drawBoundRepayment === true;
  const chain = useMemo(() => candidateChainFor(deployment), [deployment]);
  const network = mainnet ? 'Arc mainnet' : 'Arc testnet';
  const explorer = chain.blockExplorers.default.url;
  const { createCandidateJournal, executeCandidateCall, prepareCandidateOpen, prepareCandidateReclaim, prepareCandidateRepay, prepareCandidateDefault,
    readCandidateLine, readCandidateSnapshot, reconcileCandidatePending, prepareCandidateRegistration } = useMemo(() => (mainnet ? createGuardedMainnetFundingKit : createCandidateFundingKit)(deployment), [deployment, mainnet]);
  const client = useMemo(() => mainnet ? createPublicClient({ chain, transport: createRpcReadTransport(chain.rpcUrls.default.http[0], {
    timeout: 15_000, fallbackUrls: chain.rpcUrls.default.http.slice(1), expectedChainId: 5042,
    queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3_000 },
  }) }) : guardedTestnet ? createPublicClient({ chain, transport: createRpcReadTransport('https://rpc.quicknode.testnet.arc.io', {
    timeout: 15_000, fallbackUrls: ['https://rpc.drpc.testnet.arc.io', ARC_TESTNET_RPC_URL], expectedChainId: deployment.chainId,
    queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3_000 },
  }) }) : deployment.selfRegistration ? createPublicClient({ chain: candidateFundingChain,
    transport: createRpcReadTransport("https://rpc.drpc.testnet.arc.io", { timeout: 15_000,
      fallbackUrls: ["https://rpc.blockdaemon.testnet.arc.io", ARC_TESTNET_RPC_URL], expectedChainId: deployment.chainId,
      queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3_000 } }) }) : legacyClient, [deployment, chain, mainnet, guardedTestnet]);
  const publicTestnetDeployment = getAddress(deployment.address) === getAddress(publicTestnetManifest.contract.address);
  const [mode, setMode] = useState<"open" | "manage">(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has("line") || (service && !params.has("agent") && params.get("role") === "agent") ? "manage" : "open";
  });
  const [role, setRole] = useState<"sponsor" | "agent" | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return !service ? null : params.has("agent") ? "sponsor" : params.has("line") ? "agent"
      : params.get("role") === "agent" ? "agent" : params.get("role") === "sponsor" ? "sponsor" : null;
  });
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [form, setForm] = useState(() => ({ ...initialForm,
    agent: service ? new URLSearchParams(window.location.search).get("agent") || "" : "",
    ...(service ? { provider: service.provider, endpoint: service.endpoint } : {}),
    ...(mainnet || guardedTestnet ? { lineSpendCap: '0.005', dailySpendCap: '0.005', providerPerSpendCap: '0.005', providerDailyCap: '0.005' } : {}),
  }));
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const [draftWarning, setDraftWarning] = useState("");
  const [providerAgreed, setProviderAgreed] = useState(false);
  const [snapshot, setSnapshot] = useState<CandidateSnapshot | null>(null);
  const [walletSnapshotRevision, setWalletSnapshotRevision] = useState(0);
  const [snapshotError, setSnapshotError] = useState("");
  const [lineId, setLineId] = useState(() => new URLSearchParams(window.location.search).get("line") || "");
  const [lineInputError, setLineInputError] = useState("");
  const [line, setLine] = useState<CandidateLine | null>(null);
  const [discoveredLines, setDiscoveredLines] = useState<CandidateLine[]>([]);
  const [lineDiscoveryStatus, setLineDiscoveryStatus] = useState<"idle" | "loading" | "ready" | "empty" | "partial" | "failed">("idle");
  const [lineDiscoveryProgress, setLineDiscoveryProgress] = useState<AgentLineDiscoveryProgress | null>(null);
  const [lineDiscoveryLoadingStates, setLineDiscoveryLoadingStates] = useState(false);
  const [lineDiscoveryAction, setLineDiscoveryAction] = useState<"initial" | "continue" | "again">("initial");
  const [lineRefreshError, setLineRefreshError] = useState("");
  const [lineLoading, setLineLoading] = useState(false);
  const [pending, setPending] = useState<CandidatePending | null>(null);
  const [journalError, setJournalError] = useState("");
  const [gatewayHeld, setGatewayHeld] = useState(false);
  const gatewayEnabled = Boolean(!mainnet && !guardedTestnet && service && import.meta.env.VITE_SHADOW_GATEWAY_TESTNET === "true");
  const [recoveryHash, setRecoveryHash] = useState("");
  const [prepared, setPrepared] = useState<CandidatePrepared | null>(null);
  const [reviewInput, setReviewInput] = useState<CandidateOpenInput | null>(null);
  const [resolution, setResolution] = useState<CandidateResolution | null>(null);
  const [busy, setBusy] = useState("");
  const [unresolvedPurchase, setUnresolvedPurchase] = useState(false);
  const [focusPurchase, setFocusPurchase] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const showAgentLineDiscovery = Boolean(service && publicTestnetDeployment && (role === "agent" || guided && (requestedStep === "line" || requestedStep === "purchase")) && mode === "manage" && account
    && !busy && !lineId.trim() && !pending && !journalError && !gatewayHeld && !unresolvedPurchase);
  const discoveryClient = useMemo(() => showAgentLineDiscovery ? createPublicClient({ chain: candidateFundingChain,
    transport: createRpcReadTransport("https://rpc.blockdaemon.testnet.arc.io", { timeout: 15_000,
      fallbackUrls: [ARC_TESTNET_RPC_URL], expectedChainId: Number(publicTestnetManifest.chainId),
      queueOptions: { maxAttempts: 3, spacingMs: 150, baseDelayMs: 750, maxDelayMs: 3_000 } }) }) : null, [showAgentLineDiscovery]);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTitle = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const purchaseSlot = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  const activeAccount = useRef<Address | null>(null);
  const discoveredLinesByAccount = useRef(new Map<string, AgentLineDiscoveryCache>());
  const lineDiscoveryRun = useRef(0);
  const lineDiscoveryStoppedRun = useRef<number | null>(null);
  const lineDiscoveryActive = useRef(false);
  const keepSelectedLineInputEnabled = useRef(false);
  const focusLoadedLineHeading = useRef(false);
  const selectedPurchaseFocus = useRef<{ revision: number; routeKey: string; lineId: string } | null>(null);
  const walletReadSequence = useRef(0);
  const submitting = useRef(false);
  const autoChecked = useRef("");
  const previousRoute = useRef(location.key);
  const autoLoadedLink = useRef("");
  const correctNetwork = chainId === CANDIDATE_FUNDING.chainId;
  const canWrite = Boolean(account && correctNetwork && !busy && !pending && !journalError && !gatewayHeld);
  const lineDiscoveryContext = useRef({ account, role, mode, lineId, pending, journalError, gatewayHeld, unresolvedPurchase, showAgentLineDiscovery });
  lineDiscoveryContext.current = { account, role, mode, lineId, pending, journalError, gatewayHeld, unresolvedPurchase, showAgentLineDiscovery };
  const snapshotCurrent = Boolean(account && snapshot?.sponsor.toLowerCase() === account.toLowerCase());
  const journeyStep = guardedFundingStep(requestedStep, { connected: Boolean(account), correctNetwork, registered: snapshotCurrent && snapshot!.sponsorAllowed, agent: form.agent });
  const draftKey = account ? `shadow:funding-draft:${deployment.chainId}:${deployment.address.toLowerCase()}:${account.toLowerCase()}` : null;
  const journeyLocked = Boolean(busy || pending || journalError || gatewayHeld || unresolvedPurchase);
  const journeyTitle = { home: "Give your agent room to work.", wallet: "Connect your funding wallet.", register: "Set up your sponsor wallet.", agent: "Who are you funding?", budget: "Set a budget. Keep control.", fund: "Review before you fund.", line: "Your funding line.", purchase: "Put the budget to work." }[journeyStep];
  const journeyDescription = { home: "Provide a USDC budget for an agent, or use a line someone has funded for you.", wallet: "This wallet provides the budget and receives any eligible funds you reclaim.", register: "Register once on Arc testnet. You stay in control of what you fund.", agent: "Choose the wallet that will sign purchases and owe repayment.", budget: "Decide how much the agent can spend and when purchases must be repaid.", fund: "Check the agent, service and repayment terms. Every transaction needs your approval.", line: "See what is available, what is owed and what you can reclaim.", purchase: "Use an existing funding line to buy the approved service." }[journeyStep];
  function goJourney(next: FundingStep) {
    if (busy || prepared) return;
    invalidate(); setError("");
    setMode(next === 'line' || next === 'purchase' ? 'manage' : 'open');
    setRole(next === 'purchase' ? 'agent' : next === 'line' ? null : 'sponsor');
    navigate(fundingPath(next, form.agent, lineId));
  }
  useEffect(() => {
    if (!guided || !draftKey) return;
    setProviderAgreed(false);
    const restored = restoreWalletDraft(() => window.sessionStorage.getItem(draftKey), { ...initialForm, provider: service!.provider, endpoint: service!.endpoint }, new URLSearchParams(window.location.search).get('agent'));
    setForm(restored.form);
    setDraftOwner(restored.persisted ? draftKey : null);
    setDraftWarning(restored.persisted ? "" : "This browser cannot save your draft. Keep this page open until you finish.");
  }, [guided, draftKey, service]);
  useEffect(() => {
    if (!guided || !draftKey || draftOwner !== draftKey) return;
    try { window.sessionStorage.setItem(draftKey, writeFundingDraft(form)); }
    catch { setDraftWarning("Your latest edits could not be saved. Keep this page open until you finish."); }
  }, [guided, draftKey, draftOwner, form]);
  useEffect(() => {
    if (!guided) return;
    if (previousRoute.current !== location.key) {
      previousRoute.current = location.key;
      // Cancel a stale review, but let an already submitted wallet request
      // finish in the shared controller and persistent journal.
      if (!submitting.current) invalidate();
    }
    setProviderAgreed(false);
    setMode(requestedStep === 'line' || requestedStep === 'purchase' ? 'manage' : 'open');
    document.getElementById('journey-title')?.focus();
  }, [guided, location.key]);
  useEffect(() => {
    if (!guided || requestedStep !== 'register' || !snapshotCurrent || !snapshot?.sponsorAllowed || !correctNetwork || journeyLocked || prepared) return;
    navigate(`/start/agent${location.search}`, { replace: true });
  }, [guided, requestedStep, snapshotCurrent, snapshot?.sponsorAllowed, correctNetwork, journeyLocked, prepared, navigate, location.search]);
  const loadedLineId = line?.lineId;
  const lineViewRevision = revision.current;

  useEffect(() => {
    if (!guided || (requestedStep !== 'line' && requestedStep !== 'purchase') || busy || pending || journalError || autoLoadedLink.current === location.key) return;
    const id = new URLSearchParams(location.search).get('line');
    if (!id || line?.lineId.toLowerCase() === id.toLowerCase()) return;
    setLineId(id); setLine(null); setLineInputError("");
    if (!/^0x[0-9a-fA-F]{64}$/.test(id) || /^0x0{64}$/.test(id)) {
      autoLoadedLink.current = location.key;
      setLineInputError("This link does not contain a valid funding line ID. Ask the sponsor for the full link.");
      return;
    }
    let active = true;
    const readRevision = revision.current;
    setLineLoading(true);
    readCandidateLine(client, id).then(value => { if (active && revision.current === readRevision) setLine(value); })
      .catch(cause => { if (active && revision.current === readRevision) setError(messageOf(cause)); })
      .finally(() => { if (active) { if (revision.current === readRevision) autoLoadedLink.current = location.key; setLineLoading(false); } });
    return () => { active = false; setLineLoading(false); };
  }, [guided, requestedStep, location.key, location.search, account, walletSnapshotRevision, busy, pending, journalError, client, readCandidateLine]);

  // A sponsor can be watching while the agent purchases or repays elsewhere.
  // Keep these reads separate from transaction reviews and recovery journals.
  useEffect(() => {
    setLineRefreshError("");
    if (!loadedLineId || mode !== "manage" || busy || prepared || pending || journalError || gatewayHeld) return;
    const isCurrent = () => revision.current === lineViewRevision;
    return startLineRefresh({
      read: () => readCandidateLine(client, loadedLineId),
      onValue: value => {
        if (!isCurrent()) return;
        setLine(previous => isCurrent() && previous?.lineId === value.lineId && value.observedBlock >= previous.observedBlock ? value : previous);
        setLineRefreshError("");
      },
      onError: () => {
        if (isCurrent()) setLineRefreshError("Automatic refresh is temporarily unavailable. Showing the last confirmed values and retrying. You can also select Refresh line.");
      },
      visible: () => document.visibilityState === "visible",
      focusTarget: window,
      visibilityTarget: document,
    });
  }, [loadedLineId, lineViewRevision, account, chainId, mode, busy, prepared, pending, journalError, gatewayHeld, client, readCandidateLine]);

  const checkUnresolvedPurchase = useCallback(() => {
    if (!service || !account) { setUnresolvedPurchase(false); return; }
    try {
      assertPurchaseResolved(account, window.localStorage, deployment.chainId);
      setUnresolvedPurchase(false);
    } catch {
      // gatewayFundingGuard.ts belongs to the co-founder and exports only the asserting form, so catching it reuses his exact fail-closed rule instead of duplicating it.
      setUnresolvedPurchase(true);
    }
  }, [account, deployment.chainId, service]);

  useEffect(() => {
    checkUnresolvedPurchase();
  }, [busy, chainId, checkUnresolvedPurchase]);

  useEffect(() => {
    setLineDiscoveryProgress(null);
    setLineDiscoveryLoadingStates(false);
    setLineDiscoveryStatus(status => status === "idle" ? status : "idle");
    return cancelAgentLineDiscovery;
  }, [account, role, mode, pending, journalError, gatewayHeld, unresolvedPurchase, showAgentLineDiscovery, requestedStep]);

  useEffect(() => {
    window.addEventListener("focus", checkUnresolvedPurchase);
    window.addEventListener("storage", checkUnresolvedPurchase);
    return () => {
      window.removeEventListener("focus", checkUnresolvedPurchase);
      window.removeEventListener("storage", checkUnresolvedPurchase);
    };
  }, [checkUnresolvedPurchase]);

  useEffect(() => {
    if (!focusPurchase || role !== "agent" || !purchaseSlot.current) return;
    const purchaseTitle = purchaseSlot.current.querySelector<HTMLElement>("#purchase-title");
    if (!purchaseTitle) return;
    purchaseTitle.tabIndex = -1;
    purchaseTitle.focus();
    setFocusPurchase(false);
  }, [focusPurchase, role]);

  useEffect(() => {
    if (!focusLoadedLineHeading.current || !line) return;
    const heading = document.getElementById("funding-loaded-line-heading");
    if (!heading) return;
    focusLoadedLineHeading.current = false;
    heading.focus();
  }, [line]);

  useEffect(() => {
    const selected = selectedPurchaseFocus.current;
    if (!selected || busy) return;
    selectedPurchaseFocus.current = null;
    if (selected.revision !== revision.current || selected.routeKey !== location.key ||
        !guided || journeyStep !== "purchase" || line?.lineId.toLowerCase() !== selected.lineId.toLowerCase()) return;
    document.getElementById("purchase-line")?.focus();
  }, [busy, line, location.key, guided, journeyStep]);

  function invalidate() {
    selectedPurchaseFocus.current = null;
    revision.current += 1;
    setPrepared(null);
    setReviewInput(null);
    setResolution(null);
    setNotice("");
  }
  function updateLineId(value: string) {
    autoLoadedLink.current = location.key;
    invalidate();
    focusLoadedLineHeading.current = false;
    setLine(null);
    setLineInputError("");
    setLineId(value);
  }
  async function findAgentLines(action: "initial" | "continue" | "again" = "initial") {
    if (!discoveryClient || !account || !showAgentLineDiscovery) return;
    const currentAccount = account;
    const accountKey = currentAccount.toLowerCase();
    const cached = discoveredLinesByAccount.current.get(accountKey);
    const continuation = action === "continue" ? getAgentLineDiscoveryContinuationCursor(cached) ?? undefined : undefined;
    if (action === "continue" && !continuation && !cached?.pendingPageIds?.length) return;
    const fromBlock = action === "again" ? (cached?.headBlock ?? BigInt(publicTestnetManifest.deployment.blockNumber)) + 1n : undefined;
    const discoveryDeployment = {
      address: deployment.address,
      agent: currentAccount,
      deployBlock: BigInt(publicTestnetManifest.deployment.blockNumber),
    };
    const run = ++lineDiscoveryRun.current;
    lineDiscoveryActive.current = true;
    lineDiscoveryStoppedRun.current = null;
    const inContext = () => {
      const context = lineDiscoveryContext.current;
      return context.account?.toLowerCase() === accountKey && activeAccount.current?.toLowerCase() === accountKey
        && context.mode === "manage" && context.showAgentLineDiscovery;
    };
    const isActive = () => lineDiscoveryActive.current && lineDiscoveryRun.current === run && inContext();
    setDiscoveredLines([]);
    setLineDiscoveryProgress(null);
    setLineDiscoveryLoadingStates(Boolean(cached?.lineIds.length));
    setLineDiscoveryAction(action);
    setLineDiscoveryStatus("loading");
    try {
      // Finish the unread page before moving either scan cursor further.
      if (cached?.pendingPageIds?.length) {
        const refreshed = await refreshAgentLineDiscoveryCachePage(cached, cached.pendingPageIds,
          currentAccount, id => readCandidateLine(client, id), isActive);
        if (!refreshed || !isActive()) return;
        discoveredLinesByAccount.current.set(accountKey, refreshed);
        setDiscoveredLines(refreshed.lines);
        setLineDiscoveryLoadingStates(false);
        setLineDiscoveryStatus(refreshed.historyCursor || refreshed.forwardCursor ? "partial" : refreshed.lines.length ? "ready" : "empty");
        return;
      }
      let lastProgressUpdate: bigint | null = null;
      const result = await discoverAgentLineIds(discoveryClient, discoveryDeployment, {
        isActive,
        ...(continuation ? { cursor: continuation } : {}),
        ...(fromBlock !== undefined ? { fromBlock } : {}),
        onProgress: progress => {
          if (!isActive()) return;
          if (lastProgressUpdate === null || progress.searchedBlocks === 0n || progress.searchedBlocks === progress.totalBlocks
            || progress.searchedBlocks - lastProgressUpdate >= progress.totalBlocks / 20n) {
            lastProgressUpdate = progress.searchedBlocks;
            setLineDiscoveryProgress(progress);
          }
        },
      });
      const stoppedByUser = lineDiscoveryStoppedRun.current === run && inContext() && hasResumableDiscoveryProgress(result);
      if ((!isActive() && !stoppedByUser) || result.headBlock === null) return;
      const nextCache = mergeAgentLineDiscoveryCache(action, cached, {
        lineIds: result.lineIds,
        headBlock: result.headBlock,
        cursor: result.cursor,
      });
      // Preserve completed scans independently from the pending balance reads.
      const pageIds = action === "continue" && result.lineIds.length
        ? result.lineIds : nextCache.lineIds;
      const stagedCache = { ...nextCache, lines: [], pendingPageIds: [...new Set(pageIds)].slice(0, MAX_AGENT_LINE_DISCOVERY_RESULTS) };
      discoveredLinesByAccount.current.set(accountKey, stagedCache);
      if (stoppedByUser) {
        setDiscoveredLines([]);
        setLineDiscoveryLoadingStates(false);
        setLineDiscoveryStatus(stagedCache.pendingPageIds.length || stagedCache.historyCursor || stagedCache.forwardCursor ? "partial" : "empty");
        return;
      }
      setLineDiscoveryLoadingStates(Boolean(stagedCache.pendingPageIds.length));
      const completeCache = await refreshAgentLineDiscoveryCachePage(stagedCache, stagedCache.pendingPageIds, currentAccount,
        id => readCandidateLine(client, id), isActive);
      if (!completeCache || !isActive()) return;
      const values = completeCache.lines;
      discoveredLinesByAccount.current.set(accountKey, completeCache);
      setDiscoveredLines(values);
      setLineDiscoveryLoadingStates(false);
      setLineDiscoveryStatus(completeCache.historyCursor || completeCache.forwardCursor ? "partial" : values.length ? "ready" : "empty");
    } catch {
      if (isActive()) {
        setLineDiscoveryLoadingStates(false);
        setLineDiscoveryStatus("failed");
      }
    } finally {
      if (lineDiscoveryStoppedRun.current === run && inContext() && discoveredLinesByAccount.current.get(accountKey)?.pendingPageIds?.length) {
        setLineDiscoveryLoadingStates(false);
        setLineDiscoveryStatus("partial");
      }
      if (lineDiscoveryRun.current === run) {
        lineDiscoveryActive.current = false;
        setLineDiscoveryProgress(null);
      }
    }
  }
  function cancelAgentLineDiscovery() {
    lineDiscoveryActive.current = false;
    lineDiscoveryRun.current++;
  }
  function stopAgentLineDiscovery() {
    lineDiscoveryStoppedRun.current = lineDiscoveryRun.current;
    cancelAgentLineDiscovery();
    setLineDiscoveryProgress(null);
    setLineDiscoveryLoadingStates(false);
    setLineDiscoveryStatus("idle");
  }
  function selectDiscoveredLine(id: Hash) {
    keepSelectedLineInputEnabled.current = true;
    const selectingPurchase = guided && journeyStep === "purchase";
    if (!selectingPurchase) document.getElementById("funding-line")?.focus();
    updateLineId(id);
    focusLoadedLineHeading.current = !selectingPurchase;
    const loading = lookup(undefined, id);
    if (selectingPurchase) selectedPurchaseFocus.current = { revision: revision.current, routeKey: location.key, lineId: id };
    void loading.finally(() => { keepSelectedLineInputEnabled.current = false; });
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
        setWalletSnapshotRevision(previous => previous + 1);
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
  }, [account, walletSnapshotRevision, client, readCandidateSnapshot]);

  useEffect(() => {
    if (prepared && dialog.current) {
      if (!dialog.current.open) dialog.current.showModal();
      dialogTitle.current?.focus({ preventScroll: true });
    }
    if (!prepared && dialog.current?.open) dialog.current.close();
  }, [prepared]);

  useEffect(() => {
    if (error) {
      if (focusLoadedLineHeading.current) focusLoadedLineHeading.current = false;
      feedback.current?.scrollIntoView({ block: "nearest" });
    }
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
      // A refresh of the same account must still reload its balance and
      // sponsor permissions, including changes made in another tab.
      setWalletSnapshotRevision((previous) => previous + 1);
    } catch (cause) { setError(walletRequestHelp(cause) ?? messageOf(cause)); }
    finally { setBusy(""); }
  }

  async function switchNetwork() {
    setError("");
    setBusy(`Switching to ${network}…`);
    try {
      if (!window.ethereum) throw new Error("Connect your browser wallet first.");
      const selectedChain = await ensureWalletChain(window.ethereum, {
        chainId: `0x${CANDIDATE_FUNDING.chainId.toString(16)}`, chainName: chain.name,
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: [...chain.rpcUrls.default.http], blockExplorerUrls: [explorer],
      });
      invalidate();
      setChainId(selectedChain);
    } catch (cause) { setError(walletRequestHelp(cause) ?? messageOf(cause)); }
    finally { setBusy(""); }
  }

  async function review(action: "register" | "open" | "repay" | "default" | "reclaim", event?: FormEvent) {
    event?.preventDefault();
    if (!account || !canWrite) return;
    if (action === "open" && !providerAgreed) { setError("Read and acknowledge the repayment risk before funding."); return; }
    if (guided && action === "open") { const issue = budgetIssue(form, snapshotCurrent && snapshot ? snapshot : undefined); if (issue) { setError(issue); return; } }
    const currentRevision = revision.current;
    setError(""); setNotice(""); setResolution(null); setBusy("Checking current limits and preparing your review…");
    try {
      if (action !== "open" && action !== "register" && !line) throw new Error("Load the funding line before reviewing an action.");
      const value = action === "register" ? await prepareCandidateRegistration(client, account) : action === "open" ? await prepareCandidateOpen(client, account, form)
        : action === "repay" ? await prepareCandidateRepay(client, account, line!.lineId)
        : action === "default" ? await prepareCandidateDefault(client, account, line!.lineId)
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
    catch (cause) { if (revision.current === currentRevision) setError(messageOf(cause)); }
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
        if (result.lineId) {
          setMode("manage");
          if (guided) navigate(`/start/line?line=${result.lineId}`);
        }
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
        if (intent.kind !== 'repay' && intent.kind !== 'default' && !(intent.kind === 'approve' && intent.nextAction === 'repay')) assertPurchaseResolved(sender, window.localStorage, deployment.chainId);
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
        const result = await reconcileCandidatePending(client, saved, typed || found, journal);
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
  const defaultable = line && isSponsor && line.stateName === "DRAWN" && line.principalOutstanding > 0n && line.observedTimestamp >= line.dueAt;
  const reclaimable = line && isSponsor && ((line.stateName === "OPEN" && line.principalOutstanding === 0n) ||
    (line.stateName === "DEFAULTED" && line.availableReserve + line.recoveryAvailable > 0n));
  const shareable = Boolean(service && line && isSponsor && line.stateName === "OPEN" && line.expiry > line.observedTimestamp &&
    line.sponsorAllowed && !line.spendsPaused);
  const openBlocker = !account ? "Connect your wallet to review and fund." : !correctNetwork ? `Switch to ${network} to continue.`
    : gatewayHeld ? "Resolve Gateway funding above before opening a line." : pending ? "Check the previous transaction above before funding." : journalError ? "Transaction recovery is unavailable in this browser. See the message above."
    : snapshot?.openingsPaused ? "New lines are currently paused."
    : snapshot?.sponsorAllowed === false ? (deployment.selfRegistration ? "Register this wallet above before funding." : "This wallet is not approved as a sponsor yet.")
    : !snapshotCurrent ? "Checking this wallet’s sponsor status…"
    : !providerAgreed ? "Read and acknowledge the repayment risk to continue." : null;
  const lineBlocker = !account ? "Connect your wallet to repay." : !correctNetwork ? `Switch to ${network} to continue.`
    : gatewayHeld ? "Resolve Gateway funding above before continuing." : pending ? "Check the previous transaction above before continuing." : journalError ? "Transaction recovery is unavailable in this browser. See the message above." : null;
  const cachedLineDiscovery = account ? discoveredLinesByAccount.current.get(account.toLowerCase()) : undefined;
  const incompleteLineDiscoveryCursor = getAgentLineDiscoveryContinuationCursor(cachedLineDiscovery);
  const canContinueLineDiscovery = Boolean(cachedLineDiscovery?.pendingPageIds?.length || cachedLineDiscovery?.historyCursor || cachedLineDiscovery?.forwardCursor);
  const incompleteLineDiscoveryProgress = incompleteLineDiscoveryCursor
    ? ` Searched ${incompleteLineDiscoveryCursor.searchedBlocks.toLocaleString()} of ${incompleteLineDiscoveryCursor.totalBlocks.toLocaleString()} blocks.` : "";

  const walletControls = <div className="fundingWallet">
        <span>{account ? "Connected browser wallet" : "Your wallet stays in control"}</span>
        {account && <code title={account}>{compact(account)}</code>}
        <button type="button" onClick={connect} disabled={Boolean(busy)}>{account ? "Refresh wallet" : "Connect wallet"}</button>
        {account && !correctNetwork && <button type="button" onClick={switchNetwork} disabled={Boolean(busy)}>Switch to {network}</button>}
        {account && correctNetwork && <small>{network} connected</small>}
      </div>;
  const networkHelp = !mainnet && <details className="fundingNetworkHelp">
      <summary>Wallet connection help</summary>
      <p>If switching does not open a prompt, open your wallet extension and check for a waiting request. If needed, add or select this network in the wallet, then select Refresh wallet above.</p>
      <dl className="fundingDetails"><div><dt>Network</dt><dd>Arc Testnet</dd></div><div><dt>Chain ID</dt><dd>5042002</dd></div><div><dt>Gas currency</dt><dd>USDC</dd></div><div><dt>RPC URL</dt><dd><code>{ARC_TESTNET_RPC_URL}</code></dd></div><div><dt>Explorer</dt><dd><code>{explorer}</code></dd></div></dl>
      <p>If your wallet shows a connection error or HTTP 403, check its Arc Testnet RPC. In Rabby, open Settings &gt; Modify RPC URL &gt; Arc Testnet, save <code>{ARC_TESTNET_RPC_URL}</code>, then select Refresh wallet above.</p>
      <p>Changing the connection does not confirm a payment. Check any saved pending transaction before trying an action again.</p>
      <a href="https://docs.arc.io/arc/references/connect-to-arc" target="_blank" rel="noreferrer">Arc wallet setup guide</a>
    </details>;
  const feedbackPanel = <div className="fundingFeedback" ref={feedback} aria-live="polite" aria-atomic="true">
      {busy && <p role="status">{busy}</p>}
      {error && <p className="fundingError" role="alert">{error}</p>}
      {journalError && <p className="fundingError" role="alert">{journalError} New transactions are disabled until recovery is available.</p>}
      {notice && <p>{notice}</p>}
      {resolution && <p className={resolution.status === "confirmed" ? "fundingSuccess" : ""}>
        {resolution.message} {resolution.txHash && <a href={`${explorer}/tx/${resolution.txHash}`} target="_blank" rel="noreferrer">View transaction</a>}
      </p>}
    </div>;
  const recoveryPanel = pending && <section className="fundingRecovery" aria-labelledby="funding-recovery-title">
      <h2 id="funding-recovery-title">Check the previous transaction first</h2>
      <p>A {pending.kind === "register" ? "sponsor registration" : pending.kind === "approve" ? "USDC approval" : pending.kind === "open" ? "line opening" : pending.kind === "repay" ? "repayment" : pending.kind === "default" ? "default declaration" : "reclaim"} has not been resolved. New transactions from this wallet are paused here so a retry cannot accidentally send it again.</p>
      <p>Finish any open wallet prompt. Then check its status. Keep this browser’s site data until it is resolved.</p>
      {pending.txHash && <a href={`${explorer}/tx/${pending.txHash}`} target="_blank" rel="noreferrer">Open the saved transaction</a>}
      <Field name="recovery-hash" label="Transaction hash from your wallet (optional)" value={recoveryHash} onChange={setRecoveryHash} required={false} disabled={Boolean(busy)}
        hint="Leave empty to check the saved transaction. If your wallet shows it was replaced, sped up or cancelled, paste the confirmed replacement transaction’s hash instead. Shadow must verify that it replaced the original; an unrelated payment cannot clear this check." />
      <button type="button" onClick={recover} disabled={Boolean(busy)}>Check confirmation</button>
      <details><summary>No transaction hash in your wallet?</summary>
        <p>A missing hash does not prove the request was cancelled. Your wallet may have changed the proposed nonce. Check its activity for the original request and copy that transaction’s hash here. If the wallet cannot identify it, keep this record and ask for help before sending again.</p>
        <dl className="fundingDetails"><div><dt>Account</dt><dd><code>{pending.account}</code></dd></div><div><dt>Saved transaction nonce</dt><dd>{pending.nonce}</dd></div></dl>
      </details>
    </section>;
  const gatewayPanel = gatewayEnabled && <div className="fundingSlot" hidden={guided ? journeyStep !== 'fund' && !gatewayHeld : role === "agent" && !gatewayHeld}><GatewayFunding account={account} correctNetwork={correctNetwork} deployment={deployment}
      reserve={form.reserve} busy={busy} setBusy={setBusy} onHold={setGatewayHeld} onReady={() => {
        const sponsor = account;
        if (sponsor) void readCandidateSnapshot(client, {sponsor}).then(value => { if (activeAccount.current === sponsor) setSnapshot(value); }).catch(cause => setSnapshotError(messageOf(cause)));
      }} /></div>;
  const lineDiscoveryButtons = <>
        <button type="button" onClick={() => lineDiscoveryStatus === "loading" ? stopAgentLineDiscovery()
            : void findAgentLines(cachedLineDiscovery ? "again" : "initial")}>
            {lineDiscoveryStatus === "loading" ? "Stop" : cachedLineDiscovery ? "Search again" : "Find my funding lines"}
        </button>
        {lineDiscoveryStatus !== "loading" && canContinueLineDiscovery && <button type="button" onClick={() => void findAgentLines("continue")}>
            Continue search
        </button>}
  </>;
  const lineDiscoveryResults = showAgentLineDiscovery && lineDiscoveryStatus !== "idle" && <div className="agentLineDiscovery" aria-live="polite">
        {lineDiscoveryStatus === "loading" && <p role="status">{lineDiscoveryLoadingStates
          ? "Loading the current state of the lines found…"
          : lineDiscoveryProgress
          ? `Searched ${lineDiscoveryProgress.searchedBlocks.toLocaleString()} of ${lineDiscoveryProgress.totalBlocks.toLocaleString()} blocks.`
          : lineDiscoveryAction === "again" ? "Checking for lines opened since the last search…"
          : lineDiscoveryAction === "continue" ? "Continuing the earlier search…" : "Checking the current block…"}</p>}
        {(lineDiscoveryStatus === "ready" || lineDiscoveryStatus === "partial" || (lineDiscoveryStatus === "loading" && discoveredLines.length > 0)) && <>
          {lineDiscoveryStatus === "ready" && <p role="status">Choose a funding line for this wallet.</p>}
          {lineDiscoveryStatus === "partial" && <p role="status">{`Search incomplete.${incompleteLineDiscoveryProgress} ${discoveredLines.length
            ? "Choose a line on this page or continue searching more blocks."
            : "Continue searching to check more blocks, or enter a line ID below."}`}</p>}
          <ul className="agentLineChoices">{discoveredLines.map((candidateLine) => <li key={candidateLine.lineId}>
            <button className="agentLineChoice" type="button" disabled={Boolean(busy)} onClick={() => selectDiscoveredLine(candidateLine.lineId)}>
              <span><strong>{candidateLine.stateName === "OPEN" ? "Open" : candidateLine.stateName === "DRAWN" ? "Drawn" : candidateLine.stateName === "CLOSED" ? "Closed" : "Defaulted"}</strong><code>{compact(candidateLine.lineId)}</code></span>
              <span>Available reserve {usdc(candidateLine.availableReserve)} USDC · Debt {usdc(candidateLine.principalOutstanding)} USDC</span>
              <small>Sponsor {compact(candidateLine.sponsor)}</small>
            </button>
          </li>)}</ul>
        </>}
        {lineDiscoveryStatus === "empty" && <>
          <p role="status">No public testnet funding lines were found for this wallet in the available history. A sponsor must open a line for this wallet first. Share this invitation with your sponsor.</p>
          <div className="fundingField"><label htmlFor="discovery-agent-invite">Sponsor invitation link</label><input id="discovery-agent-invite" readOnly value={`${window.location.origin}${guided ? "/start/wallet" : window.location.pathname}?agent=${account}`} /></div>
        </>}
        {lineDiscoveryStatus === "failed" && <p role="status">The funding line lookup failed. Paste the line ID below to load it.</p>}
      </div>;
  const managePanel = <section className="fundingPanel" aria-labelledby="funding-manage-title">
      <div className="fundingPanelHead"><div><h2 id="funding-manage-title">{line ? "Funding line overview" : "Find your funding line"}</h2><p>Read its balance without connecting a wallet. Connect to repay or reclaim.</p></div></div>
      <form className="fundingLookup" onSubmit={(event) => void lookup(event)}>
        <Field name="line" label="Funding line ID" value={lineId} error={lineInputError} onChange={updateLineId} disabled={Boolean(busy) && !keepSelectedLineInputEnabled.current} hint="The 0x identifier from your line-opening receipt." />
        {showAgentLineDiscovery && lineDiscoveryButtons}
        <button type="submit" disabled={Boolean(busy)}>Load line</button>
      </form>
      {lineLoading && <p role="status">Loading the line from your link…</p>}
      {lineDiscoveryResults}
      {mainnet && role === "agent" && account && !lineId.trim() && <p className="agentLineDiscovery" role="status">Enter a funding line ID on this route to load a mainnet line.</p>}
      {line && <div className="fundingLine">
        <div className="fundingPanelHead"><h3 id="funding-loaded-line-heading" tabIndex={-1}>{line.stateName === "DRAWN" ? "Purchase awaiting repayment" : line.stateName === "OPEN" ? "Line open" : line.stateName === "CLOSED" ? "Line closed" : "Line defaulted"}</h3>
          <span>Updated at block {line.observedBlock.toString()}</span></div>
        <p className="fundingScope">Balances refresh automatically while this page is visible.</p>
        {lineRefreshError && <p className="fundingCallout" role="status">{lineRefreshError}</p>}
        <dl className="fundingMetrics">
          <div><dt>Available reserve</dt><dd>{usdc(line.availableReserve)} <small>USDC</small></dd></div>
          <div><dt>Outstanding debt</dt><dd>{usdc(line.principalOutstanding)} <small>USDC</small></dd></div>
          <div><dt>Total purchases</dt><dd>{usdc(line.cumulativePrincipalPaid)} <small>USDC</small></dd></div>
          <div><dt>Remaining total limit</dt><dd>{usdc(remaining)} <small>USDC</small></dd></div>
        </dl>
        <p>{line.stateName === "CLOSED" ? "This line is closed and cannot fund another purchase. Open a new line if you want to provide another budget." : line.stateName === "DEFAULTED" ? "This line is defaulted and cannot fund another purchase." : "Repay a purchase in full before the next one. Repayment restores reserve; it does not reset the total purchase limit."}</p>
        {line.stateName === "DEFAULTED" && <p className="fundingCallout">Repayment supports sponsor recovery. This defaulted line will not reopen. Recoverable funds: {usdc(line.availableReserve + line.recoveryAvailable)} USDC.</p>}
        {line.principalOutstanding > 0n && <p>Repayment due: <strong>{when(line.dueAt)}</strong>. The obligation remains if service delivery is unresolved.</p>}
        {line.expiry <= line.observedTimestamp && <p className="fundingCallout">The line has expired for new purchases. Existing debt and eligible reclaim remain.</p>}
        {(!line.sponsorAllowed || line.spendsPaused) && <p className="fundingCallout">New purchases are currently restricted. You can still repay and reclaim eligible funds.</p>}
        {shareable &&
          <div className="fundingField"><label htmlFor="line-share-link">Send this link to your agent</label>
          <input id="line-share-link" readOnly aria-describedby="line-share-link-hint" value={`${window.location.origin}${guided ? "/start/line" : window.location.pathname}?line=${line.lineId}`} />
          <small id="line-share-link-hint">It opens this page with the line filled in. The agent’s page checks the line again before any payment is sent.</small></div>}
        <div className="fundingActions">
          {defaultable && <button className="fundingPrimary" type="button" disabled={!canWrite} aria-describedby={lineBlocker ? "funding-line-action-hint" : undefined} onClick={() => void review("default")}>Review default</button>}
          {repayable && <button className="fundingPrimary" type="button" disabled={!canWrite} aria-describedby={lineBlocker ? "funding-line-action-hint" : undefined} onClick={() => void review("repay")}>Review full repayment</button>}
          {reclaimable && <button className="fundingPrimary" type="button" disabled={!canWrite} aria-describedby={lineBlocker ? "funding-line-action-hint" : undefined} onClick={() => void review("reclaim")}>{line.stateName === "DEFAULTED" ? "Review recovery claim" : "Review close and reclaim"}</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => void lookup()}>Refresh line</button>
          {line.stateName === "OPEN" && line.principalOutstanding === 0n && !isSponsor && <small>Only the sponsor can close this line and reclaim its reserve.</small>}
          {(defaultable || repayable || reclaimable) && lineBlocker && <small id="funding-line-action-hint">{lineBlocker}</small>}
        </div>
        <details><summary>Line details</summary>
          <dl className="fundingDetails"><div><dt>Line ID</dt><dd><code>{line.lineId}</code></dd></div><div><dt>Sponsor</dt><dd><code>{line.sponsor}</code></dd></div>
            <div><dt>Agent</dt><dd><code>{line.agent}</code></dd></div><div><dt>Expires</dt><dd>{when(line.expiry)}</dd></div>
            <div><dt>Line daily limit</dt><dd>{usdc(line.dailySpendCap)} USDC</dd></div><div><dt>Line epoch</dt><dd>{line.epoch.toString()}</dd></div></dl>
          <p>{service ? "The agent buys the service below, signing with its own wallet; this line pays the price. This section manages funding, repayment and reclaim." : <>The agent signs a purchase and an executor submits it using the <a href="https://github.com/buildwithshadow/shadow/blob/main/docs/SHADOW_FLOAT_MAINNET_PARTICIPANT_TOOLS.md" target="_blank" rel="noreferrer">candidate participant tools</a>. This page manages funding, repayment and reclaim.</>}</p>
        </details>
        {service && <CircleAgentHandoff key={line.lineId} lineId={line.lineId} agent={line.agent} lineState={line.stateName} debt={line.principalOutstanding} spendingAvailable={line.stateName === "OPEN" && line.principalOutstanding === 0n && line.sponsorAllowed && !line.spendsPaused && line.observedTimestamp < line.expiry && line.availableReserve >= BigInt(service.principal) && line.lineSpendCap - line.cumulativePrincipalPaid >= BigInt(service.principal)} route={mainnet ? 'guarded-mainnet' : guardedTestnet ? 'guarded-testnet' : 'public-testnet'} />}
      </div>}
    </section>;
  const purchasePanel = service && <div className="fundingSlot" ref={purchaseSlot} hidden={guided ? journeyStep !== 'purchase' : role === "sponsor"}><PublicPurchase active={!guided || journeyStep === 'purchase'} account={account} correctNetwork={correctNetwork} deployment={deployment} service={service}
      client={client} busy={busy} setBusy={setBusy} fundingPending={Boolean(pending || journalError || gatewayHeld)} onPurchaseChanged={refreshPurchaseLine} lineId={lineId} onLineIdChange={updateLineId} /></div>;
  const transactionDialog = <dialog ref={dialog} className="fundingDialog" role="alertdialog" aria-labelledby="funding-review-title" aria-describedby="funding-review-description" tabIndex={-1}
      onCancel={(event) => { if (submitting.current) event.preventDefault(); else setPrepared(null); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (!focusable?.length) {
          event.preventDefault();
          dialog.current?.focus({ preventScroll: true });
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogTitle.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}>
      {prepared && <><p className="pageEyebrow">{network} · Wallet confirmation</p>
        <h2 ref={dialogTitle} id="funding-review-title" tabIndex={-1}>{prepared.kind === "register" ? "Register your sponsor wallet" : prepared.kind === "approve" ? "Approve this USDC amount" : prepared.kind === "open" ? "Open this funding line" : prepared.kind === "repay" ? "Repay this amount" : prepared.kind === "default" ? "Declare this line in default" : "Reclaim eligible funds"}</h2>
        <p id="funding-review-description">{prepared.summary}</p>
        <dl className="fundingDetails"><div><dt>Wallet</dt><dd><code>{prepared.account}</code></dd></div>
          <div><dt>{prepared.kind === "default" ? "Outstanding principal" : "Amount"}</dt><dd>{usdc(prepared.amount)} {mainnet ? 'USDC' : 'test USDC'}</dd></div>
          <div><dt>Contract receiving the call</dt><dd><code>{prepared.to}</code></dd></div>
          {prepared.lineId && <div><dt>Line ID</dt><dd><code>{prepared.lineId}</code></dd></div>}
        </dl>
        {reviewInput && <dl className="fundingDetails"><div><dt>Agent</dt><dd><code>{reviewInput.agent}</code></dd></div><div><dt>Provider</dt><dd><code>{reviewInput.provider}</code></dd></div>
          <div><dt>Endpoint</dt><dd>{reviewInput.endpoint}</dd></div><div><dt>Total / daily / per purchase</dt><dd>{reviewInput.lineSpendCap} / {reviewInput.dailySpendCap} / {reviewInput.providerPerSpendCap} USDC</dd></div></dl>}
        <p>{prepared.kind === "register" ? "Registration enables funding from this wallet only. Your tokens remain in your wallet." : prepared.kind === "approve" ? "This approval does not open a line or repay debt. You will review that transaction separately." : prepared.kind === "repay" ? "Review the repayment scope above. Legacy lines pay current debt at execution and can settle a newer purchase if approval is delayed; guarded lines reject a different purchase. Check confirmation before retrying." : prepared.kind === "default" ? "Unpaid spent principal remains a loss unless it is repaid." : prepared.kind === "open" ? "The sponsor bears repayment risk. A paid provider can leave debt outstanding even if delivery fails." : "Closing an open line ends its purchase access and returns eligible reserve to its sponsor."}</p>
        <p>Finish other transactions from this account first. If you submit one elsewhere while this wallet prompt is open, cancel this request and review it again. Shadow cannot reserve a wallet nonce across other apps or devices.</p>
        <div className="fundingActions"><button type="button" onClick={() => setPrepared(null)} disabled={Boolean(busy)}>Back</button>
          <button className="fundingPrimary" type="button" onClick={() => void sendReviewed()} disabled={Boolean(busy)}>Confirm in wallet</button></div>
        {busy && <p role="status">{busy}</p>}
      </>}
    </dialog>;
  const agentFields = <fieldset disabled={Boolean(busy)}><legend>Who will use the budget?</legend><div className="fundingGrid">
        <Field name="agent" label="Agent wallet address" value={form.agent} onChange={(value) => updateForm("agent", value)} hint={service ? "The wallet from your agent’s invitation, or use your own wallet to try the full flow." : "The wallet that will sign each purchase. A deployed Circle Modular Wallet is supported as the agent."} />
        <Field name="provider" label="Provider payment address" value={form.provider} onChange={(value) => updateForm("provider", value)} disabled={Boolean(service)} hint="Confirm this destination with the provider before funding." />
        <div className="fundingWide"><Field name="endpoint" label="Agreed service endpoint" value={form.endpoint} onChange={(value) => updateForm("endpoint", value)} disabled={Boolean(service)} hint="Paste the exact HTTPS endpoint agreed with the provider. Shadow binds purchases to this text; this form does not contact the endpoint." /></div>
      </div></fieldset>;
  const budgetFields = <fieldset disabled={Boolean(busy)}><legend>How much can the agent use?</legend><div className="fundingGrid fundingThree">
        <Field name="reserve" label="USDC to set aside" value={form.reserve} onChange={(value) => updateForm("reserve", value)} decimal hint="Transferred into the line when it opens." />
        <Field name="lineSpendCap" label="Total purchase limit (USDC)" value={form.lineSpendCap} onChange={(value) => updateForm("lineSpendCap", value)} decimal hint="Cumulative across this line. Repayment does not reset it." />
        <Field name="dailySpendCap" label="Line daily limit (USDC)" value={form.dailySpendCap} onChange={(value) => updateForm("dailySpendCap", value)} decimal hint="Resets at midnight UTC." />
        <Field name="providerPerSpendCap" label="Maximum purchase (USDC)" value={form.providerPerSpendCap} onChange={(value) => updateForm("providerPerSpendCap", value)} decimal />
        <Field name="providerDailyCap" label="Provider daily limit (USDC)" value={form.providerDailyCap} onChange={(value) => updateForm("providerDailyCap", value)} decimal />
      </div></fieldset>;
  const timeFields = <fieldset disabled={Boolean(busy)}><legend>When must it be repaid?</legend><div className="fundingGrid">
        <Field name="expiryDays" label="Line and provider approval duration (days)" value={form.expiryDays} onChange={(value) => updateForm("expiryDays", value)} decimal />
        <Field name="repaymentHours" label="Maximum repayment window (hours)" value={form.repaymentHours} onChange={(value) => updateForm("repaymentHours", value)} decimal hint="Each signed purchase sets its due time within this window." />
      </div></fieldset>;
  const guidedBudgetFields = <>
    {snapshotCurrent && <p className="fundingBalance">{usdc(snapshot!.balance)} test USDC available in your wallet</p>}
    <div className="fundingGrid">
      <Field name="reserve" label="Test USDC to set aside" value={form.reserve} onChange={value => updateForm('reserve', value)} disabled={Boolean(busy)} decimal hint="This reserve pays for purchases. Keep extra test USDC in your wallet for gas." />
      <Field name="providerPerSpendCap" label="Maximum per purchase (test USDC)" value={form.providerPerSpendCap} onChange={value => updateForm('providerPerSpendCap', value)} disabled={Boolean(busy)} decimal hint={`The test service costs ${formatUnits(BigInt(service?.principal ?? '0'), 6)} test USDC. A lower cap will block its purchase.`} />
      <Field name="repaymentHours" label="Repayment window (hours)" value={form.repaymentHours} onChange={value => updateForm('repaymentHours', value)} disabled={Boolean(busy)} decimal hint="The operator owes repayment after each purchase. This does not guarantee repayment." />
    </div>
    <details><summary>More spending limits and duration</summary><p>Repayment restores the reserve but does not reset the total purchase limit. Daily limits reset at midnight UTC.</p><div className="fundingGrid">
      <Field name="lineSpendCap" label="Total purchase limit (test USDC)" value={form.lineSpendCap} onChange={value => updateForm('lineSpendCap', value)} disabled={Boolean(busy)} decimal />
      <Field name="dailySpendCap" label="Line daily limit (test USDC)" value={form.dailySpendCap} onChange={value => updateForm('dailySpendCap', value)} disabled={Boolean(busy)} decimal />
      <Field name="providerDailyCap" label="Provider daily limit (test USDC)" value={form.providerDailyCap} onChange={value => updateForm('providerDailyCap', value)} disabled={Boolean(busy)} decimal />
      <Field name="expiryDays" label="Funding duration (days)" value={form.expiryDays} onChange={value => updateForm('expiryDays', value)} disabled={Boolean(busy)} decimal hint="One to seven days. Expiry stops new purchases; debt and reclaim eligibility remain." />
    </div></details>
  </>;
  const riskAcknowledgment = <label className="fundingCheck"><input type="checkbox" checked={providerAgreed} onChange={(event) => { invalidate(); setProviderAgreed(event.target.checked); }} disabled={Boolean(busy)} />
        <span>I accept that spent funds are unsecured credit to the agent operator: Shadow cannot enforce repayment or guarantee delivery, and unpaid spent principal cannot be reclaimed. Other sponsors may separately fund the same agent.</span></label>;

  if (guided) return <FundingJourney step={journeyStep} busy={Boolean(busy || prepared)} title={journeyTitle} description={journeyDescription} onNavigate={goJourney}
    wallet={journeyStep !== 'wallet' && account ? <><small>Connected wallet</small><code>{compact(account)}</code><button type="button" disabled={Boolean(busy)} onClick={connect}>Refresh wallet</button></> : undefined}
    summary={['register','agent','budget','fund'].includes(journeyStep) ? <><h2>Your funding plan</h2><dl><div><dt>Sponsor</dt><dd>{account ? <code>{compact(account)}</code> : 'Connect your wallet'}</dd></div><div><dt>Agent</dt><dd>{validAgent(form.agent) ? <code>{compact(form.agent)}</code> : 'Choose next'}</dd></div><div><dt>Reserve</dt><dd>{form.reserve} test USDC</dd></div><div><dt>Maximum per purchase</dt><dd>{form.providerPerSpendCap} test USDC</dd></div><div><dt>Repayment window</dt><dd>Up to {form.repaymentHours} hours per purchase</dd></div></dl><p>Unused eligible funds can be reclaimed. Money already spent is owed by the agent operator and depends on repayment.</p></> : undefined}>
    {feedbackPanel}{snapshotError && <p className="fundingCallout" role="alert">{snapshotError}</p>}{draftWarning && <p className="fundingCallout" role="status">{draftWarning}</p>}
    {recoveryPanel}
    {unresolvedPurchase && <div className="fundingPurchaseStatus"><p>A previous purchase needs a status check before you send anything else.</p><button type="button" disabled={Boolean(busy)} onClick={() => goJourney('purchase')}>Check purchase</button></div>}
    {journeyStep === 'home' && <div className="journeyChoices"><section className="journeyChoice"><span className="journeyRoleLabel">I AM PROVIDING THE BUDGET</span><h2>Fund an agent</h2><p>Choose an agent, set spending limits, and fund a line from your wallet. Track repayment and reclaim eligible funds.</p><button className="fundingPrimary" type="button" onClick={() => goJourney('wallet')}>Create a funding line</button></section><section className="journeyChoice"><span className="journeyRoleLabel">I ALREADY HAVE A LINE</span><h2>Use a funded line</h2><p>Open the line shared by your sponsor to buy a service, recover a result or repay a purchase.</p><button type="button" onClick={() => goJourney('line')}>Open my line</button></section></div>}
    {journeyStep === 'wallet' && <section className="fundingPanel"><h2>Your wallet, your budget</h2><p>Use Rabby or another Ethereum browser wallet. Connecting shares your public address. It does not approve or move funds.</p>{walletControls}
      {account && correctNetwork && <><p className="journeySuccess">Connected to Arc testnet.</p><div className="journeyNext"><button type="button" onClick={() => goJourney('home')}>Back</button><button className="fundingPrimary" type="button" disabled={journeyLocked || !snapshotCurrent} onClick={() => goJourney(snapshot?.sponsorAllowed ? 'agent' : 'register')}>{snapshotCurrent ? 'Continue' : 'Checking sponsor status…'}</button></div></>}
      {networkHelp}<p className="journeyHint">Need test funds? <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Open Circle’s faucet</a> and choose Arc testnet. Keep a little test USDC for wallet transaction fees.</p></section>}
    {journeyStep === 'register' && <section className="fundingPanel"><h2>Register once. Fund when you choose.</h2><p>This enables your wallet to sponsor funding lines. Registration uses testnet gas. It gives Shadow no token allowance and moves no USDC.</p><dl className="fundingDetails"><div><dt>Wallet to register</dt><dd><code>{account}</code></dd></div><div><dt>Network</dt><dd>Arc testnet</dd></div><div><dt>Registration status</dt><dd>{snapshotCurrent ? snapshot?.sponsorAllowed ? 'Registered' : 'Not registered yet' : 'Checking…'}</dd></div></dl>
      {snapshot?.openingsPaused && <p className="fundingCallout">New sponsor registrations are paused. Existing lines can still be managed.</p>}
      <div className="journeyNext"><button type="button" disabled={Boolean(busy)} onClick={() => goJourney('wallet')}>Back</button><button className="fundingPrimary" type="button" disabled={!canWrite || !snapshotCurrent || snapshot?.openingsPaused || unresolvedPurchase} onClick={() => void review('register')}>Review sponsor registration</button></div><p className="journeyHint">Review here first, then confirm in your wallet. After confirmation, you will continue to choose the agent.</p></section>}
    {journeyStep === 'agent' && <form className="fundingPanel" onSubmit={event => { event.preventDefault(); if (!validAgent(form.agent)) { setError('Enter a valid, nonzero agent wallet address.'); return; } goJourney('budget'); }}><h2>Choose the agent wallet</h2><p>This wallet signs the purchases. The person operating it is responsible for repayment.</p><Field name="agent" label="Agent wallet address" value={form.agent} onChange={value => updateForm('agent',value)} disabled={Boolean(busy)} hint="Paste the address shared by the agent operator." />
      <button type="button" disabled={!account || Boolean(busy)} onClick={() => account && updateForm('agent',account)}>Use my connected wallet for this test</button>
      <details><summary>Service available in this test</summary><p>Shadow payment cycle report, {formatUnits(BigInt(service!.principal),6)} test USDC per purchase. This report uses public Shadow transaction data.</p><p>Provider: <code>{service!.provider}</code></p></details>
      <div className="journeyNext"><button type="button" onClick={() => goJourney('wallet')}>Back</button><button className="fundingPrimary" type="submit" disabled={journeyLocked}>Continue to budget</button></div></form>}
    {journeyStep === 'budget' && <form className="fundingPanel" onSubmit={event => { event.preventDefault(); const issue=budgetIssue(form, snapshotCurrent && snapshot ? snapshot : undefined); if (issue) { setError(issue); return; } goJourney('fund'); }}><h2>Choose the limits</h2><p>These limits apply to this agent and the approved service. You will review everything before any funds move.</p>{guidedBudgetFields}<div className="journeyNext"><button type="button" onClick={() => goJourney('agent')}>Back</button><button className="fundingPrimary" type="submit" disabled={journeyLocked}>Review funding plan</button></div></form>}
    {journeyStep === 'fund' && <><section className="fundingPanel"><h2>Your funding plan</h2><dl className="fundingDetails"><div><dt>Agent wallet</dt><dd><code>{form.agent}</code></dd></div><div><dt>Service provider</dt><dd><code>{form.provider}</code></dd></div><div><dt>Reserve to deposit</dt><dd>{form.reserve} test USDC</dd></div><div><dt>Total purchase limit</dt><dd>{form.lineSpendCap} test USDC</dd></div><div><dt>Line daily limit</dt><dd>{form.dailySpendCap} test USDC</dd></div><div><dt>Maximum purchase</dt><dd>{form.providerPerSpendCap} test USDC</dd></div><div><dt>Provider daily limit</dt><dd>{form.providerDailyCap} test USDC</dd></div><div><dt>Funding duration</dt><dd>{form.expiryDays} days</dd></div><div><dt>Repayment window</dt><dd>Up to {form.repaymentHours} hours per purchase</dd></div></dl><details><summary>Service endpoint</summary><code>{form.endpoint}</code></details>
      {riskAcknowledgment}<div className="journeyNext"><button type="button" disabled={Boolean(busy)} onClick={() => goJourney('budget')}>Edit budget</button><button className="fundingPrimary" type="button" disabled={Boolean(busy) || openBlocker !== null || unresolvedPurchase} onClick={() => void review('open')}>Review funding transaction</button></div><p className="journeyHint">{openBlocker ?? 'If an allowance is needed, approve the exact amount first. Opening the line is a separate transaction. A completed allowance stays in place if you cancel the next step.'}</p></section></>}
    {(journeyStep === 'line' || journeyStep === 'purchase') && <>{!account && <section className="fundingPanel"><p>You can look up a line without connecting. Connect when you are ready to sign an action.</p>{walletControls}</section>}{account && !correctNetwork && <section className="fundingPanel"><p>Switch to Arc testnet before signing an action.</p><button type="button" disabled={Boolean(busy)} onClick={switchNetwork}>Switch to Arc testnet</button>{networkHelp}</section>}
      {journeyStep === 'line' && !line && account && <details className="fundingPanel"><summary>Need a sponsor to fund your agent?</summary><p>Share this link with a sponsor. It fills in your connected wallet as the agent. They choose and approve the budget.</p><div className="fundingField"><label htmlFor="agent-invite">Your agent funding link</label><input id="agent-invite" readOnly value={`${window.location.origin}/start/wallet?agent=${account}`} /></div></details>}
      {journeyStep === 'line' && <>{managePanel}{line && <div className="journeyNext"><button className="fundingPrimary" type="button" disabled={Boolean(busy)} onClick={() => goJourney('purchase')}>Go to service purchase</button></div>}</>}
      {journeyStep === 'purchase' && <button type="button" disabled={Boolean(busy)} onClick={() => goJourney('line')}>Back to line overview</button>}
      {journeyStep === 'purchase' && showAgentLineDiscovery && <section className="fundingPanel" aria-labelledby="purchase-discovery-title"><h2 id="purchase-discovery-title">Find your funding line</h2><div className="fundingActions">{lineDiscoveryButtons}</div>{lineDiscoveryResults}</section>}</>}
    {purchasePanel}
    {gatewayPanel}
    {transactionDialog}
  </FundingJourney>;
  return <div className="routePage fundingDesk">
    <header className="fundingHead">
      <div><p className="pageEyebrow">{mainnet ? "Arc mainnet · Controlled participant candidate" : guardedTestnet ? "Arc testnet · Guarded funding rehearsal" : service ? "Arc testnet · Agent funding" : "Arc testnet · Earlier candidate"}</p>
        <h1>{service ? <>Fund an agent.<br />Keep the limits.</> : "Earlier candidate"}</h1>
        <p>{service ? "Set aside USDC for an agent’s purchases. Track what it owes and reclaim eligible funds from your own wallet." : <>Shadow’s earlier testnet contract. Approved sponsors can open lines here and manage existing ones. To fund an agent without operator approval and buy a service, use <Link to="/start">Fund an agent</Link>.</>}</p>
      </div>
      {walletControls}
    </header>

    {networkHelp}

    {service && <div role="status">
      {account && unresolvedPurchase && <div className="fundingPurchaseStatus">
        <p>A purchase is unresolved. Check it before starting anything new.</p>
        <button type="button" disabled={Boolean(busy)} onClick={() => { invalidate(); setMode("manage"); setRole("agent"); setFocusPurchase(true); }}>Check payment &amp; recover result</button>
      </div>}
    </div>}

    <p className="fundingScope">{mainnet ? "Real USDC on Arc mainnet. This controlled candidate is limited to admitted sponsors, 0.10 USDC reserve and 0.005 USDC total purchases per line. Funding and purchases may be paused; repayment and eligible reclaim remain available." : guardedTestnet ? "Test USDC only. This guarded rehearsal is limited to admitted sponsors, a 0.10 test USDC reserve and 0.005 test USDC total purchases per line. Repayment is bound to the exact purchase reviewed. Funding and purchases may be paused; repayment and eligible reclaim remain available." : service ? "Use test USDC to fund an agent and buy a service. Register and approve your own budget from a browser wallet; no operator enrollment is needed. Testnet gas is paid by each wallet." : "Test USDC only. Approved sponsors can fund lines here. Circle smart wallets can be the agent; funding and repayment here use a browser wallet."}</p>
    {mainnet && <p className="fundingScope">This contract has not undergone an independent human security audit. Automated reviews and tests have been completed, but do not guarantee security. Repayment is unsecured: the sponsor bears the risk of unpaid spent principal.</p>}
    {service && !mainnet && <p className="fundingScope">Need test USDC? <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Open Circle’s faucet</a> and choose Arc testnet. The sponsor needs funds for its budget and gas; the agent needs gas to submit a purchase. Repayment needs separate test USDC from the repaying wallet. The line’s reserve cannot repay its own debt.</p>}
    {service && <div className="fundingModes" role="group" aria-labelledby="funding-role-title">
      <span id="funding-role-title">Which are you?</span>
      <button type="button" aria-pressed={role === "sponsor"} onClick={() => setRole(role === "sponsor" ? null : "sponsor")} disabled={Boolean(busy)}>I am sponsoring</button>
      <button type="button" aria-pressed={role === "agent"} onClick={() => { if (role === "agent") setRole(null); else { invalidate(); setMode("manage"); setRole("agent"); } }} disabled={Boolean(busy)}>I am the agent</button>
    </div>}
    {service && account && <section className="fundingPanel" aria-labelledby="agent-invite-title" hidden={role === "sponsor"}>
      <h2 id="agent-invite-title">Ask a sponsor to fund your agent</h2>
      <p>Share this link with your sponsor. It includes your connected wallet as the agent; they review the address and choose the budget themselves.</p>
      <div className="fundingField"><label htmlFor="agent-funding-link">Your agent funding link</label><input id="agent-funding-link" readOnly value={`${window.location.origin}${guided ? "/start/wallet" : window.location.pathname}?agent=${account}`} /></div>
      <button type="button" disabled={Boolean(busy)} onClick={() => { invalidate(); setForm(previous => ({ ...previous, agent: account })); setMode("open"); setRole(null); }}>Use my wallet as the agent</button>
    </section>}
    <div className="fundingModes" aria-label="Funding actions" hidden={role === "agent"}>
      <button type="button" aria-pressed={mode === "open"} onClick={() => { invalidate(); setMode("open"); }} disabled={Boolean(busy)}>Open a funding line</button>
      <button type="button" aria-pressed={mode === "manage"} onClick={() => { invalidate(); setMode("manage"); }} disabled={Boolean(busy)}>Manage a line</button>
    </div>

    {feedbackPanel}
    {snapshotError && !snapshot && <p className="fundingCallout" role="alert">{snapshotError}</p>}

    {recoveryPanel}

    {gatewayPanel}

    {mode === "open" ? <form className="fundingPanel" onSubmit={(event) => void review("open", event)}>
      <div className="fundingPanelHead"><div><h2>Set the purchase budget</h2><p>One agent, one approved provider, one outstanding purchase at a time.</p></div>
        {snapshot && <span className="fundingBalance">{usdc(snapshot.balance)} USDC available</span>}
      </div>
      {snapshot && !snapshot.sponsorAllowed && <p className="fundingCallout">{deployment.selfRegistration ? <>Register this wallet before funding. No token approval or transfer is included. <button type="button" disabled={!canWrite || snapshot.openingsPaused} onClick={() => void review("register")}>Review sponsor registration</button></> : "This wallet is not approved as a sponsor yet. Ask the Shadow operator to approve its public address. You can still inspect a line under “Manage a line.”"}</p>}
      {snapshot?.openingsPaused && <p className="fundingCallout">New lines are currently paused. Existing repayment and eligible reclaim remain available.</p>}
      {agentFields}
      {budgetFields}
      {timeFields}
      {riskAcknowledgment}
      <div className="fundingActions"><button className="fundingPrimary" type="submit" disabled={Boolean(busy) || openBlocker !== null} aria-describedby="funding-open-hint">Review funding line</button>
        <small id="funding-open-hint">{openBlocker ?? (!snapshot && !snapshotError ? "Checking this wallet’s sponsor status…" : "Review first. Any USDC approval and funding transaction need separate wallet confirmations.")}</small></div>
    </form> : managePanel}

    {purchasePanel}
    <footer className="fundingFoot">{service && !mainnet && <p><Link to="/funding">Manage a line on the earlier candidate</Link></p>}<p>Candidate contract: <a href={`${explorer}/address/${CANDIDATE_FUNDING.address}`} target="_blank" rel="noreferrer">{compact(CANDIDATE_FUNDING.address)}</a> · {network}</p>
      <p>Looking for the earlier integration? <Link to="/builders/v2">Open Float V2 tools</Link>.</p></footer>

    {transactionDialog}
  </div>;
}
