import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const h = vi.hoisted(() => ({ snapshot: vi.fn(), line: vi.fn(), receipt: vi.fn(), reconcile: vi.fn(), chain: vi.fn(), code: vi.fn(), pending: null as any, kit: null as any }));
vi.mock('../src/candidateFunding', async original => {
  const actual = await original<any>();
  return { ...actual, createCandidateFundingKit: () => h.kit, createSettledPublicMainnetFundingKit: () => h.kit };
});
vi.mock('viem', async original => ({ ...await original<any>(), createPublicClient: () => ({ waitForTransactionReceipt: h.receipt, getChainId: h.chain, getCode: h.code }) }));
vi.mock('../src/PublicPurchase', () => ({ PublicPurchase: ({ loadedLine, onPurchaseChanged }: any) => <><output>Loaded reserve: {loadedLine ? String(loadedLine.availableReserve) : 'none'}</output><button onClick={() => void onPurchaseChanged(lineId, txHash)}>Observe confirmed purchase</button></> }));
vi.mock('../src/CircleAgentHandoff', () => ({ CircleAgentHandoff: () => null }));
vi.mock('../src/FundingCycleTracker', () => ({ LineLifecycle: () => null, useCycleReportChecks: () => ({ reports: [], deliveryChecked: () => {} }) }));
import { CandidateFundingDesk } from '../src/CandidateFundingDesk';
import { CANDIDATE_FUNDING } from '../src/candidateFunding';
import { PUBLIC_MAINNET } from '../src/publicMainnet';
const mainnet = PUBLIC_MAINNET;
const account = '0x1111111111111111111111111111111111111111';
const lineId = `0x${'22'.repeat(32)}`;
const txHash = `0x${'33'.repeat(32)}`;
const service: any = { name: 'Report', provider: account, endpoint: 'https://example.com/report', providerUrl: 'https://example.com', principal: '5000' };
const snapshot = { sponsor: account, sponsorAllowed: true, observedBlock: 101n, balance: 1000000n, allowance: 0n, openingsPaused: false };
const line: any = { lineId, sponsor: account, agent: account, stateName: 'OPEN', state: 1, availableReserve: 100000n, reserveCap: 100000n, recoveryAvailable: 0n, principalOutstanding: 0n, cumulativePrincipalPaid: 0n, lineSpendCap: 5000n, dailySpendCap: 5000n, expiry: 2000000000n, dueAt: 0n, epoch: 1n, sponsorAllowed: true, spendsPaused: true, observedBlock: 101n, observedTimestamp: 1000n };
function Path() { const loc=useLocation(), go=useNavigate(); return <><output data-testid="path">{loc.pathname}{loc.search}</output><button onClick={()=>go(-1)}>Browser Back</button></>; }
function mount(path = `/mainnet?deployment=settled&agent=${account}`) { render(<MemoryRouter initialEntries={[path]}><Path/><CandidateFundingDesk deployment={mainnet} service={service} mainnetRelease="settled"/></MemoryRouter>); }
beforeEach(() => {
  h.snapshot.mockReset(); h.line.mockReset(); h.reconcile.mockReset(); h.receipt.mockReset();
  h.chain.mockReset(); h.code.mockReset();
  h.receipt.mockResolvedValue({ status: 'success', blockNumber: 101n });
  h.pending = null;
  h.kit = { createCandidateJournal: () => ({ load: () => h.pending, clear: () => { h.pending = null; } }), readCandidateSnapshot: h.snapshot, readCandidateLine: h.line, reconcileCandidatePending: h.reconcile };
  h.snapshot.mockResolvedValue(snapshot); h.line.mockResolvedValue(line);
  h.reconcile.mockResolvedValue({ status: 'confirmed', txHash, lineId, confirmedBlock: 101n, message: 'Line opening confirmed.' });
  Object.defineProperty(window, 'ethereum', { configurable: true, value: { request: vi.fn(async ({ method }) => method === 'eth_accounts' ? [account] : '0x13b2') } });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_: unknown, __: unknown, run: any) => run({}) } });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  window.localStorage.clear(); window.sessionStorage.clear();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('budget review is navigation only and browser Back preserves edits',async()=>{
  mount();
  await waitFor(()=>expect((screen.getByRole('button',{name:'Review funding plan'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Agent wallet address'),{target:{value:account}});
  fireEvent.change(screen.getByLabelText('USDC to set aside'),{target:{value:'0.01'}});
  fireEvent.click(screen.getByRole('button',{name:'Review funding plan'}));
  await screen.findByRole('heading',{name:'Review your funding plan'});
  expect(screen.getByTestId('path').textContent).toContain('deployment=settled');
  expect(screen.getByTestId('path').textContent).toContain('step=review');
  expect((screen.getByRole('button',{name:'Review funding transaction'}) as HTMLButtonElement).disabled).toBe(true);
  expect((window.ethereum!.request as any).mock.calls.every(([r]:any)=>['eth_accounts','eth_chainId'].includes(r.method))).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Browser Back'}));
  await screen.findByLabelText('USDC to set aside');
  expect((screen.getByLabelText('USDC to set aside') as HTMLInputElement).value).toBe('0.01');
});
test('direct review without a wallet cannot prepare a transaction and can return to setup',async()=>{
  (window.ethereum!.request as any).mockImplementation(async({method}:any)=>method==='eth_accounts'?[]:'0x13b2');
  mount('/mainnet?deployment=settled&step=review');
  await screen.findByRole('heading',{name:'Review your funding plan'});
  expect((screen.getByRole('button',{name:'Review funding transaction'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Edit budget'}));
  await screen.findByLabelText('Agent wallet address');
  expect(screen.getByTestId('path').textContent).not.toContain('step=review');
});

test('account changes clear review consent and require the new sponsor status',async()=>{
  const listeners: Record<string,()=>void> = {};
  let current = account;
  const provider: any = window.ethereum;
  provider.on = (name:string, callback:()=>void) => { listeners[name]=callback; };
  provider.removeListener = vi.fn();
  provider.request.mockImplementation(async({method}:any)=>method==='eth_accounts'?[current]:'0x13b2');
  mount(`/mainnet?deployment=settled&step=review&agent=${account}`);
  await screen.findByText('Arc mainnet connected');
  await screen.findByText('1 USDC available');
  const consent = await screen.findByRole('checkbox');
  fireEvent.click(consent);
  expect((consent as HTMLInputElement).checked).toBe(true);
  current='0x4444444444444444444444444444444444444444';
  await act(async()=>listeners.accountsChanged());
  await waitFor(()=>expect((consent as HTMLInputElement).checked).toBe(false));
  expect((screen.getByRole('button',{name:'Review funding transaction'}) as HTMLButtonElement).disabled).toBe(true);
});
