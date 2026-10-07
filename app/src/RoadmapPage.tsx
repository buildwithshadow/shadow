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
            At /start, the public testnet browser flow lets sponsors register themselves, approve an exact USDC amount,
            and open a line with provider limits. Agents use their own wallet and pay testnet gas. The contract records
            debt. Circle Agent Wallet follows a separate local CLI flow, not a browser connector.
          </p>
        </article>
      </section>

      <section className="roadmapGrid" aria-label="Matured and next">
        <article className="roadmapCard">
          <span>matured</span>
          <strong>External sponsor capital</strong>
          <p>CitePay and Forum Tollgate opened external sponsored lines; Forum also proved reserve reclaim and reopen.</p>
        </article>
        <article className="roadmapCard">
          <span>matured</span>
          <strong>Autonomous line scoring</strong>
          <p>Sponsored lines are re-scored by ShadowFloat from recorded paid, blocked, and repaid behavior after each action.</p>
        </article>
        <article className="roadmapCard">
          <span>matured</span>
          <strong>CCTP-funded reserve</strong>
          <p>Sepolia USDC was burned, minted on Arc, locked as a Float reserve, drawn to pay CitePay, and repaid.</p>
        </article>
        <article className="roadmapCard">
          <span>matured</span>
          <strong>Provider delivery receipts</strong>
          <p>
            CitePay signed a delivery receipt for a Driplet-paid request, and ShadowFloat recorded it onchain.
            Standardizing that receipt across every provider remains next.
          </p>
        </article>
        <article className="roadmapCard">
          <span>next</span>
          <strong>Production-grade mandate custody</strong>
          <p>
            Move M1 adapter allocation into a withdrawable custody model with cleaner release rules and stronger
            execution accountability.
          </p>
        </article>
        <article className="roadmapCard">
          <span>next</span>
          <strong>More independent providers</strong>
          <p>
            Expand from CitePay-style paid answers into more data, scan, compute, and API services that agents can buy
            through Float.
          </p>
        </article>
        <article className="roadmapCard">
          <span>next</span>
          <strong>Deeper sponsor controls</strong>
          <p>
            Give sponsors clearer dashboards for daily limits, provider mandates, reserve reclaim, defaults, and risk
            exposure.
          </p>
        </article>
        <article className="roadmapCard">
          <span>Future mainnet</span>
          <strong>Treasury reserve model</strong>
          <p>
            Define reserve providers, fee policy, and default handling for larger spending lines without weakening the
            reserve floor. Mainnet is currently paused after one controlled rehearsal: a one-off team cycle on the
            guarded mainnet contract.
          </p>
        </article>
      </section>
      <p>
        <strong>Current status.</strong> Agent-only line discovery is specified, but no endpoint or indexer is deployed.
        Pilot criteria are three unassisted spend-and-repay cycles on separate occasions, one genuine policy block with
        no provider transfer, and a final sponsor reserve reclaim.
      </p>
    </div>
  );
}
