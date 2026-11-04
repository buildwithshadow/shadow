import { formatUnits } from 'viem';
import type { CandidateLine } from './candidateFunding';

export type PurchaseLineView = Pick<CandidateLine, 'lineId' | 'stateName'> & Partial<Pick<CandidateLine,
  'availableReserve' | 'principalOutstanding' | 'lineSpendCap' | 'cumulativePrincipalPaid' | 'observedBlock'>>;

export function PurchaseLineSummary({ line, lineId, principal, currency, project }: {
  line: PurchaseLineView | null; lineId: string; principal: bigint; currency: string; project: boolean;
}) {
  if (!line || line.lineId.toLowerCase() !== lineId.trim().toLowerCase() ||
      typeof line.availableReserve !== 'bigint' || typeof line.principalOutstanding !== 'bigint' ||
      typeof line.lineSpendCap !== 'bigint' || typeof line.cumulativePrincipalPaid !== 'bigint') return null;
  const remaining = line.lineSpendCap > line.cumulativePrincipalPaid ? line.lineSpendCap - line.cumulativePrincipalPaid : 0n;
  const projected = project && line.stateName === 'OPEN' && line.principalOutstanding === 0n &&
    principal > 0n && line.availableReserve >= principal && remaining >= principal;
  const values = [
    ['Reserve remaining', line.availableReserve, projected ? line.availableReserve - principal : line.availableReserve],
    ['Principal owed', line.principalOutstanding, projected ? line.principalOutstanding + principal : line.principalOutstanding],
    ['Permission remaining', remaining, projected ? remaining - principal : remaining],
  ] as const;
  return <section className="purchaseMoney" aria-label={projected ? 'Projected line balances after payment' : 'Observed line balances'}>
    <div className="purchaseMoneyHeading"><h3>{projected ? 'After payment' : 'Line snapshot'}</h3><span>Amounts in {currency}</span></div>
    <dl>{values.map(([label, before, after]) => <div key={label}>
      <dt>{label}</dt><dd>{formatUnits(after, 6)}</dd>
      {projected && <small>Now {formatUnits(before, 6)}</small>}
    </div>)}</dl>
    <p>Repayment restores reserve. It does not reset purchase permission.</p>
    {line.observedBlock !== undefined && <small>Based on line state at block {line.observedBlock.toString()}. {projected ? 'Preparation does not move these funds.' : 'These are observed balances, not a new payment.'}</small>}
  </section>;
}

export function purchaseTime(value: string): string {
  const date = new Date(Number(value) * 1000);
  if (!Number.isFinite(date.getTime())) return `${value} seconds since the Unix epoch`;
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)} UTC`;
}
