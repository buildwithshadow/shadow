import { MemoryRouter, useLocation } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const h = vi.hoisted(() => ({ snapshot: vi.fn(), line: vi.fn(), receipt: vi.fn(), reconcile: vi.fn(), chain: vi.fn(), code: vi.fn(), pending: null as any, kit: null as any }));
vi.mock('../src/candidateFunding', async original => {
  const actual = await original<any>();
  return { ...actual, createCandidateFundingKit: () => h.kit };
});
vi.mock('../src/fundingJourney', async original => ({ ...await original<any>(), usesTestnetFundingJourney: () => true }));
vi.mock('viem', async original => ({ ...await original<any>(), createPublicClient: () => ({ waitForTransactionReceipt: h.receipt, getChainId: h.chain, getCode: h.code }) }));
vi.mock('../src/PublicPurchase', () => ({ PublicPurchase: ({ loadedLine, onPurchaseChanged }: any) => <><output>Loaded reserve: {loadedLine ? String(loadedLine.availableReserve) : 'none'}</output><button onClick={() => void onPurchaseChanged(lineId, txHash)}>Observe confirmed purchase</button></> }));
vi.mock('../src/CircleAgentHandoff', () => ({ CircleAgentHandoff: () => null }));
vi.mock('../src/FundingCycleTracker', () => ({ LineLifecycle: () => null, useCycleReportChecks: () => ({ reports: [], deliveryChecked: () => {} }) }));
import { CandidateFundingDesk } from '../src/CandidateFundingDesk';
import { CANDIDATE_FUNDING } from '../src/candidateFunding';
const account = '0x1111111111111111111111111111111111111111';
const lineId = `0x${'22'.repeat(32)}`;
const txHash = `0x${'33'.repeat(32)}`;
const service: any = { name: 'Report', provider: account, endpoint: 'https://example.com/report', providerUrl: 'https://example.com', principal: '5000' };
const snapshot = { sponsor: account, sponsorAllowed: true, observedBlock: 101n, balance: 1000000n, allowance: 0n, openingsPaused: false };
const line: any = { lineId, sponsor: account, agent: account, stateName: 'OPEN', state: 1, availableReserve: 100000n, reserveCap: 100000n, recoveryAvailable: 0n, principalOutstanding: 0n, cumulativePrincipalPaid: 0n, lineSpendCap: 5000n, dailySpendCap: 5000n, expiry: 2000000000n, dueAt: 0n, epoch: 1n, sponsorAllowed: true, spendsPaused: true, observedBlock: 101n, observedTimestamp: 1000n };
function Path() { return <output data-testid="path">{useLocation().pathname}</output>; }
function mount(path = '/start/fund') { render(<MemoryRouter initialEntries={[path]}><Path/><CandidateFundingDesk deployment={CANDIDATE_FUNDING} service={service}/></MemoryRouter>); }
beforeEach(() => {
  h.snapshot.mockReset(); h.line.mockReset(); h.reconcile.mockReset(); h.receipt.mockReset();
  h.chain.mockReset(); h.code.mockReset();
  h.receipt.mockResolvedValue({ status: 'success', blockNumber: 101n });
  h.pending = { kind: 'open', account, nonce: '1', txHash, lineId, chainId: 5042002 };
  h.kit = { createCandidateJournal: () => ({ load: () => h.pending, clear: () => { h.pending = null; } }), readCandidateSnapshot: h.snapshot, readCandidateLine: h.line, reconcileCandidatePending: h.reconcile };
  h.snapshot.mockResolvedValue(snapshot); h.line.mockResolvedValue(line);
  h.reconcile.mockResolvedValue({ status: 'confirmed', txHash, lineId, confirmedBlock: 101n, message: 'Line opening confirmed.' });
  Object.defineProperty(window, 'ethereum', { configurable: true, value: { request: vi.fn(async ({ method }) => method === 'eth_accounts' ? [account] : '0x4cef52') } });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_: unknown, __: unknown, run: any) => run({}) } });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  window.localStorage.clear(); window.sessionStorage.clear();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
test('guided saved-transaction recovery finishes cleanup before navigation and retains sponsor status', async () => {
  let resolveSnapshot!: (value: any) => void;
  h.snapshot.mockImplementationOnce(async () => snapshot).mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve; }));
  mount();
  await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/start/line'));
  await waitFor(() => expect(h.snapshot.mock.calls.length).toBeGreaterThanOrEqual(2));
  await act(async () => resolveSnapshot(snapshot));
  await waitFor(() => expect(screen.queryByText('Updating the funding line from the chain…')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Start a new funding line' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create a funding line' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/start/agent'));
  expect(screen.queryByText('Register once. Fund when you choose.')).toBeNull();
});
test('a lagging line read does not prevent the independent sponsor read or require wallet refresh', async () => {
  h.line.mockRejectedValueOnce(Error('RPC has not reached the confirmed block'));
  mount();
  await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/start/line'));
  await waitFor(() => expect(h.snapshot.mock.calls.length).toBeGreaterThanOrEqual(2));
  await screen.findByRole('button', { name: 'Start a new funding line' });
  fireEvent.click(screen.getByRole('button', { name: 'Start a new funding line' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create a funding line' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/start/agent'));
  expect(h.reconcile).toHaveBeenCalledTimes(1);
});
test('sponsor status retries after its own RPC failure without reloading the wallet', async () => {
  h.snapshot.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(Error('Sponsor RPC behind')).mockResolvedValue(snapshot);
  mount();
  await screen.findByText(/Automatic refresh will try again/);
  fireEvent.focus(window);
  await waitFor(() => expect(screen.queryByText(/Automatic refresh will try again/)).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Start a new funding line' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create a funding line' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/start/agent'));
  expect(h.line.mock.calls.some(call => call[2] === 101n)).toBe(true);
  expect((window.ethereum!.request as any).mock.calls.every(([request]: any) => ['eth_accounts', 'eth_chainId'].includes(request.method))).toBe(true);
});

test('confirmed purchases hide prepayment balances while the RPC catches up', async () => {
  h.pending = null;
  mount(`/start/purchase?line=${lineId}`);
  await screen.findByText('Loaded reserve: 100000');
  h.line.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole('button', { name: 'Observe confirmed purchase' }));
  await screen.findByText('Loaded reserve: none');
  expect(h.receipt).toHaveBeenCalledWith({ hash: txHash, timeout: 45000 });
});

test('opening a transaction review stops the rest of an in-flight background line check', async () => {
  h.pending = null;
  h.kit.prepareCandidateReclaim = vi.fn(async () => ({
    kind: 'close', account, to: CANDIDATE_FUNDING.address, data: '0x', value: '0', amount: 100000n,
    lineId, agent: account, expectedEpoch: 1n, observedBlock: 101n, summary: 'Close this line.',
  }));
  mount(`/start/line?line=${lineId}`);
  await screen.findByRole('button', { name: 'Review close and reclaim' });
  let release!: (value: number) => void;
  h.chain.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  h.line.mockImplementation(async (client: any) => {
    await client.getChainId();
    await client.getCode({ address: account });
    return line;
  });
  fireEvent.focus(window);
  await waitFor(() => expect(h.chain).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Review close and reclaim' }));
  await screen.findByRole('heading', { name: 'Reclaim eligible funds' });
  await act(async () => release(5042002));
  expect(h.code).not.toHaveBeenCalled();
  expect(h.kit.prepareCandidateReclaim).toHaveBeenCalledTimes(1);
  expect((window.ethereum!.request as any).mock.calls.every(([request]: any) => ['eth_accounts', 'eth_chainId'].includes(request.method))).toBe(true);
});
