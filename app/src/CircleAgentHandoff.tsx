import { useState } from 'react';
import { circleAgentCommands, type CircleAgentRoute } from './circleAgentCommands';

export function CircleAgentHandoff({ lineId, agent, route = 'public-testnet' }: { lineId: string; agent: string; route?: CircleAgentRoute }) {
  const [notice, setNotice] = useState('');
  const commands = circleAgentCommands(lineId, agent, route);
  const guarded = route === 'guarded-testnet';
  const price = guarded ? '0.005' : '0.05';
  const guide = guarded ? 'CIRCLE_GUARDED_TESTNET_RUNNER.md' : 'circle-agent-onboarding.md';
  return <details className="circleAgentHandoff">
    <summary>Use a Circle Agent Wallet</summary>
    <p>Run this funding line from the agent’s own environment. Circle login stays there; this page does not connect to or control the Agent Wallet.</p>
    <p><a href={`https://github.com/buildwithshadow/shadow/blob/main/docs/${guide}`} target="_blank" rel="noreferrer">Set up the Shadow agent runner</a>, then inspect this line before authorizing a purchase. The runner supports the {price} test USDC report only.</p>
    {guarded && <p>Keep your original Circle state and runtime directories. If you previously supplied <code>--state</code> or <code>--runtime</code>, append those same options to these commands. Never create a new journal to bypass an unresolved payment.</p>}
    <div className="fundingField">
      <label htmlFor="circle-agent-inspect">Check this line without spending</label>
      <textarea id="circle-agent-inspect" readOnly rows={3} value={commands.inspect} spellCheck={false} />
    </div>
    <button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(commands.inspect); setNotice('Copied the read-only line check.'); }
      catch { setNotice('Copy was unavailable. Select and copy the command above.'); }
    }}>Copy line check</button>
    <p role="status" aria-live="polite">{notice}</p>
    <details><summary>Purchase, repayment and recovery commands</summary>
      <p>The purchase and repayment commands each authorize {price} test USDC plus testnet network fees. After an interrupted response, use recovery first.</p>
      {guarded && <p>Repayment stays bound to the purchase you reviewed. If another purchase replaces that debt, it stops for a new review.</p>}
      {([
        ['purchase', 'Authorize one service purchase'],
        ['recover', 'Check payment and recover the result without sending again'],
        ['repay', 'Authorize full repayment from the agent wallet'],
      ] as const).map(([key,label]) => <div className="fundingField" key={key}>
        <label htmlFor={`circle-agent-${key}`}>{label}</label>
        <textarea id={`circle-agent-${key}`} readOnly rows={3} value={commands[key]} spellCheck={false} />
      </div>)}
    </details>
  </details>;
}
