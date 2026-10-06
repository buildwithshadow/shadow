export function RoadmapPage() {
  return (
    <div className="routePage">
      <section className="pageHead">
        <p className="pageEyebrow">product status</p>
        <h1 className="pageTitle">Shadow product status</h1>
        <p className="pageLede">
          Today's browser flow is self-service. The groups below separate current use, history, and open work.
        </p>
      </section>

      <section className="roadmapStatusBand" aria-label="Live now">
        <article>
          <span>Live now</span>
          <strong>Self-service browser flow</strong>
          <p>
            At /start, sponsors register themselves, approve an exact USDC amount, and open a line with provider limits.
            Agents use their own wallet and pay testnet gas. The contract records debt. Circle Agent Wallet follows a
            separate local CLI flow, not a browser connector.
          </p>
        </article>
      </section>

      <section className="roadmapGrid" aria-label="Earlier work and next">
        <article className="roadmapCard">
          <span>Earlier work</span>
          <strong>Earlier routes and proofs</strong>
          <p>
            /funding (owner-admitted candidate management) and the Float V2 integration are earlier generations and
            remain available. V2 docs record line refresh after signed spend, blocked spend, and repayment, capped by
            sponsor reserve. In a team rehearsal, testnet USDC bridged with CCTP funded a Shadow-controlled system line
            that paid CitePay and was repaid. A provider-signed receipt was recorded for one Driplet request.
          </p>
        </article>

        <article className="roadmapCard">
          <span>Next</span>
          <strong>Discovery and pilot checks</strong>
          <p>
            Agent-only line discovery is specified, but no endpoint or indexer is deployed; known-line links still work.
            Pilot criteria are three unassisted spend-and-repay cycles on separate occasions, one genuine policy block
            with no provider transfer, and a final sponsor reserve reclaim. An independent security review remains a
            separate release requirement.
          </p>
        </article>
      </section>
    </div>
  );
}
