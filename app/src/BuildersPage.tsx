import { Link } from "react-router-dom";

const docsBaseUrl = "https://github.com/buildwithshadow/shadow/blob/main/docs";

export function BuildersPage() {
  return (
    <div className="routePage">
      <section className="pageHead">
        <p className="pageEyebrow">builders · self-service</p>
        <h1 className="pageTitle">Build with Shadow's self-service flow.</h1>
        <p className="pageLede">
          The public browser flow starts at /start on Arc testnet: a sponsor funds a line, an agent submits and repays a
          purchase, then the sponsor closes the line and reclaims the remaining reserve.
        </p>
        <div className="floatHeroActions">
          <Link className="floatPrimaryAction builderPrimaryAction" to="/start">
            Fund an agent
          </Link>
        </div>
      </section>

      <section className="builderFlowGrid" aria-label="Sponsor steps">
        <article className="builderFlowCard">
          <span>1</span>
          <strong>Connect and register</strong>
          <p>
            Connect the sponsor wallet at /start on Arc testnet and call <code>registerSponsor()</code>. This free
            self-registration call moves or approves no tokens; testnet gas still applies. No operator collects an
            address or sends an enrollment token.
          </p>
        </article>
        <article className="builderFlowCard">
          <span>2</span>
          <strong>Approve, then open the line</strong>
          <p>
            Have test USDC for the reserve and gas. Approve the exact reserve amount; this wallet approval lets the
            contract take that amount but does not open the line. Then separately confirm opening: the contract moves
            reserve into the line and applies the agent and provider limits. Money spent on purchases is unsecured
            credit to the agent operator. If nobody repays, the sponsor cannot reclaim that spent principal; only
            unused reserve and whatever is repaid can be reclaimed.
          </p>
        </article>
        <article className="builderFlowCard">
          <span>3</span>
          <strong>Share the line link</strong>
          <p>
            After the line opens, share its <code>/start?line=LINE_ID</code> link with the agent. The link selects a
            known line; it does not grant spending rights.
          </p>
        </article>
      </section>

      <section className="builderFlowGrid" aria-label="Complete the first cycle">
        <article className="builderFlowCard">
          <span>4</span>
          <strong>Connect the agent wallet</strong>
          <p>
            Connect the agent's signing wallet and open the sponsor's line link. The link selects a known line but does
            not grant spending rights; loading it checks the line onchain. The agent needs testnet gas to submit a
            purchase.
          </p>
        </article>
        <article className="builderFlowCard">
          <span>5</span>
          <strong>Review and sign</strong>
          <p>
            Check the price, provider, sponsor, agent, and due time, then sign the purchase intent in the agent wallet.
            The signature authorizes those reviewed terms; it does not submit the transaction. Next, submit that request.
          </p>
        </article>
        <article className="builderFlowCard">
          <span>6</span>
          <strong>Submit and recover</strong>
          <p>
            The agent wallet submits the transaction and pays Arc testnet gas. If the outcome is unknown, recover the
            original purchase instead of submitting another; recovery checks the original payment and retrieves its
            result.
          </p>
        </article>
        <article className="builderFlowCard">
          <span>7</span>
          <strong>Repay the purchase</strong>
          <p>
            Repay the full purchase debt from any wallet's own test USDC. The line's reserve cannot repay its own debt,
            so the paying wallet needs separate test USDC. If needed, its approval authorizes the exact repayment
            amount; then confirm repayment. Repayment restores reserve but does not reset the total purchase limit.
          </p>
        </article>
        <article className="builderFlowCard">
          <span>8</span>
          <strong>Sponsor: close and reclaim</strong>
          <p>
            Once debt is zero, the sponsor connects its wallet, closes the line, and reclaims the remaining reserve.
            If debt becomes overdue and remains unpaid, spent principal remains a loss. Declaring a default is not an
            action in the app today.
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
            records debt, but cannot force repayment. Any wallet can repay a debt from its own USDC.
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
      <p><small><Link className="builderLegacyTools" to="/builders/v2">Float V2 tools (earlier contract)</Link></small></p>
    </div>
  );
}
