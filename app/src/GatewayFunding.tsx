import { useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Address,
} from "viem";
import {
  candidateFundingChain,
  createCandidateFundingKit,
  candidateErrorMessage,
  type CandidateDeployment,
} from "./candidateFunding";
import {
  createGatewayBrowserFunding,
  type GatewayPlan,
  type GatewayRecord,
} from "../scripts/gateway-reserve-browser-funding.mjs";
import { findSentTransactionHash } from "./savedTransactionLookup";
import { createGatewayBrowserJournal } from "../scripts/gateway-reserve-browser-journal.mjs";

const primary = createPublicClient({
  chain: candidateFundingChain,
  transport: http("https://rpc.testnet.arc.network", {
    retryCount: 0,
    timeout: 15000,
  }),
});
const second = createPublicClient({
  chain: candidateFundingChain,
  transport: http("https://rpc.blockdaemon.testnet.arc.io", {
    retryCount: 0,
    timeout: 15000,
  }),
});
export function GatewayFunding({
  account,
  correctNetwork,
  deployment,
  reserve,
  busy,
  setBusy,
  onHold,
  onReady,
}: {
  account: Address | null;
  correctNetwork: boolean;
  deployment: CandidateDeployment;
  reserve: string;
  busy: string;
  setBusy(value: string): void;
  onHold(value: boolean): void;
  onReady(): void;
}) {
  const [plan, setPlan] = useState<GatewayPlan | null>(null),
    [record, setRecord] = useState<GatewayRecord | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [hash, setHash] = useState("");
  const [expanded, setExpanded] = useState(false),
    [ack, setAck] = useState(false);
  const inFlight = useRef(false),
    generation = useRef(0),
    automaticChecks = useRef({ key: "", count: 0 });
  const setup = useMemo(() => {
    try {
      return {
        engine:
          account && window.ethereum
            ? createGatewayBrowserFunding({
                account,
                wallet: createWalletClient({
                  account,
                  chain: candidateFundingChain,
                  transport: custom(window.ethereum),
                }),
                clients: [primary, second],
                journal: createGatewayBrowserJournal({ account }),
              })
            : null,
        error: "",
      };
    } catch (cause) {
      return { engine: null, error: candidateErrorMessage(cause) };
    }
  }, [account]);
  const engine = setup.engine;
  useEffect(() => {
    generation.current++;
    setPlan(null);
    setAck(false);
    setHash("");
    setNotice("");
    setError(setup.error);
    const refresh = () => {
      try {
        const saved = engine?.load() ?? null;
        setRecord(saved);
        if (saved) {
          setExpanded(true);
          setPlan(saved);
        }
        onHold(
          Boolean(
            saved && saved.steps.mint?.evidence?.event !== "AttestationUsed",
          ),
        );
      } catch (cause) {
        setError(candidateErrorMessage(cause));
        onHold(true);
      }
    };
    refresh();
    window.addEventListener("storage", refresh);
    return () => {
      generation.current++;
      window.removeEventListener("storage", refresh);
    };
  }, [engine, setup.error, onHold]);
  useEffect(() => {
    if (!record) {
      setPlan(null);
      setAck(false);
    }
  }, [reserve, record]);
  const funded = record?.steps.mint?.evidence?.event === "AttestationUsed";
  const rejected = record?.steps.mint?.evidence?.notSubmitted === true;
  const authorized = record?.steps.attestation?.status === "confirmed";
  const unresolvedMint = Boolean(record?.steps.mint && !funded && !rejected);
  const unresolvedApi = Boolean(record?.steps.attestation && !authorized);
  useEffect(() => {
    const key = record?.steps.mint
      ? `${account}:${record.operation}:${record.steps.mint.request?.nonce}`
      : null;
    if (!key || !unresolvedMint || busy || !correctNetwork || hash) return;
    if (automaticChecks.current.key !== key)
      automaticChecks.current = { key, count: 0 };
    if (automaticChecks.current.count >= 6) return;
    const timer = window.setTimeout(() => {
      automaticChecks.current.count++;
      void action("recover");
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [record, busy, correctNetwork, unresolvedMint, hash]);
  async function action(
    kind: "quote" | "authorize" | "mint" | "recover" | "archive",
  ) {
    if (!account || !engine || !correctNetwork || busy || inFlight.current)
      return;
    inFlight.current = true;
    const revision = generation.current;
    setError("");
    setNotice("");
    setBusy(
      kind === "quote"
        ? "Checking Gateway balance and fee…"
        : kind === "authorize"
          ? "Review the Gateway funding authorization in your wallet…"
          : kind === "mint"
            ? "Review the Gateway withdrawal in your wallet…"
            : "Checking the original Gateway transaction…",
    );
    try {
      if (!navigator.locks)
        throw Error(
          "This browser cannot coordinate wallet actions across tabs.",
        );
      const journal = createCandidateFundingKit(
        deployment,
      ).createCandidateJournal(window.localStorage, account);
      await navigator.locks.request(
        journal.key,
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw Error(
              "Another Shadow tab is using this wallet. Finish there first.",
            );
          if (kind !== "recover" && kind !== "archive") {
            if (journal.load())
              throw Error(
                "Resolve the earlier Shadow wallet transaction before using Gateway.",
              );
            const purchase = window.localStorage.getItem(
              `shadow.public-purchase.v1:${deployment.chainId}:${getAddress(deployment.address)}:${getAddress(account)}`,
            );
            if (purchase && JSON.parse(purchase).stage !== "delivered")
              throw Error(
                "Resolve and archive the earlier purchase before using Gateway.",
              );
          }
          if (kind === "quote") {
            if (!/^\d+(\.\d{1,6})?$/.test(reserve))
              throw Error(
                "Enter a USDC budget with at most six decimal places.",
              );
            const result = await engine.quote(
              parseUnits(reserve, 6).toString(),
            );
            if (generation.current === revision) {
              setPlan(result);
              setAck(false);
            }
          } else if (kind === "archive") {
            await engine.archive();
            if (generation.current === revision) {
              setPlan(null);
              setAck(false);
              setHash("");
              setNotice(
                "Verified withdrawal archived. You can check another Gateway amount when ready.",
              );
            }
          } else if (kind === "authorize") {
            if (!plan || !ack)
              throw Error("Review and acknowledge the Gateway fee first.");
            const result = await engine.authorize(plan);
            if (generation.current === revision)
              setNotice(
                result.status === "confirmed"
                  ? "Authorization confirmed. Withdraw the quoted amount to this wallet next."
                  : "Gateway did not return a confirmed result. Keep this operation; do not authorize another.",
              );
          } else {
            let originalHash = hash || undefined;
            const pending = engine.load()?.steps.mint;
            if (
              kind === "recover" &&
              !originalHash &&
              !pending?.response?.hash &&
              pending?.request?.nonce !== undefined
            ) {
              originalHash =
                (await findSentTransactionHash({
                  chainId: deployment.chainId,
                  account,
                  nonce: Number(pending.request.nonce),
                  readNextNonce: () =>
                    primary.getTransactionCount({
                      address: account,
                      blockTag: "latest",
                    }),
                })) ?? undefined;
            }
            const result =
              kind === "mint"
                ? await engine.mint()
                : await engine.recover(originalHash);
            if (generation.current === revision) {
              setNotice(
                result.evidence?.notSubmitted
                  ? "No mint transaction was submitted. Review and confirm again when ready."
                  : result.evidence?.event === "AttestationUsed"
                    ? "Gateway withdrawal confirmed. Review the funding line below to set this USDC aside for your agent."
                    : result.status === "confirmed"
                      ? "Gateway authorization confirmed. Withdraw to your wallet next."
                      : "Still unresolved. Check the original operation; no replacement was sent.",
              );
              if (result.evidence?.event === "AttestationUsed") onReady();
            }
          }
        },
      );
    } catch (cause) {
      if (generation.current === revision)
        setError(candidateErrorMessage(cause));
    } finally {
      if (generation.current === revision) {
        try {
          const saved = engine.load();
          setRecord(saved);
          if (saved) setPlan(saved);
          onHold(
            Boolean(
              saved && saved.steps.mint?.evidence?.event !== "AttestationUsed",
            ),
          );
        } catch (cause) {
          setError(candidateErrorMessage(cause));
          onHold(true);
        }
      }
      inFlight.current = false;
      setBusy("");
    }
  }
  return (
    <section className="fundingPanel" aria-labelledby="gateway-heading">
      <h2 id="gateway-heading">Use a Gateway balance</h2>
      <p>
        Already hold USDC in Circle Gateway on Arc testnet? Withdraw it to this
        sponsor wallet, then fund the agent’s line below. You can also fund
        directly from your wallet.
      </p>
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
      >
        {" "}
        {expanded ? "Hide Gateway details" : "Use Gateway funds"}{" "}
      </button>
      {expanded && (
        <div>
          <p>
            Arc testnet only · Up to 0.10 test USDC per operation. Gateway fees
            and wallet gas are separate. This route uses an existing Gateway
            balance; it does not deposit your wallet funds into Gateway.
          </p>
          {!account && (
            <p>Connect your wallet above to check your Gateway balance.</p>
          )}
          {account && !correctNetwork && (
            <p>Switch to Arc testnet using the wallet control above.</p>
          )}
          {!record && (
            <button
              type="button"
              disabled={!account || !correctNetwork || Boolean(busy) || !engine}
              onClick={() => void action("quote")}
            >
              Check Gateway balance and fee
            </button>
          )}
          {plan && (
            <>
              <dl className="fundingDetails">
                <div>
                  <dt>To this wallet</dt>
                  <dd>
                    {formatUnits(BigInt(plan.intent.spec.value), 6)} test USDC
                  </dd>
                </div>
                <div>
                  <dt>Maximum Gateway fee</dt>
                  <dd>
                    {formatUnits(BigInt(plan.intent.maxFee), 6)} test USDC
                  </dd>
                </div>
              </dl>
              {!record?.steps.attestation && (
                <>
                  <label className="fundingCheck">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                      disabled={Boolean(busy)}
                    />
                    <span>
                      I approve this amount and maximum Gateway fee. I will keep
                      this page open through withdrawal. If confirmation is
                      lost, I will recover this operation rather than start
                      another.
                    </span>
                  </label>
                  <button
                    type="button"
                    disabled={!ack || !correctNetwork || Boolean(busy)}
                    onClick={() => void action("authorize")}
                  >
                    Authorize Gateway withdrawal
                  </button>
                </>
              )}
            </>
          )}
          {authorized && !funded && !unresolvedMint && (
            <button
              type="button"
              disabled={!correctNetwork || Boolean(busy)}
              onClick={() => void action("mint")}
            >
              {rejected
                ? "Review withdrawal again"
                : "Withdraw to sponsor wallet"}
            </button>
          )}
          {(unresolvedMint || unresolvedApi) && (
            <div className="fundingRecovery">
              <p>
                Keep this browser’s site data. A timeout is not proof of
                failure, so another funding attempt is blocked.
              </p>
              {unresolvedMint && (
                <>
                  <div className="fundingField">
                    <label htmlFor="gateway-original-hash">
                      Original mint transaction hash (optional; we also look it
                      up automatically)
                    </label>
                    <input
                      id="gateway-original-hash"
                      value={hash}
                      onChange={(e) => setHash(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={Boolean(busy) || !correctNetwork}
                    onClick={() => void action("recover")}
                  >
                    Check original withdrawal
                  </button>
                </>
              )}
              {unresolvedApi && (
                <>
                  <p>
                    The Gateway authorization response is unresolved. Preserve
                    this record and ask for help recovering the original
                    transfer; do not sign a replacement.
                  </p>
                  <button
                    type="button"
                    disabled={Boolean(busy) || !correctNetwork}
                    onClick={() => void action("recover")}
                  >
                    Check original authorization
                  </button>
                </>
              )}
            </div>
          )}
          {funded && (
            <p className="fundingSuccess">
              Gateway withdrawal confirmed. The USDC is in your wallet; it
              becomes the agent’s reserve only after you open the funding line
              below.
            </p>
          )}
          {funded && (
            <button
              type="button"
              disabled={Boolean(busy) || !correctNetwork}
              onClick={() => void action("archive")}
            >
              Archive verified withdrawal
            </button>
          )}
          {(record?.steps.mint?.response?.hash ||
            record?.steps.mint?.evidence?.hash) && (
            <a
              href={`https://testnet.arcscan.app/tx/${record.steps.mint.response?.hash ?? record.steps.mint.evidence?.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              View Gateway withdrawal
            </a>
          )}
        </div>
      )}
      <div role="status" aria-live="polite">
        {notice}
      </div>
      <div role="alert">{error}</div>
    </section>
  );
}
