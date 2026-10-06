import { Link } from "react-router-dom";

const docsBaseUrl = "https://github.com/buildwithshadow/shadow/blob/main/docs";

export function BuildersPage() {
  return (
    <div className="routePage">
      <section className="pageHead">
        <p className="pageEyebrow">builders · self-service</p>
        <h1 className="pageTitle">Build with Shadow's self-service flow.</h1>
        <p className="pageLede">
          Start at /start for the public Arc testnet browser path. Sponsors fund a line; agents use their own wallet to
          make a purchase. The contract checks line limits and records debt.
        </p>
        <div className="floatHeroActions">
          <Link className="floatPrimaryAction" to="/start">
            Fund an agent
          </Link>
        </div>
      </section>

      <section className="builderFlowGrid" aria-label="Sponsor steps">
        <article className="builderFlowCard">
          <span>1</span>
          <strong>Sponsor: Connect and register</strong>
          <p>
            At /start, connect the sponsor wallet and call <code>registerSponsor()</code> on Arc testnet. No operator
            collects a wallet address or sends an enrollment token.
          </p>
        </article>
        <article className="builderFlowCard">
          <span>2</span>
          <strong>Approve the reserve</strong>
          <p>Approve the exact USDC amount, then open a line for the agent and set its provider limits.</p>
        </article>
        <article className="builderFlowCard">
          <span>3</span>
          <strong>Share and close</strong>
          <p>
            Send the agent a <code>/start?line=LINE_ID</code> link. Once debt is zero, close the line and reclaim unused
            reserve.
          </p>
        </article>
      </section>

      <section className="builderFlowGrid" aria-label="Agent steps">
        <article className="builderFlowCard">
          <span>1</span>
          <strong>Agent: Connect the agent wallet</strong>
          <p>
            Use the wallet the agent controls and select its funded line. A <code>/start?line=LINE_ID</code> link selects
            a known line; it does not grant spending rights.
          </p>
        </article>
        <article className="builderFlowCard">
          <span>2</span>
          <strong>Review and sign</strong>
          <p>Check the price, provider, sponsor, agent, and due time, then sign the purchase intent in the agent wallet.</p>
        </article>
        <article className="builderFlowCard">
          <span>3</span>
          <strong>Submit and recover</strong>
          <p>
            The agent wallet submits the transaction and pays Arc testnet gas. If the outcome is unknown, recover the
            original purchase instead of sending another.
          </p>
        </article>
      </section>

      <section className="builderReferenceGrid" aria-label="Wallet and contract limits">
        <article className="builderReferenceCard">
          <span>Wallet</span>
          <strong>What the agent needs</strong>
          <p>
            The agent needs a signing wallet, a funded onchain line, and testnet gas. Circle Agent Wallet uses a separate
            local CLI flow, not a browser connector.
          </p>
        </article>
        <article className="builderReferenceCard">
          <span>Contract</span>
          <strong>Where limits come from</strong>
          <p>
            The onchain line holds the reserve and provider limits. The contract checks purchases against that line and
            records debt, but cannot force repayment. Any wallet can repay a debt from its own USDC; only the sponsor's
            reclaim of unused reserve is enforced.
          </p>
        </article>
      </section>

      <section className="builderReferenceGrid" aria-label="Builder documentation">
        <a
          className="builderReferenceCard"
          href={`${docsBaseUrl}/SELF_SERVICE_TESTNET.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span>Browser flow</span>
          <strong>Self-service testnet</strong>
          <p>Sponsor and agent steps, wallet purchases, recovery, repayment, and line selection.</p>
        </a>
        <a
          className="builderReferenceCard"
          href={`${docsBaseUrl}/circle-agent-onboarding.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span>Circle Agent Wallet</span>
          <strong>Local onboarding</strong>
          <p>Set up the separate Arc testnet CLI handoff and use a funded line.</p>
        </a>
        <a
          className="builderReferenceCard"
          href={`${docsBaseUrl}/circle-agent-execution.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span>Circle Agent Wallet</span>
          <strong>Execution boundary</strong>
          <p>Bounded transactions, reconciliation, and local operation records.</p>
        </a>
        <a
          className="builderReferenceCard"
          href={`${docsBaseUrl}/CANDIDATE_PURCHASE_API.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span>Separate integrator design</span>
          <strong>Candidate Purchase API</strong>
          <p>These instructions describe a self-hosted service; they do not announce an available public endpoint.</p>
        </a>
        <a
          className="builderReferenceCard"
          href={`${docsBaseUrl}/AGENT_LINE_DISCOVERY.md`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span>Proposed interface</span>
          <strong>Agent line discovery</strong>
          <p>Specification only; no discovery endpoint or indexer is deployed.</p>
        </a>
      </section>
    </div>
  );
}
