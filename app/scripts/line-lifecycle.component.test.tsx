import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { LineLifecycle } from '../src/FundingCycleTracker';
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
