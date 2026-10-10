import type { ReactNode } from "react";
import { fundingSteps, stepLabels, type FundingStep } from "./fundingJourney";
import "./fundingJourney.css";

export function FundingJourney({
  step,
  busy,
  title,
  description,
  children,
  summary,
  onNavigate,
  wallet,
}: {
  step: FundingStep;
  busy: boolean;
  title: string;
  description: string;
  children: ReactNode;
  summary?: ReactNode;
  onNavigate: (step: FundingStep) => void;
  wallet?: ReactNode;
}) {
  const index = fundingSteps.indexOf(step as (typeof fundingSteps)[number]);
  return (
    <div className="fundingDesk fundingJourney">
      <header className="journeyHeading">
        <div>
          <p className="pageEyebrow">
            <span className="journeyNetworkDot" aria-hidden="true" />
            Arc testnet{" "}
            <span className="journeyTestLabel">Practice with test USDC</span>
          </p>
          <h1 tabIndex={-1} id="journey-title">
            {title}
          </h1>
          <p>{description}</p>
        </div>
        {wallet && <div className="journeyWallet">{wallet}</div>}
      </header>
      {index >= 0 && (
        <nav className="journeyProgress" aria-label="Funding progress">
          <p className="journeyMobileProgress">
            Step {index + 1} of {fundingSteps.length} · {stepLabels[step]}
          </p>
          <ol>
            {fundingSteps.map((value, i) => (
              <li
                key={value}
                aria-current={value === step ? "step" : undefined}
                className={value === step ? "current" : ""}
              >
                <span className="journeyStepNumber" aria-hidden="true">
                  {i + 1}
                </span>
                {i < index ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onNavigate(value)}
                  >
                    {stepLabels[value]}
                  </button>
                ) : (
                  <span>{stepLabels[value]}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className={`journeyLayout${summary ? "" : " journeySolo"}`}>
        <div className="journeyMain">{children}</div>
        {summary && (
          <aside className="journeySummary" aria-label="Your funding plan">
            {summary}
          </aside>
        )}
      </div>
      <footer className="journeyFooter">
        <span>Testnet funds have no monetary value.</span>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onNavigate(step === "line" || step === "purchase" ? "home" : "line")
          }
        >
          {step === "line" || step === "purchase"
            ? "Start a new funding line"
            : "Already have a line? Open it"}
        </button>
      </footer>
    </div>
  );
}
