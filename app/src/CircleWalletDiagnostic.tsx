import { useEffect, useRef, useState } from "react";
import { createPublicClient, http, isAddress, parseAbi, type Hex } from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { toCircleSmartAccount, toPasskeyTransport, toWebAuthnCredential, WebAuthnMode } from "@circle-fin/modular-wallets-core";
import { arcTestnet, PUBLIC_ARC_RPC_URL } from "./chain";
import {
  assertDiagnosticContext, assertDiagnosticSignature, diagnosticDigest, diagnosticJson,
  DIAGNOSTIC_CHAIN_ID, DIAGNOSTIC_RP_ID, DIAGNOSTIC_WALLET, WALLET_DIAGNOSTIC,
} from "./walletDiagnosticPayload";
import { candidateProbe } from "./walletCandidateProbePayload";
import { assertCircleIntentWindow, parseBoundedCircleIntent, signedCircleIntentJson } from "./walletPayableIntent";
import "./circleWalletDiagnostic.css";

type CircleAccount = Awaited<ReturnType<typeof toCircleSmartAccount>>;
const signatureAbi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const candidateAbi = parseAbi(["function hashSpendIntent((address agent,address sponsor,bytes32 lineId,uint64 lineEpoch,bytes32 termsHash,address provider,bytes32 endpointHash,uint256 principal,uint256 maximumTotalDebt,uint256 dueAt,uint256 nonce,uint256 signatureExpiry,address executor) intent) view returns (bytes32)"]);
const candidateStateAbi = parseAbi([
  "function receiptStatus(bytes32) view returns (uint8)",
  "function nonceUsed(bytes32,uint256) view returns (bool)",
  "function nonceCancelled(bytes32,uint256) view returns (bool)",
  "function spendsPaused() view returns (bool)",
  "function sponsorAllowed(address) view returns (bool)",
  "function activeLineId(address,address) view returns (bytes32)",
  "function currentTermsHash(bytes32,address) view returns (bytes32)",
  "function totalCommittedCapital() view returns (uint256)",
  "function effectiveLimits() view returns (uint256 protocolReserve,uint256 lineReserve,uint256 lineSpend,uint256 perSpend,uint256 dailySpend)",
  "function minimumRepaymentWindow() view returns (uint64)",
  "function lines(bytes32) view returns (address sponsor,address agent,uint64 epoch,uint64 expiry,uint64 maximumRepaymentWindow,uint64 day,uint64 termsVersion,uint8 state,uint256 reserveCap,uint256 availableReserve,uint256 principalOutstanding,uint256 recoveryAvailable,uint256 lineSpendCap,uint256 dailySpendCap,uint256 cumulativePrincipalPaid,uint256 spentToday,uint256 dueAt)",
  "function providerPolicies(bytes32,address) view returns (bytes32 endpointHash,uint64 expiry,uint64 day,bool active,uint256 perSpendCap,uint256 dailySpendCap,uint256 spentToday)",
  "function executeSpend((address agent,address sponsor,bytes32 lineId,uint64 lineEpoch,bytes32 termsHash,address provider,bytes32 endpointHash,uint256 principal,uint256 maximumTotalDebt,uint256 dueAt,uint256 nonce,uint256 signatureExpiry,address executor) intent,bytes signature) returns (bool paid,uint8 reason)",
]);
const candidateAddress = (import.meta.env.VITE_SHADOW_FLOAT_MAINNET_CANDIDATE || "").trim();
const candidatePayload = isAddress(candidateAddress) ? candidateProbe(candidateAddress) : null;
const client = createPublicClient({
  chain: arcTestnet,
  transport: http(import.meta.env.VITE_ARC_RPC_URL || PUBLIC_ARC_RPC_URL, { timeout: 12000, retryCount: 1 }),
});

