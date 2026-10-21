import { useId, useState } from 'react';
import type { CandidateDeployment, CandidateLine } from './candidateFunding';
import { createCycleSummary, type CycleReportCheck } from './lineLifecycle';
import './lineLifecycle.css';

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
