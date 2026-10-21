import { useCallback, useId, useRef, useState } from 'react';
import type { CandidateDeployment, CandidateLine } from './candidateFunding';
import { createCycleSummary, type CycleReportCheck } from './lineLifecycle';
import './lineLifecycle.css';

// Switching wallets hides the previous visit immediately. Do not clear in a
// parent effect: a child can publish a verified cached recovery in its own
// effect before that parent effect runs, losing the new check on route return.
export function useCycleReportChecks(context: string) {
  const active = useRef({context, generation: 0});
  if (active.current.context !== context) active.current = {context, generation: active.current.generation + 1};
  const generation = active.current.generation;
  const [saved, setSaved] = useState<{context: string; generation: number; reports: CycleReportCheck[]}>({context, generation, reports: []});
  const deliveryChecked = useCallback((check: CycleReportCheck) => {
    if (active.current.context !== context || active.current.generation !== generation) return;
    setSaved(previous => ({context, generation, reports: [
      ...(previous.context === context && previous.generation === generation ? previous.reports : []).filter(item => item.digest.toLowerCase() !== check.digest.toLowerCase()), check,
    ].slice(-100)}));
  }, [context, generation]);
  return { reports: saved.context === context && saved.generation === generation ? saved.reports : [], deliveryChecked };
}

export function LineLifecycle({ deployment, line, reports = [], busy = false }: {
  deployment: CandidateDeployment; line: CandidateLine; reports?: readonly CycleReportCheck[]; busy?: boolean;
}) {
  const id = useId();
  const [error, setError] = useState('');
  let summary;
  try { summary = createCycleSummary(deployment, line, reports); }
  catch { return <section className="lineLifecycle" aria-label="Funding cycle"><p role="status">Funding cycle values could not be read. Refresh the line before exporting.</p></section>; }
  function download() {
    setError('');
    try {
      const data = createCycleSummary(deployment, line, reports);
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `shadow-cycle-${deployment.chainId}-${line.lineId}.json`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('The cycle summary could not be downloaded. Try again. No transaction was requested.'); }
  }
  return <section className="lineLifecycle" aria-labelledby={`${id}-title`}>
    <div className="lineLifecycleHead"><div><h4 id={`${id}-title`}>Your funding cycle</h4>
      <p>Line state at block {summary.observedBlock}. Report checks are separate from repayment.</p></div>
      <button type="button" disabled={busy} onClick={download} aria-describedby={`${id}-scope`}>Download cycle summary</button></div>
    <ol>{summary.stages.map(stage => <li key={stage.title} data-state={stage.state}>
      <strong>{stage.title}</strong><span>{stage.detail}</span>
    </li>)}</ol>
    <p id={`${id}-scope`} className="lineLifecycleScope">This summary includes line balances and report checks from this visit. It does not include the full transaction history or prove how much was reclaimed. Download the original report receipt from service records for its payment and delivery evidence.</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
