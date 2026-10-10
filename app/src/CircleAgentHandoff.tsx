import { useState } from 'react';
import { circleAgentCommands, type CircleAgentRoute } from './circleAgentCommands';

export function CircleAgentHandoff({ lineId, agent, route = 'public-testnet', lineState, debt, spendingAvailable }: { lineId: string; agent: string; route?: CircleAgentRoute; lineState?: string; debt?: bigint; spendingAvailable?: boolean }) {
  const [notice, setNotice] = useState('');
  const commands = circleAgentCommands(lineId, agent, route);
  const mainnet = route === 'guarded-mainnet';
  const guarded = mainnet || route === 'guarded-testnet';
  const currency = mainnet ? 'USDC' : 'test USDC';
  const network = mainnet ? 'Arc mainnet' : 'Arc testnet';
  const canPurchase = !mainnet || lineState === 'OPEN' && spendingAvailable === true;
  const canRepay = !mainnet || (lineState === 'DRAWN' || lineState === 'DEFAULTED') && debt === 5_000n;
  const price = guarded ? '0.005' : '0.05';
  const guide = mainnet ? 'CIRCLE_GUARDED_MAINNET_RUNNER.md' : guarded ? 'CIRCLE_GUARDED_TESTNET_RUNNER.md' : 'circle-agent-onboarding.md';
  async function copyCommand(key: keyof typeof commands) {
    try { await navigator.clipboard.writeText(commands[key]); setNotice(key === 'inspect' ? 'Copied the read-only line check.' : `Copied the ${key} command. Review it in your own terminal before running.`); }
    catch { setNotice('Copy was unavailable. Select and copy the command above.'); }
  }
  return <details className="circleAgentHandoff">
    <summary>Use a Circle Agent Wallet</summary>
    <p>Run this funding line from the agent’s own environment. Circle login stays there; this page does not connect to or control the Agent Wallet.</p>
    <p><a style={{ display: "inline-flex", alignItems: "center", minHeight: 44 }} href={`https://github.com/buildwithshadow/shadow/blob/main/docs/${guide}`} target="_blank" rel="noreferrer">Set up the Shadow agent runner</a>, then inspect this line before authorizing a purchase. The runner supports the {price} {currency} report on {network} only.</p>
    {guarded && !mainnet && <p>Keep your original Circle state and runtime directories. If you previously supplied <code>--state</code> or <code>--runtime</code>, append those same options to these commands. Never create a new journal to bypass an unresolved payment.</p>}
    {mainnet && <>
      <p>Real USDC and mainnet fees. Use this controlled flow only with your approved funding line and reviewed operator configuration. The commands below do not admit sponsors or enable spending.</p>
      <p>Set the local paths once using the <a style={{ display: "inline-flex", alignItems: "center", minHeight: 44 }} href={`https://github.com/buildwithshadow/shadow/blob/main/docs/${guide}#local-operator-paths`} target="_blank" rel="noreferrer">operator setup guide</a>. Keep your original wallet journal and execution session. Missing paths cause the runner to stop; this page never reads them or your Circle credentials.</p>
    </>}
    <div className="fundingField">
      <label htmlFor="circle-agent-inspect">Check this line without spending</label>
      <textarea id="circle-agent-inspect" readOnly rows={3} value={commands.inspect} spellCheck={false} />
    </div>
    <button type="button" onClick={() => void copyCommand('inspect')}>Copy line check</button>
    <p role="status" aria-live="polite">{notice}</p>
    <details><summary>{!mainnet ? "Purchase, repayment and recovery commands" : canPurchase ? "Purchase and recovery commands" : canRepay ? "Repayment and recovery commands" : "Recovery command"}</summary>
      {(!mainnet || canPurchase || canRepay) && <p>{mainnet ? `The ${canPurchase ? "purchase" : "repayment"} command authorizes` : "The purchase and repayment commands each authorize"} {price} {currency} plus {mainnet ? "mainnet" : "testnet"} network fees. After an interrupted response, use recovery first.</p>}
      {mainnet && !canPurchase && !canRepay && <p>This runner currently offers inspection and recovery for this line. Use the line controls above to review any remaining debt. These commands do not send a new payment.</p>}
      {mainnet && canPurchase && <p>Purchase requires a fresh healthy monitor and available execution session capacity. The default fee estimate ceiling is 0.02 USDC. If your reviewed purchase configuration allows it, append <code>--purchase-fee-cap-usdc 0.04</code> to the purchase command only. Repayment remains capped at a 0.02 USDC fee estimate. These are estimate limits, not guarantees of the final network fee. Recovery does not sign or submit again, and repayment does not reset the session budget.</p>}
      {guarded && (!mainnet || canRepay) && <p>Repayment stays bound to the purchase you reviewed. If another purchase replaces that debt, it stops for a new review.</p>}
      {([
        ['purchase', 'Authorize one service purchase'],
        ['recover', 'Check payment and recover the result without sending again'],
        ['repay', 'Authorize full repayment from the agent wallet'],
      ] as const).filter(([key]) => key === "recover" || key === "purchase" && canPurchase || key === "repay" && canRepay).map(([key,label]) => <div className="fundingField" key={key}>
        <label htmlFor={`circle-agent-${key}`}>{label}</label>
        <textarea id={`circle-agent-${key}`} readOnly rows={3} value={commands[key]} spellCheck={false} />
        <button type="button" onClick={() => void copyCommand(key)}>Copy {key} command</button>
      </div>)}
    </details>
  </details>;
}
