import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useEffect } from 'react';
import { LineLifecycle, useCycleReportChecks } from '../src/FundingCycleTracker';
import { deployment, line, report } from './line-lifecycle-fixture';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test('shows five stages, distinguishes missing delivery evidence and exposes export scope', () => {
  render(<LineLifecycle deployment={deployment} line={line}/>);
  expect(screen.getByRole('list').querySelectorAll('li').length).toBe(5);
  expect(screen.getByText(/Not checked in this visit/)).toBeTruthy();
  expect(screen.getByText(/does not include the full transaction history/)).toBeTruthy();
  expect(screen.getByRole('button', {name:'Download cycle summary'})).toBeTruthy();
});
test('download contains the selected line, not another line after navigation', async () => {
  let captured: Blob | undefined;
  Object.defineProperty(URL, 'createObjectURL', {configurable:true,value:vi.fn((blob:Blob) => {captured=blob;return 'blob:cycle';})});
  Object.defineProperty(URL, 'revokeObjectURL', {configurable:true,value:vi.fn()});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const {rerender} = render(<LineLifecycle deployment={deployment} line={line} reports={[report]}/>);
  const next = {...line, lineId:`0x${'99'.repeat(32)}` as const};
  rerender(<LineLifecycle deployment={deployment} line={next} reports={[report]}/>);
  fireEvent.click(screen.getByRole('button', {name:'Download cycle summary'}));
  const raw = await new Promise<string>((resolve,reject) => {const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsText(captured!);});
  const data=JSON.parse(raw);
  expect(data.line.lineId).toBe(next.lineId);
  expect(data.reports).toEqual([]);
  expect(data.reclaimAmount).toBeNull();
});
test('blocks download during wallet work and preserves an explicit download failure', () => {
  const {rerender} = render(<LineLifecycle deployment={deployment} line={line} busy/>);
  expect(screen.getByRole('button', {name:'Download cycle summary'}).hasAttribute('disabled')).toBe(true);
  rerender(<LineLifecycle deployment={deployment} line={line}/>);
  Object.defineProperty(URL, 'createObjectURL', {configurable:true,value:vi.fn(()=>{throw new Error('unavailable');})});
  fireEvent.click(screen.getByRole('button', {name:'Download cycle summary'}));
  expect(screen.getByRole('alert').textContent).toContain('No transaction was requested');
});
test('a cached child recovery survives parent effects and an old wallet callback cannot erase the new visit', () => {
  const callbacks: Array<(check: typeof report) => void> = [];
  function Child({checked}: {checked:(check:typeof report)=>void}) {
    useEffect(() => { callbacks.push(checked); checked(report); }, [checked]);
    return null;
  }
  function Host({context}: {context:string}) {
    const {reports,deliveryChecked} = useCycleReportChecks(context);
    return <><Child checked={deliveryChecked}/><LineLifecycle deployment={deployment} line={line} reports={reports}/></>;
  }
  const {rerender} = render(<Host context="wallet-a"/>);
  expect(screen.getByText(/1 report receipt rechecked/)).toBeTruthy();
  rerender(<Host context="wallet-b"/>);
  // A delayed result from A must not overwrite a freshly rechecked result in B.
  callbacks[0]({...report,digest:`0x${'aa'.repeat(32)}`});
  expect(screen.getByText(/1 report receipt rechecked/)).toBeTruthy();
  rerender(<Host context="wallet-a"/>);
  act(() => callbacks[0]({...report,digest:`0x${'aa'.repeat(32)}`}));
  expect(screen.getByText(/1 report receipt rechecked/)).toBeTruthy();
});
test('returning to a wallet without a fresh check does not resurrect a previous visit', () => {
  let oldCheck!: (check: typeof report) => void;
  function Host({context}: {context:string}) {
    const {reports,deliveryChecked} = useCycleReportChecks(context);
    if (!oldCheck) oldCheck = deliveryChecked;
    return <output>{reports.length} checked</output>;
  }
  const {rerender} = render(<Host context="wallet-a"/>);
  act(() => oldCheck(report)); expect(screen.getByText('1 checked')).toBeTruthy();
  rerender(<Host context="wallet-b"/>); expect(screen.getByText('0 checked')).toBeTruthy();
  rerender(<Host context="wallet-a"/>); expect(screen.getByText('0 checked')).toBeTruthy();
  act(() => oldCheck(report)); expect(screen.getByText('0 checked')).toBeTruthy();
});
