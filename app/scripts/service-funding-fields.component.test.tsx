import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ServiceFundingFields } from '../src/ServiceFundingFields';
import type { CandidateOpenInput } from '../src/candidateFunding';

const initial: CandidateOpenInput = {
  agent:'0x1111111111111111111111111111111111111111', provider:'0x2222222222222222222222222222222222222222',
  endpoint:'https://example.com/report', reserve:'0.005', lineSpendCap:'0.005', dailySpendCap:'0.005',
  providerPerSpendCap:'0.005', providerDailyCap:'0.005', expiryDays:'7', repaymentHours:'24',
};
function Host({busy=false, form=initial}: {busy?:boolean; form?:CandidateOpenInput}) {
  const [value,setValue] = useState(form);
  return <ServiceFundingFields form={value} busy={busy} service={{name:'Wallet report',principal:'5000'}}
    onChange={(key,next)=>setValue(previous=>({...previous,[key]:next}))}/>;
}
afterEach(cleanup);
test('only agent, budget and repayment inputs are presented before advanced settings',()=>{
  render(<Host/>);
  expect(screen.getByLabelText('Agent wallet address')).toBeTruthy();
  expect(screen.getByLabelText('USDC to set aside')).toBeTruthy();
  expect(screen.getByLabelText('Repayment window (hours)')).toBeTruthy();
  const details=document.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(screen.getByLabelText('Total purchase limit (USDC)').closest('details')).toBe(details);
  expect(screen.getByText('Approved provider').closest('details')).toBe(details);
});
test('editing budget preserves existing spending permissions and exposes excess reserve',()=>{
  render(<Host/>);
  fireEvent.change(screen.getByLabelText('USDC to set aside'),{target:{value:'0.10'}});
  expect(screen.getByLabelText('Total purchase limit (USDC)').getAttribute('value')).toBe('0.005');
  expect(screen.getByRole('status').textContent).toMatch(/extra reserve stays unused/);
});
test('advanced edits remain present after closing details and never rewrite the reserve',()=>{
  render(<Host/>);
  const details=document.querySelector('details')!;details.open=true;
  fireEvent.change(screen.getByLabelText('Total purchase limit (USDC)'),{target:{value:'0.003'}});
  details.open=false;details.open=true;
  expect(screen.getByLabelText('Total purchase limit (USDC)').getAttribute('value')).toBe('0.003');
  expect(screen.getByLabelText('USDC to set aside').getAttribute('value')).toBe('0.005');
});
test('all inputs stay disabled while the original wallet action is in progress',()=>{
  render(<Host busy/>);
  expect(Array.from(document.querySelectorAll('input')).every(input=>input.disabled)).toBe(true);
});
test('an invalid advanced value reopens its disclosure so native validation can focus it',()=>{
  render(<Host/>);
  const details=document.querySelector('details')!;
  const input=screen.getByLabelText('Total purchase limit (USDC)');
  details.open=true;
  fireEvent.change(input,{target:{value:''}});
  details.open=false;
  fireEvent.invalid(input);
  expect(details.open).toBe(true);
});
