import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { MainnetFundingPage } from '../src/MainnetFundingPage';

vi.mock('../src/CandidateFundingDesk', () => ({ CandidateFundingDesk: ({deployment, service, purchaseOnly}: any) =>
  <section aria-label="Selected release"><p>{deployment.address}</p><p>{service.endpoint}</p><p>{purchaseOnly ? 'Purchase workspace' : 'Funding desk'}</p></section> }));
afterEach(cleanup);

test.each([
  ['/mainnet/purchase?line=0x1234&deployment=settled', '0x2D868A718C5d8d6dF15E3C13c1a134C71cB0b218'],
  ['/mainnet/purchase?line=0x1234', '0xcA819e8713b04a4Bd7e437c04BB97ac9274e2ce5'],
])('purchase navigation preserves the funding link release: %s', (url, contract) => {
  render(<MemoryRouter initialEntries={[url]}><MainnetFundingPage/></MemoryRouter>);
  expect(screen.getByText(contract)).toBeTruthy();
  expect(screen.getByText('Purchase workspace')).toBeTruthy();
});

test('an ambiguous release cannot render a wallet capable funding desk', () => {
  render(<MemoryRouter initialEntries={['/mainnet/purchase?deployment=legacy&deployment=settled']}><MainnetFundingPage/></MemoryRouter>);
  expect(screen.getByRole('region', {name:'Unknown mainnet release'})).toBeTruthy();
  expect(screen.queryByRole('region', {name:'Selected release'})).toBeNull();
});

test('the existing mainnet route keeps its funding desk', () => {
  render(<MemoryRouter initialEntries={['/mainnet']}><MainnetFundingPage/></MemoryRouter>);
  expect(screen.getByText('Funding desk')).toBeTruthy();
});
