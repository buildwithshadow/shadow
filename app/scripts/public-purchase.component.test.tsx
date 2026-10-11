import { BaseError } from 'viem';
import { useState } from 'react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PublicPurchase } from '../src/PublicPurchase';
import { recoverySession } from '../src/purchaseRecoverySession.mjs';
import type { RecoveryResult } from '../src/purchaseRecovery.mjs';
const h = vi.hoisted(() => ({ engines: new Map<string, any>() }));
vi.mock('../src/selfServicePurchase.mjs', () => ({
  createSelfServicePurchase: ({config}: any) => h.engines.get(config.account),
  createGuardedMainnetPurchase: ({config}: any) => h.engines.get(config.account),
}));
const account = '0x1111111111111111111111111111111111111111';
const deployment: any = {chainId:5042002,address:'0x3333333333333333333333333333333333333333',runtimeHash:`0x${'44'.repeat(32)}`};
const service: any = {name:'Wallet report',provider:'0x2222222222222222222222222222222222222222',endpoint:'https://example.com/report',providerUrl:'https://example.com/provider',principal:'50000',sourcePayment:'unused'};
let counter = 0;
function fixture(status=2n) {
  const digest = `0x${(++counter).toString(16).padStart(64,'0')}`;
  let saved: any = {stage:'submitted',requestId:`report:${counter}`,txHash:null,intent:{digest,typedData:{message:{lineId:`0x${'55'.repeat(32)}`,agent:account,sponsor:account,provider:service.provider,principal:'50000',maximumTotalDebt:'50000',dueAt:'2000000000',signatureExpiry:'2000000000'}}}};
  const delivered = () => {saved={...saved,stage:'delivered'};return {record:saved,status:'delivered' as const,bytes:new TextEncoder().encode(`original report ${counter}`)};};
  const archived: any[] = [];
  const engine={load:()=>saved,recover:vi.fn<()=>Promise<RecoveryResult>>(async()=>delivered()),prepare:vi.fn(),submit:vi.fn(),
    archive:vi.fn(async()=>{archived.push(saved);saved=null;}),listArchived:()=>archived,
    recoverArchived:vi.fn(async(digest:string)=>({record:archived.find(item=>item.intent.digest===digest),status:'delivered',bytes:new TextEncoder().encode('retained report')}))};
  h.engines.set(account,engine);
  const client: any = {readContract:vi.fn(async()=>status)};
  return {engine,client,digest,delivered,archived,replaceSaved:(record:any)=>{saved=record;}};
}
function Host({client}: {client:any}) {
  const [busy,setBusy]=useState('');
  return <MemoryRouter initialEntries={['/start/purchase']}>
    <Link to="/other">Leave funding</Link><Link to="/start/purchase">Return to purchase</Link>
    <Routes><Route path="/other" element={<p>Other page</p>}/><Route path="/start/purchase" element={<PublicPurchase
      account={account} correctNetwork deployment={deployment} service={service} client={client} busy={busy} setBusy={setBusy}
      fundingPending={false} lineId="" onLineIdChange={()=>{}} onPurchaseChanged={async()=>{}}/>}/></Routes>
  </MemoryRouter>;
}
beforeEach(()=>{
  h.engines.clear(); window.localStorage.clear();
  Object.defineProperty(window,'ethereum',{configurable:true,value:{request:vi.fn()}});
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
test('a delivered report remains visible after ten complete route unmounts without another recovery or payment',async()=>{
  const f=fixture(),text=`original report ${counter}`;render(<Host client={f.client}/>);
  await screen.findByText(text);expect(f.engine.recover).toHaveBeenCalledTimes(1);
  for(let i=0;i<10;i++){
    fireEvent.click(screen.getByText('Leave funding'));fireEvent.click(screen.getByText('Return to purchase'));
    await screen.findByText(text);
  }
  expect(f.engine.recover).toHaveBeenCalledTimes(1);expect(f.engine.submit).not.toHaveBeenCalled();
});
test('the new component receives a terminal response from the old unmounted read',async()=>{
  const f=fixture(),text=`original report ${counter}`;let settle!: (value:any)=>void;
  f.engine.recover.mockImplementation(()=>new Promise(resolve=>{settle=resolve;}));
  render(<Host client={f.client}/>);await waitFor(()=>expect(f.engine.recover).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('Leave funding'));fireEvent.click(screen.getByText('Return to purchase'));
  expect(f.engine.recover).toHaveBeenCalledTimes(1);
  await act(async()=>{settle(f.delivered());});await screen.findByText(text);
  expect(f.engine.recover).toHaveBeenCalledTimes(1);expect(f.engine.submit).not.toHaveBeenCalled();
});
test('invalid evidence stays stopped across route unmounts, and manual recovery retains the repaired result',async()=>{
  const f=fixture(),text=`original report ${counter}`;f.engine.recover.mockRejectedValueOnce(new Error('Invalid signed delivery.'));
  render(<Host client={f.client}/>);await screen.findByText('Invalid signed delivery.');
  fireEvent.click(screen.getByText('Leave funding'));fireEvent.click(screen.getByText('Return to purchase'));
  await screen.findByText(/Automatic checks remain stopped/);expect(f.engine.recover).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Check payment & recover result'}));await screen.findByText(text);
  fireEvent.click(screen.getByText('Leave funding'));fireEvent.click(screen.getByText('Return to purchase'));await screen.findByText(text);
  expect(f.engine.recover).toHaveBeenCalledTimes(2);expect(f.engine.submit).not.toHaveBeenCalled();
});
test('hidden initial views start their original recovery when made visible',async()=>{
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');const f=fixture(),text=`original report ${counter}`;
  render(<Host client={f.client}/>);expect(f.engine.recover).not.toHaveBeenCalled();
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');fireEvent(document,new Event('visibilitychange'));
  await screen.findByText(text);expect(f.engine.recover).toHaveBeenCalledTimes(1);
});
test('a saved exhausted session cannot be restarted by remounting the component',async()=>{
  const f=fixture(0n),key=`${deployment.chainId}:${deployment.address}:${deployment.runtimeHash}:${account}:${f.digest}`;
  const session=recoverySession(key);session.attempts=6;session.stopped=true;
  render(<Host client={f.client}/>);await screen.findByText(/Automatic checks remain stopped/);
  fireEvent.click(screen.getByText('Leave funding'));fireEvent.click(screen.getByText('Return to purchase'));
  await screen.findByText(/Automatic checks remain stopped/);expect(f.engine.recover).not.toHaveBeenCalled();expect(f.engine.submit).not.toHaveBeenCalled();
});
test('the mounted UI stops after six uncertain reads and navigation cannot replenish that budget',async()=>{
  vi.useFakeTimers();const f=fixture(0n);f.engine.recover.mockImplementation(async()=>({record:f.engine.load(),status:'unconfirmed'}));
  render(<Host client={f.client}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(61000);});
  expect(f.engine.recover).toHaveBeenCalledTimes(6);expect(screen.getByText(/Automatic checks have stopped/)).toBeTruthy();
  fireEvent.click(screen.getByText('Leave funding'));fireEvent.click(screen.getByText('Return to purchase'));
  await act(async()=>{await vi.advanceTimersByTimeAsync(61000);});
  expect(f.engine.recover).toHaveBeenCalledTimes(6);expect(f.engine.submit).not.toHaveBeenCalled();
});
test('the mounted UI retrieves the original report after a temporary provider outage',async()=>{
  vi.useFakeTimers();const f=fixture(),text=`original report ${counter}`;
  f.engine.recover.mockRejectedValueOnce(new Error('Provider unavailable (503). Keep the original purchase and retry recovery.'));
  render(<Host client={f.client}/>);await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
  expect(screen.getByText(/Automatic checks are running/)).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(9999);});
  expect(screen.getByText(text)).toBeTruthy();expect(f.engine.recover).toHaveBeenCalledTimes(2);expect(f.engine.submit).not.toHaveBeenCalled();
});
test.each(['Another Shadow tab is using this wallet.', 'Another tab is using this purchase.'])('temporary cross-tab contention resumes the original report: %s',async(message)=>{
  vi.useFakeTimers();const f=fixture(),text=`original report ${counter}`;f.engine.recover.mockRejectedValueOnce(new Error(message));
  render(<Host client={f.client}/>);await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
  expect(screen.getByText(text)).toBeTruthy();expect(f.engine.recover).toHaveBeenCalledTimes(2);expect(f.engine.submit).not.toHaveBeenCalled();
});
test('an unreadable verified result ends automatic progress and never starts another payment',async()=>{
  const f=fixture();f.engine.recover.mockImplementation(async()=>({...f.delivered(),bytes:new Uint8Array([255])}));
  render(<Host client={f.client}/>);await screen.findByText('The verified service result is not readable UTF-8 text. Keep the original purchase.');
  await waitFor(()=>expect(screen.queryByText(/Automatic checks are running/)).toBeNull());expect(f.engine.recover).toHaveBeenCalledTimes(1);expect(f.engine.submit).not.toHaveBeenCalled();
});

