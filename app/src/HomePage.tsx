import { Link } from "react-router-dom";
import {
  HOME_CONTRACT,
  HOME_EXPLORER,
  HOME_LIMITS,
  HOME_LIMITS_BLOCK,
  HOME_REHEARSAL,
  HOME_SOURCE_COMMIT,
} from "./homeEvidence";
import "./home.css";

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

export function HomePage() {
  return (
    <div className="homePage">
      <section className="homeHero" aria-labelledby="homeTitle">
        <p className="homeEyebrow">Arc testnet · test USDC</p>
        <h1 id="homeTitle">Let your agent buy services on a budget you set.</h1>
        <p className="homeLede">
          You set aside USDC and the limits. Your agent signs each purchase
          from its own wallet. The contract pays the provider only inside those
          limits, records what is owed, and returns what is left to the sponsor
          when the sponsor closes the line.
        </p>
        <div className="homeActions">
          <Link className="homeCta" to="/start">
            Fund an agent
          </Link>
          <Link className="homeAgentLink" to="/start?role=agent">
            I run an agent
          </Link>
        </div>
      </section>

      <section
        className="homeSection"
        id="how"
        aria-labelledby="homeCycleTitle"
      >
        <div className="homeSectionHead">
          <p className="homeEyebrow">One real cycle</p>
          <h2 id="homeCycleTitle">What happens to the money</h2>
          <p>
            Team rehearsal, {HOME_REHEARSAL.date}: run from the command line
            with one team wallet as both sponsor and agent. Not a customer.
          </p>
        </div>
        <p className="homeNote homeAmountContext">
          Amounts are test USDC on Arc testnet.
        </p>
        <ol className="homeTimeline" role="list">
          <li>
            <span className="homeStep">Set aside</span>
            <span className="homeAmountGroup">
              <strong className="homeAmount">
                {HOME_REHEARSAL.amounts.setAside}
              </strong>
              <span>test USDC</span>
            </span>
            <p>
              The sponsor opened a line for the agent.{" "}
              <a
                href={`${HOME_EXPLORER}/tx/${HOME_REHEARSAL.transactions.open}`}
              >
                {short(HOME_REHEARSAL.transactions.open)}
              </a>
            </p>
          </li>
          <li>
            <span className="homeStep">Bought</span>
            <span className="homeAmountGroup">
              <strong className="homeAmount">
                {HOME_REHEARSAL.amounts.purchase}
              </strong>
              <span>test USDC</span>
            </span>
            <p>
              The agent signed one purchase of the Shadow payment cycle report.
              The contract paid the provider and recorded{" "}
              {HOME_REHEARSAL.amounts.purchase} as owed.{" "}
              <a
                href={`${HOME_EXPLORER}/tx/${HOME_REHEARSAL.transactions.purchase}`}
              >
                {short(HOME_REHEARSAL.transactions.purchase)}
              </a>
            </p>
            <span className="homeState homeStateOwed">
              {HOME_REHEARSAL.amounts.purchase} test USDC owed
            </span>
          </li>
          <li>
            <span className="homeStep">Recovered</span>
            <span className="homeAmountGroup">
              <strong className="homeAmount">
                {HOME_REHEARSAL.amounts.recovery}
              </strong>
              <span>test USDC moved</span>
            </span>
            <p>
              The confirmation was dropped on purpose. Recovery returned the
              same result for the same purchase, with no second payment.
            </p>
            <span className="homeState homeStateSettled">No second payment</span>
          </li>
          <li>
            <span className="homeStep">Repaid</span>
            <span className="homeAmountGroup">
              <strong className="homeAmount">
                {HOME_REHEARSAL.amounts.repayment}
              </strong>
              <span>test USDC</span>
            </span>
            <p>
              Repayment cleared the debt.{" "}
              <a
                href={`${HOME_EXPLORER}/tx/${HOME_REHEARSAL.transactions.repayment}`}
              >
                {short(HOME_REHEARSAL.transactions.repayment)}
              </a>
            </p>
            <span className="homeState homeStateSettled">Nothing owed</span>
          </li>
          <li>
            <span className="homeStep">Reclaimed</span>
            <span className="homeAmountGroup">
              <strong className="homeAmount">
                {HOME_REHEARSAL.amounts.reclaim}
              </strong>
              <span>test USDC</span>
            </span>
            <p>
              The sponsor took back everything set aside and the line closed.{" "}
              <a
                href={`${HOME_EXPLORER}/tx/${HOME_REHEARSAL.transactions.reclaim}`}
              >
                {short(HOME_REHEARSAL.transactions.reclaim)}
              </a>
            </p>
            <span className="homeState homeStateSettled">Line closed</span>
          </li>
        </ol>
        <p className="homeNote">
          One provider payment, one debt, nothing owed at the end.
        </p>
      </section>

      <section className="homeSection" aria-labelledby="homeRolesTitle">
        <div className="homeSectionHead">
          <p className="homeEyebrow">Two roles</p>
          <h2 id="homeRolesTitle">Who controls what</h2>
        </div>
        <div className="homeRoles">
          <div className="homeRole">
            <h3>The sponsor sets</h3>
            <ul>
              <li>How much USDC to set aside</li>
              <li>The approved provider, and the exact service it may be paid for</li>
              <li>Total, daily and per purchase limits</li>
              <li>How long a purchase may stay unpaid</li>
              <li>
                When to close the line and take back what is left, once nothing
                is owed
              </li>
            </ul>
          </div>
          <div className="homeRole">
            <h3>The agent can</h3>
            <ul>
              <li>Sign each purchase from its own wallet, and pay its own gas</li>
              <li>Pay only the approved provider, for the agreed service</li>
              <li>Have one unpaid purchase at a time</li>
              <li>See what it owes and when it is due</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="homeSection" aria-labelledby="homeLimitsTitle">
        <div className="homeSectionHead">
          <p className="homeEyebrow">Limits</p>
          <h2 id="homeLimitsTitle">What limits the risk</h2>
          <p>
            The contract refuses any purchase over a limit and moves no money.
            A signed purchase over a spending limit is recorded as blocked. A
            due date outside the window, or a second purchase while one is
            unpaid, is rejected outright. Sponsors set their own limits, equal
            to these or lower. The contract records the debt and accepts
            repayment from any wallet, but it cannot make the agent repay. The
            sponsor carries that risk, up to the amount set aside. If the due
            date passes with the debt unpaid, the sponsor can declare a default
            and then take back the unspent reserve, plus anything repaid later.
            On this website a sponsor can take back those funds once a default
            is declared, but cannot yet declare the default.
          </p>
        </div>
        <table className="homeLimitTable">
          <caption>Contract limits today. Amounts in test USDC.</caption>
          <thead>
            <tr>
              <th scope="col">Limit</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {HOME_LIMITS.map((limit) => (
              <tr key={limit.label}>
                <th scope="row">{limit.label}</th>
                <td>{limit.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="homeNote">
          Read from the contract at block {HOME_LIMITS_BLOCK}.
        </p>
      </section>

      <section
        className="homeSection homeEvidence"
        id="evidence"
        aria-labelledby="homeEvidenceTitle"
      >
        <h2 id="homeEvidenceTitle">Check it yourself</h2>
        <ul role="list">
          <li>
            <span>Contract</span>
            <a href={`${HOME_EXPLORER}/address/${HOME_CONTRACT}`}>
              {short(HOME_CONTRACT)}
            </a>
          </li>
          <li>
            <span>Source commit</span>
            <a
              href={`https://github.com/buildwithshadow/shadow/commit/${HOME_SOURCE_COMMIT}`}
            >
              {HOME_SOURCE_COMMIT.slice(0, 7)}
            </a>
          </li>
          <li>
            <span>Team rehearsal</span>
            <a href="#how">{HOME_REHEARSAL.date}</a>
          </li>
          <li>
            <span>Earlier contract records</span>
            <Link to="/float">
              Records from Shadow&apos;s earlier Float V2 contract
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
