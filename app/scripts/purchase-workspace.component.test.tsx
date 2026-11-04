import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { PurchaseLineSummary, type PurchaseLineView } from '../src/PurchaseLineSummary';

const lineId=`0x${'11'.repeat(32)}` as const;
const line: PurchaseLineView={lineId,stateName:'OPEN',availableReserve:123456n,principalOutstanding:0n,lineSpendCap:60000n,cumulativePrincipalPaid:12000n,observedBlock:123n};
afterEach(cleanup);

test('projection uses the selected line amounts rather than the mockup example',()=>{
  render(<PurchaseLineSummary line={line} lineId={lineId} principal={7000n} currency="USDC" project/>);
  const summary=screen.getByRole('region',{name:'Projected line balances after payment'});
  expect(within(summary).getByText('0.116456')).toBeTruthy();
  expect(within(summary).getByText('0.007')).toBeTruthy();
  expect(within(summary).getByText('0.041')).toBeTruthy();
  expect(within(summary).getByText('Now 0.123456')).toBeTruthy();
  expect(within(summary).queryByText('0.005')).toBeNull();
});

test('another line or missing balances never receives a financial projection',()=>{
  const {rerender,container}=render(<PurchaseLineSummary line={line} lineId={`0x${'22'.repeat(32)}`} principal={7000n} currency="USDC" project/>);
  expect(container.textContent).toBe('');
  rerender(<PurchaseLineSummary line={{lineId,stateName:'OPEN'}} lineId={lineId} principal={7000n} currency="USDC" project/>);
  expect(container.textContent).toBe('');
});

test.each([
  {stateName:'CLOSED' as const}, {principalOutstanding:3000n,stateName:'DRAWN' as const},
  {availableReserve:1000n}, {lineSpendCap:13000n},
])('closed, drawn or insufficient lines show observed balances only, case %#',(change)=>{
  render(<PurchaseLineSummary line={{...line,...change}} lineId={lineId} principal={7000n} currency="USDC" project/>);
  expect(screen.getByRole('region',{name:'Observed line balances'})).toBeTruthy();
  expect(screen.queryByRole('heading',{name:'After payment'})).toBeNull();
  expect(screen.queryByText(/^Now /)).toBeNull();
});

test('a payment already being checked cannot show another projected spend',()=>{
  render(<PurchaseLineSummary line={line} lineId={lineId} principal={7000n} currency="USDC" project={false}/>);
  expect(screen.getByRole('region',{name:'Observed line balances'})).toBeTruthy();
  expect(screen.queryByRole('heading',{name:'After payment'})).toBeNull();
});
