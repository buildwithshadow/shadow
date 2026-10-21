import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycleSummary } from '../src/lineLifecycle.ts';
import { deployment, line, report } from './line-lifecycle-fixture.ts';

test('a closed unused line does not become a completed purchase or repaid loan', () => {
  const summary = createCycleSummary(deployment, { ...line, cumulativePrincipalPaid: 0n });
  assert.equal(summary.stages[1].state, 'none');
  assert.equal(summary.stages[2].state, 'unknown');
  assert.equal(summary.stages[3].state, 'none');
  assert.equal(summary.reclaimAmount, null);
});
test('partial repayment remains pending and does not imply delivery or closure', () => {
  const summary = createCycleSummary(deployment, { ...line, state: 2, stateName: 'DRAWN', principalOutstanding: 3000n });
  assert.equal(summary.line.principalRepaid, '2000');
  assert.equal(summary.stages[3].state, 'pending');
  assert.equal(summary.stages[4].state, 'pending');
  assert.equal(summary.stages[2].state, 'unknown');
});
test('default claims are not reported as closure or a known reclaim amount', () => {
  const summary = createCycleSummary(deployment, { ...line, state: 3, stateName: 'DEFAULTED', principalOutstanding: 5000n, recoveryAvailable: 1000n });
  assert.equal(summary.line.principalRepaid, '0');
  assert.match(summary.stages[4].detail, /Defaulted/);
  assert.equal(summary.reclaimAmount, null);
});
test('wrong network, deployment, runtime, line, sponsor and agent reports are excluded', () => {
  const other = `0x${'99'.repeat(32)}` as const;
  for (const changed of [{chainId:5042002}, {contract:`0x${'99'.repeat(20)}`}, {runtimeHash:other}, {lineId:other}, {sponsor:`0x${'99'.repeat(20)}`}, {agent:`0x${'99'.repeat(20)}`}]) {
    assert.equal(createCycleSummary(deployment, line, [{...report, ...changed}]).reports.length, 0);
  }
});
test('one rechecked report is deduplicated and cannot cover two draws', () => {
  const summary = createCycleSummary(deployment, { ...line, cumulativePrincipalPaid: 10000n }, [report, report]);
  assert.equal(summary.reports.length, 1);
  assert.match(summary.stages[2].detail, /coverage is incomplete/);
});
test('matching amounts describe visit checks, never independent delivery proof', () => {
  const summary = createCycleSummary(deployment, line, [report]);
  assert.match(summary.stages[2].detail, /checked amounts match/);
  assert.match(summary.scope, /Not a complete transaction history/);
  assert.ok(summary.missingEvidence.some(value => value.includes('does not independently reverify')));
});
test('export allowlists data and excludes signatures and arbitrary credentials', () => {
  const summary = createCycleSummary(deployment, {...line, secret:'do-not-export'} as any, [{...report, signature:'do-not-export', privateKey:'do-not-export'} as any]);
  const raw = JSON.stringify(summary);
  assert.ok(!raw.includes('do-not-export'));
  assert.equal(JSON.parse(raw).line.principalRepaid, '5000');
});
test('inconsistent debt does not produce a misleading negative repayment', () => {
  assert.throws(() => createCycleSummary(deployment, {...line, principalOutstanding:5001n}), /inconsistent/);
});
