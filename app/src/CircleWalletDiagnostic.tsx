import { useEffect, useRef, useState } from "react";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { toCircleSmartAccount, toPasskeyTransport, toWebAuthnCredential, WebAuthnMode } from "@circle-fin/modular-wallets-core";
import { arcTestnet, PUBLIC_ARC_RPC_URL } from "./chain";
import {
  assertDiagnosticContext, assertDiagnosticSignature, diagnosticDigest, diagnosticJson,
  DIAGNOSTIC_CHAIN_ID, DIAGNOSTIC_RP_ID, DIAGNOSTIC_WALLET, WALLET_DIAGNOSTIC,
} from "./walletDiagnosticPayload";
import "./circleWalletDiagnostic.css";

type CircleAccount = Awaited<ReturnType<typeof toCircleSmartAccount>>;
const signatureAbi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
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
  const clientKey = (import.meta.env.VITE_CIRCLE_CLIENT_KEY || "").trim();
  const clientUrl = (import.meta.env.VITE_CIRCLE_CLIENT_URL || "").trim();
  const configured = Boolean(clientKey && clientUrl);

  useEffect(() => {
    document.title = "Circle wallet check | Shadow";
    return () => { account.current = null; };
  }, []);

  async function login() {
    setBusy(true); setError(""); setEvidence(""); setReady(false); account.current = null;
    setStatus("Waiting for your existing Circle passkey.");
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
      setStatus("Passkey ready. Signing will check whether it controls the expected account.");
    } catch (cause) {
      account.current = null;
      setError(cause instanceof Error && cause.message.startsWith("The ")
        ? cause.message
        : cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Passkey login was cancelled or timed out. You can try again."
          : "Passkey login could not complete. Check the original passkey domain and Circle connection, then retry.");
      setStatus("No diagnostic signature was produced.");
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

  function reset() {
    account.current = null; setReady(false); setEvidence(""); setError("");
    setStatus("Disconnected. The in-memory wallet session has been cleared.");
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
    {evidence && <section aria-labelledby="wallet-check-result">
      <h2 id="wallet-check-result">Verified diagnostic evidence</h2>
      <label htmlFor="wallet-check-evidence">Public account and harmless signature evidence</label>
      <textarea id="wallet-check-evidence" readOnly value={evidence} rows={14} />
    </section>}
  </main>;
}