export function CircleWalletDiagnostic() {
  const account = useRef<CircleAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Log in with the existing passkey, then sign the diagnostic message below.");
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState("");
  const [candidateEvidence, setCandidateEvidence] = useState("");
  const [candidateStatus, setCandidateStatus] = useState("Log in with the existing passkey to check a deployed candidate.");
  const [candidateError, setCandidateError] = useState("");
  const [payableSource, setPayableSource] = useState("");
  const [payableError, setPayableError] = useState("");
  const [payableStatus, setPayableStatus] = useState("Load a fresh, unsigned candidate intent before signing.");
  const [payableAcknowledged, setPayableAcknowledged] = useState(false);
  const payable = payableSource && candidatePayload
    ? (() => { try { return parseBoundedCircleIntent(payableSource, candidatePayload.typedData.domain.verifyingContract, null); } catch { return null; } })()
    : null;
  const clientKey = (import.meta.env.VITE_CIRCLE_CLIENT_KEY || "").trim();
  const clientUrl = (import.meta.env.VITE_CIRCLE_CLIENT_URL || "").trim();
  const configured = Boolean(clientKey && clientUrl);

  useEffect(() => {
    document.title = "Circle wallet check | Shadow";
    return () => { account.current = null; };
  }, []);

  async function login() {
    setBusy(true); setError(""); setEvidence(""); setCandidateEvidence(""); setCandidateError(""); setPayableError(""); setReady(false); account.current = null;
    setStatus("Waiting for your existing Circle passkey.");
    setCandidateStatus("Waiting for the existing Circle passkey.");
    try {
      const credential = await toWebAuthnCredential({
        transport: toPasskeyTransport(clientUrl, clientKey), mode: WebAuthnMode.Login,
      });
      const [chainId, code] = await Promise.all([
        client.getChainId(), client.getCode({ address: DIAGNOSTIC_WALLET }),
      ]);
      assertDiagnosticContext(credential.rpId, chainId, code);
      const owner = toWebAuthnAccount({ credential, rpId: credential.rpId });
      // Plain public RPC + explicit existing address avoids Circle's address
      // provisioning path. No bundler, paymaster or transaction client exists.
      account.current = await toCircleSmartAccount({ client, owner, address: DIAGNOSTIC_WALLET });
      setReady(true);
      setCandidateStatus("Passkey ready. The candidate's contract and intent hash will be checked before signing.");
      setStatus("Passkey ready. Signing will check whether it controls the expected account.");
    } catch (cause) {
      account.current = null;
      setError(cause instanceof Error && cause.message.startsWith("The ")
        ? cause.message
        : cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Passkey login was cancelled or timed out. You can try again."
          : "Passkey login could not complete. Check the original passkey domain and Circle connection, then retry.");
      setStatus("No diagnostic signature was produced.");
      setCandidateStatus("No candidate signature was produced.");
    } finally { setBusy(false); }
  }

  async function signAndVerify() {
    const currentAccount = account.current;
    if (!currentAccount || busy) return;
    setBusy(true); setError(""); setEvidence("");
    setStatus("Confirm the harmless diagnostic signature with your passkey.");
    try {
      const [chainId, code] = await Promise.all([
        client.getChainId(), client.getCode({ address: DIAGNOSTIC_WALLET }),
      ]);
      assertDiagnosticContext(DIAGNOSTIC_RP_ID, chainId, code);
      const signature = await currentAccount.signTypedData(WALLET_DIAGNOSTIC);
      setStatus("Checking the signature against the existing account on Arc testnet.");
      const blockNumber = await client.getBlockNumber();
      const result = await client.readContract({
        address: DIAGNOSTIC_WALLET, abi: signatureAbi, functionName: "isValidSignature",
        args: [diagnosticDigest, signature], blockNumber,
      });
      assertDiagnosticSignature(result as Hex);
      setEvidence(JSON.stringify({
        kind: "circle-modular-wallet-signature-diagnostic", verified: true,
        wallet: DIAGNOSTIC_WALLET, rpId: DIAGNOSTIC_RP_ID, origin: window.location.origin,
        chainId: DIAGNOSTIC_CHAIN_ID, blockNumber: blockNumber.toString(),
        digest: diagnosticDigest, signature, erc1271Result: result,
        checkedAt: new Date().toISOString(), payload: JSON.parse(diagnosticJson),
        scope: "Existing Modular Wallet signing only; candidate purchase and provider compatibility remain untested.",
      }, null, 2));
      setStatus("Verified: this passkey signed for the existing Circle smart account. No transaction was sent.");
    } catch (cause) {
      setError(cause instanceof Error && (cause.message.startsWith("The ") || cause.message.startsWith("This signature"))
        ? cause.message
        : cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Signing was cancelled or timed out. No transaction was sent."
          : "Signature verification did not complete. Retry or check the Arc testnet connection. No transaction was sent.");
      setStatus("The diagnostic has not passed.");
    } finally { setBusy(false); }
  }

  async function signCandidateProbe() {
    const currentAccount = account.current;
    if (!currentAccount || !candidatePayload || busy) return;
    setBusy(true); setCandidateError(""); setCandidateEvidence("");
    setCandidateStatus("Checking the deployed candidate before asking your passkey to sign a zero-principal intent.");
    try {
      const candidate = candidatePayload.typedData.domain.verifyingContract;
      const [chainId, walletCode, candidateCode] = await Promise.all([
        client.getChainId(), client.getCode({ address: DIAGNOSTIC_WALLET }), client.getCode({ address: candidate }),
      ]);
      assertDiagnosticContext(DIAGNOSTIC_RP_ID, chainId, walletCode);
      if (!candidateCode || candidateCode === "0x") throw new Error("The configured candidate has no deployed code. No intent was signed.");
      const onchainDigest = await client.readContract({
        address: candidate, abi: candidateAbi, functionName: "hashSpendIntent", args: [candidatePayload.typedData.message],
      });
      if (onchainDigest !== candidatePayload.digest) throw new Error("The candidate's SpendIntent hash differs from the local hash. No intent was signed.");
      setCandidateStatus("Confirm the zero-principal, expired SpendIntent signature with your passkey.");
      const signature = await currentAccount.signTypedData(candidatePayload.typedData);
      const blockNumber = await client.getBlockNumber();
      const result = await client.readContract({
        address: DIAGNOSTIC_WALLET, abi: signatureAbi, functionName: "isValidSignature",
        args: [candidatePayload.digest, signature], account: candidate, blockNumber,
      });
      assertDiagnosticSignature(result as Hex);
      setCandidateEvidence(JSON.stringify({
        kind: "circle-modular-wallet-candidate-spend-intent-probe", verified: true,
        wallet: DIAGNOSTIC_WALLET, candidate, chainId, blockNumber: blockNumber.toString(),
        digest: candidatePayload.digest, erc1271Result: result, signature,
        checkedAt: new Date().toISOString(), payload: JSON.parse(candidatePayload.json),
        scope: "Exact candidate SpendIntent schema and ERC-1271 caller-context compatibility only; zero principal, nonexistent line and expired signature. No transaction, purchase or provider payment.",
      }, null, 2));
      setCandidateStatus("Verified: the existing Circle wallet signed the candidate's non-executable SpendIntent. No transaction was sent.");
    } catch (cause) {
      setCandidateError(cause instanceof Error && (cause.message.startsWith("The ") || cause.message.startsWith("This signature"))
        ? cause.message
        : cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Signing was cancelled or timed out. No transaction was sent."
          : "The candidate signature check did not complete. No transaction was sent.");
      setCandidateStatus("The candidate signing probe has not passed.");
    } finally { setBusy(false); }
  }

  async function loadPayableIntent(file: File | undefined) {
    setPayableSource(""); setPayableError(""); setPayableAcknowledged(false);
    if (!file) return;
    try {
      if (file.size > 64_000) throw new Error("Intent file is too large.");
      const source = await file.text();
      if (!candidatePayload) throw new Error("Candidate contract is not configured.");
      parseBoundedCircleIntent(source, candidatePayload.typedData.domain.verifyingContract, null);
      setPayableSource(source);
      setPayableStatus("Check the exact testnet recipient, amount and expiry below before signing.");
    } catch (cause) {
      setPayableError(cause instanceof Error ? cause.message : "Intent file could not be checked.");
      setPayableStatus("No payable intent loaded.");
    }
  }

  async function signPayableIntent() {
    const currentAccount = account.current;
    if (!currentAccount || !candidatePayload || !payableSource || !payableAcknowledged || busy) return;
    setBusy(true); setPayableError("");
    try {
      const intent = parseBoundedCircleIntent(payableSource, candidatePayload.typedData.domain.verifyingContract, null);
      const [chainId, walletCode, candidateCode, onchainDigest, receiptStatus, nonceUsed, nonceCancelled,
        liveBlock, paused, sponsorAllowed, activeLineId, termsHash, committed, limits, minimumWindow, line, policy] = await Promise.all([
        client.getChainId(), client.getCode({ address: DIAGNOSTIC_WALLET }),
        client.getCode({ address: intent.candidate }),
        client.readContract({ address: intent.candidate, abi: candidateAbi, functionName: "hashSpendIntent", args: [intent.typedData.message] }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "receiptStatus", args: [intent.digest] }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "nonceUsed", args: [intent.lineId, intent.typedData.message.nonce] }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "nonceCancelled", args: [intent.lineId, intent.typedData.message.nonce] }),
        client.getBlock(),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "spendsPaused" }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "sponsorAllowed", args: [intent.sponsor] }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "activeLineId", args: [intent.sponsor, DIAGNOSTIC_WALLET] }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "currentTermsHash", args: [intent.lineId, intent.provider] }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "totalCommittedCapital" }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "effectiveLimits" }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "minimumRepaymentWindow" }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "lines", args: [intent.lineId] }),
        client.readContract({ address: intent.candidate, abi: candidateStateAbi, functionName: "providerPolicies", args: [intent.lineId, intent.provider] }),
      ]);
      assertDiagnosticContext(DIAGNOSTIC_RP_ID, chainId, walletCode);
      if (!candidateCode || candidateCode === "0x") throw new Error("Candidate contract is not deployed.");
      if (onchainDigest.toLowerCase() !== intent.digest.toLowerCase()) throw new Error("Candidate contract returned a different intent hash.");
      if (receiptStatus !== 0 || nonceUsed || nonceCancelled) throw new Error("This intent is already used, cancelled or has a receipt. Build a fresh one.");
      // The browser clock is only useful for early display. Arc's block time
      // controls the real 20-minute authorization bound before passkey signing.
      parseBoundedCircleIntent(payableSource, intent.candidate, liveBlock.timestamp);
      const message = intent.typedData.message;
      const amount = intent.principal;
      const day = liveBlock.timestamp / 86_400n;
      const lineSpent = line[5] === day ? line[15] : 0n;
      const providerSpent = policy[2] === day ? policy[6] : 0n;
      assertCircleIntentWindow(message, policy[1], minimumWindow, liveBlock.timestamp);
      if (paused || !sponsorAllowed || activeLineId.toLowerCase() !== intent.lineId.toLowerCase() ||
          line[0].toLowerCase() !== intent.sponsor.toLowerCase() || line[1].toLowerCase() !== DIAGNOSTIC_WALLET.toLowerCase() ||
          line[2] !== message.lineEpoch || line[7] !== 1 || termsHash.toLowerCase() !== message.termsHash.toLowerCase() ||
          liveBlock.timestamp > line[3] || !policy[3] ||
          policy[0].toLowerCase() !== message.endpointHash.toLowerCase() ||
          message.dueAt > liveBlock.timestamp + line[4] || message.dueAt > line[3] ||
          committed > limits[0] || line[8] > limits[1] || amount > line[9] ||
          amount > limits[2] || line[14] + amount > line[12] || line[14] + amount > limits[2] ||
          amount > policy[4] || amount > limits[3] ||
          lineSpent + amount > line[13] || lineSpent + amount > limits[4] ||
          providerSpent + amount > policy[5]) {
        throw new Error("Live candidate state predicts a blocked or invalid spend. Refresh the line and build a new intent before signing.");
      }
      setPayableStatus("Confirm this bounded Arc testnet purchase authorization with your passkey.");
      const signature = await currentAccount.signTypedData(intent.typedData);
      const simulation = await client.simulateContract({
        address: intent.candidate, abi: candidateStateAbi, functionName: "executeSpend",
        args: [message, signature], account: intent.executor,
      });
      if (!simulation.result[0] || simulation.result[1] !== 0) {
        throw new Error("The signed purchase did not simulate a paid provider outcome. No signature was downloaded.");
      }
      const blockNumber = await client.getBlockNumber();
      const [block, result] = await Promise.all([
        client.getBlock({ blockNumber }),
        client.readContract({ address: DIAGNOSTIC_WALLET, abi: signatureAbi, functionName: "isValidSignature",
          args: [intent.digest, signature], account: intent.candidate, blockNumber }),
      ]);
      assertDiagnosticSignature(result as Hex);
      // Phone approval may take time. Keep the same minimum handoff window
      // after signing that was required before the passkey prompt.
      parseBoundedCircleIntent(payableSource, intent.candidate, block.timestamp);
      // Preserve the CLI's signed-intent format so its preflight and submit
      // commands can validate the exact original payload and signature.
      const signedIntent = signedCircleIntentJson(payableSource, signature);
      const url = URL.createObjectURL(new Blob([signedIntent], { type: "application/json" }));
      const download = document.createElement("a");
      download.href = url;
      download.download = `shadow-circle-testnet-signed-intent-${intent.digest.slice(2, 10)}.json`;
      download.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPayableStatus(`Signature verified at block ${blockNumber} (ERC-1271 ${result}) and signed intent downloaded. This page sent no transaction; give the saved file only to your test executor.`);
    } catch (cause) {
      setPayableError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "Passkey signing was cancelled or timed out. No transaction was sent."
        : cause instanceof Error ? cause.message : "The testnet intent could not be signed. No transaction was sent.");
      setPayableStatus("The payable intent has not been handed to the executor.");
    } finally { setBusy(false); }
  }

  function reset() {
    account.current = null; setReady(false); setEvidence(""); setCandidateEvidence(""); setCandidateError(""); setError("");
    setPayableSource(""); setPayableError(""); setPayableAcknowledged(false);
    setStatus("Disconnected. The in-memory wallet session has been cleared.");
    setCandidateStatus("Disconnected. Log in again to check a deployed candidate.");
  }

  return <main className="walletDiagnostic">
    <a href="/">Back to Shadow</a>
    <p className="walletDiagnosticEyebrow">Arc testnet · Existing Circle Modular Wallet</p>
    <h1>Check your Circle wallet</h1>
    <p>Confirm that your existing passkey can sign for this wallet. The fixed message below cannot make a purchase, transfer funds or approve spending.</p>
    <dl>
      <dt>Expected account</dt><dd>{DIAGNOSTIC_WALLET}</dd>
      <dt>Original passkey domain</dt><dd>{DIAGNOSTIC_RP_ID}</dd>
    </dl>
    <p>This check keeps the wallet session in memory until you disconnect or close the page. It does not prove the candidate purchase or provider workflow.</p>
    {!configured && <p role="alert">Circle login is not configured for this deployment. The existing Circle client configuration must be present before this check can run.</p>}
    <div className="walletDiagnosticActions" aria-busy={busy}>
      <button type="button" onClick={login} disabled={busy || !configured}>Log in with existing passkey</button>
      <button type="button" onClick={signAndVerify} disabled={busy || !ready} aria-describedby="wallet-check-status">Sign diagnostic and verify</button>
      <button type="button" onClick={reset} disabled={busy || !ready}>Disconnect</button>
    </div>
    <p id="wallet-check-status" role="status" aria-live="polite">{status}</p>
    {error && <p className="walletDiagnosticError" role="alert">{error}</p>}
    <h2>Message to sign</h2>
    <pre tabIndex={0} aria-label="Exact diagnostic typed data">{diagnosticJson}</pre>
    {candidatePayload && <section aria-labelledby="wallet-candidate-probe">
      <h2 id="wallet-candidate-probe">Candidate signing probe</h2>
      <p>The message below uses the candidate's exact SpendIntent fields, but its amount is zero, its line does not exist and its signature expired long ago. Signing it cannot pay a provider. The check reads the deployed candidate's hash and verifies your wallet signature without sending a transaction.</p>
      <p>Configured candidate: <code>{candidatePayload.typedData.domain.verifyingContract}</code></p>
      <details><summary>View exact non-executable message</summary>
        <pre tabIndex={0} aria-label="Exact non-executable candidate typed data">{candidatePayload.json}</pre>
      </details>
      <button type="button" onClick={signCandidateProbe} disabled={busy || !ready} aria-describedby="wallet-candidate-status">Sign candidate no-spend probe</button>
      <p id="wallet-candidate-status" role="status" aria-live="polite">{candidateStatus}</p>
      {candidateError && <p className="walletDiagnosticError" role="alert">{candidateError}</p>}
      {candidateEvidence && <div aria-labelledby="wallet-candidate-result">
        <h3 id="wallet-candidate-result">Verified candidate signing evidence</h3>
        <label htmlFor="wallet-candidate-evidence">Public no-spend signature evidence</label>
        <textarea id="wallet-candidate-evidence" readOnly value={candidateEvidence} rows={14} />
      </div>}
    </section>}
    {candidatePayload && <section aria-labelledby="wallet-payable-intent">
      <h2 id="wallet-payable-intent">Bounded testnet purchase authorization</h2>
      <p>Load a fresh Shadow candidate intent prepared for your existing Circle wallet. This page signs and verifies it, then downloads the signature. It does not submit a payment. The named executor can use that signature before it expires to pay the named provider from the sponsor's testnet USDC reserve.</p>
      <label htmlFor="wallet-payable-file">Unsigned intent JSON</label>
      <input id="wallet-payable-file" type="file" accept=".json,application/json" disabled={busy}
        onChange={(event) => void loadPayableIntent(event.target.files?.[0])} aria-describedby="wallet-payable-status" />
      {payable && <dl>
        <dt>Network and contract</dt><dd>Arc testnet · {payable.candidate}</dd>
        <dt>Agent wallet</dt><dd>{DIAGNOSTIC_WALLET}</dd>
        <dt>Sponsor</dt><dd>{payable.sponsor}</dd>
        <dt>Provider to be paid</dt><dd>{payable.provider}</dd>
        <dt>Maximum provider payment</dt><dd>{(Number(payable.principal) / 1_000_000).toFixed(6)} testnet USDC</dd>
        <dt>Authorization expires</dt><dd>{new Date(Number(payable.signatureExpiry) * 1000).toLocaleString()}</dd>
        <dt>Intent digest</dt><dd>{payable.digest}</dd>
      </dl>}
      {payable && <label className="walletDiagnosticConfirm">
        <input type="checkbox" checked={payableAcknowledged} onChange={(event) => setPayableAcknowledged(event.target.checked)} />
        <span>I checked the testnet contract, provider, amount and expiry. I understand this signature can authorize that one provider payment.</span>
      </label>}
      <button type="button" onClick={() => void signPayableIntent()} disabled={busy || !ready || !payable || !payableAcknowledged}
        aria-describedby="wallet-payable-status">Sign bounded testnet intent</button>
      <p id="wallet-payable-status" role="status" aria-live="polite">{payableStatus}</p>
      {payableError && <p className="walletDiagnosticError" role="alert">{payableError}</p>}
    </section>}
    {evidence && <section aria-labelledby="wallet-check-result">
      <h2 id="wallet-check-result">Verified diagnostic evidence</h2>
      <label htmlFor="wallet-check-evidence">Public account and harmless signature evidence</label>
      <textarea id="wallet-check-evidence" readOnly value={evidence} rows={14} />
    </section>}
  </main>;
}