test('a wrapped RPC outage resumes the original report without a wallet request',async()=>{
  vi.useFakeTimers();const f=fixture(),text=`original report ${counter}`;
  const rpc=new BaseError('RPC read eth_call failed: HTTP request failed. Status: 503',{cause:new BaseError('HTTP request failed.',{details:'Status: 503'})});
  f.engine.recover.mockRejectedValueOnce(new BaseError('Contract function execution failed.',{cause:rpc}));
  render(<Host client={f.client}/>);await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
  expect(screen.getByText(text)).toBeTruthy();expect(f.engine.recover).toHaveBeenCalledTimes(2);expect(f.engine.submit).not.toHaveBeenCalled();
});
test('archiving retains a reachable report while opening history leaves the active purchase empty',async()=>{
  const f=fixture(),text=`original report ${counter}`;render(<Host client={f.client}/>);await screen.findByText(text);
  fireEvent.click(screen.getByRole('button',{name:'Archive completed report'}));
  const open=await screen.findByRole('button',{name:/Open report/});expect(screen.queryByText(text)).toBeNull();
  fireEvent.click(open);await screen.findByText('retained report');expect(f.engine.load()).toBeNull();
  expect(f.engine.recoverArchived).toHaveBeenCalledWith(f.digest);expect(f.engine.prepare).not.toHaveBeenCalled();expect(f.engine.submit).not.toHaveBeenCalled();
});
test('an archived read settling after unmount wakes recovery of the new active journal',async()=>{
  const f=fixture(),text=`original report ${counter}`;const older={...f.engine.load(),stage:'delivered',intent:{...f.engine.load().intent,digest:`0x${'77'.repeat(32)}`}};
  f.archived.push(older);let settle!: (value:any)=>void;
  f.engine.recoverArchived.mockImplementation(()=>new Promise(resolve=>{settle=resolve;}));
  render(<Host client={f.client}/>);await screen.findByText(text);fireEvent.click(screen.getByRole('button',{name:/Open report/}));
  await waitFor(()=>expect(f.engine.recoverArchived).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('Leave funding'));
  const next={...f.engine.load(),stage:'submitted',requestId:'second-purchase',intent:{...f.engine.load().intent,digest:`0x${'88'.repeat(32)}`}};f.replaceSaved(next);
  fireEvent.click(screen.getByText('Return to purchase'));expect(f.engine.recover).toHaveBeenCalledTimes(1);
  await act(async()=>{settle({record:older,status:'delivered',bytes:new TextEncoder().encode('old historical report')});});
  await waitFor(()=>expect(f.engine.recover).toHaveBeenCalledTimes(2));await screen.findByText(text);
  expect(screen.queryByText('old historical report')).toBeNull();expect(f.engine.load().intent.digest).toBe(next.intent.digest);expect(f.engine.submit).not.toHaveBeenCalled();
});
