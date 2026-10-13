import { formatUnits } from 'viem';
import type { CandidateOpenInput } from './candidateFunding';

export function ServiceFundingFields({ form, service, busy, onChange }: {
  form: CandidateOpenInput;
  service: { name: string; principal: string };
  busy: boolean;
  onChange(key: keyof CandidateOpenInput, value: string): void;
}) {
  function field(key: keyof CandidateOpenInput, label: string, hint?: string) {
    return <div className="fundingField">
      <label htmlFor={`funding-${key}`}>{label}</label>
      <input id={`funding-${key}`} name={key} value={form[key]} required disabled={busy}
        inputMode={key === 'agent' ? 'text' : 'decimal'} autoComplete="off" spellCheck={false}
        aria-describedby={hint ? `funding-${key}-hint` : undefined}
        onChange={event => onChange(key, event.target.value)} />
      {hint && <small id={`funding-${key}-hint`}>{hint}</small>}
    </div>;
  }
  return <>
    <p><strong>{service.name}</strong> · {formatUnits(BigInt(service.principal), 6)} USDC per purchase.</p>
    <div className="fundingGrid">
      {field('agent', 'Agent wallet address', 'The wallet that signs purchases. Its operator owes repayment.')}
      {field('reserve', 'USDC to set aside', 'Deposited into the funding line. Keep extra USDC in your wallet for fees.')}
      {field('repaymentHours', 'Repayment window (hours)', 'Each purchase sets its due time within this window. Repayment is not guaranteed.')}
    </div>
    <p>This line permits up to <strong>{form.lineSpendCap} USDC</strong> in total purchases. Repayment restores available funds but does not reset this permission.</p>
    {Number(form.reserve) > Number(form.lineSpendCap) && <p className="fundingCallout" role="status">You are setting aside more than this line can spend in total. The extra reserve stays unused until you reclaim it.</p>}
    <details><summary>Advanced spending limits and service details</summary>
      <div className="fundingGrid">
        {field('lineSpendCap', 'Total purchase limit (USDC)', 'Cumulative across this line, including purchases already repaid.')}
        {field('dailySpendCap', 'Line daily limit (USDC)', 'Resets at midnight UTC.')}
        {field('providerPerSpendCap', 'Maximum purchase (USDC)')}
        {field('providerDailyCap', 'Provider daily limit (USDC)')}
        {field('expiryDays', 'Funding duration (days)', 'Expiry stops new purchases. Repayment and eligible reclaim remain available.')}
      </div>
      <dl className="fundingDetails"><div><dt>Approved provider</dt><dd><code>{form.provider}</code></dd></div>
        <div><dt>Service endpoint</dt><dd><code>{form.endpoint}</code></dd></div></dl>
    </details>
  </>;
}
