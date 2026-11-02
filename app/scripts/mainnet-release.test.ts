import assert from 'node:assert/strict';
import test from 'node:test';
import { mainnetRelease } from '../src/mainnetRelease.ts';
import { PUBLIC_MAINNET, PUBLIC_MAINNET_SERVICE } from '../src/publicMainnet.ts';
import { LEGACY_PUBLIC_MAINNET, LEGACY_PUBLIC_MAINNET_SERVICE } from '../src/legacyPublicMainnet.ts';

test('new activity selects settled while unversioned existing line links stay legacy', () => {
  assert.equal(mainnetRelease(''), 'settled');
  assert.equal(mainnetRelease('?role=agent'), 'settled');
  assert.equal(mainnetRelease('?agent=0x1234'), 'settled');
  assert.equal(mainnetRelease('?line=0x1234'), 'legacy');
  assert.equal(mainnetRelease('?line=0x1234&deployment=settled'), 'settled');
  assert.equal(mainnetRelease('?deployment=legacy'), 'legacy');
});
test('ambiguous deployment links stop rather than selecting another contract', () => {
  for (const query of ['?deployment=', '?deployment=unknown', '?deployment=legacy&deployment=settled', '?deployment=settled&deployment=settled']) assert.equal(mainnetRelease(query), null);
});
test('new and old releases keep distinct contract, runtime and service identities', () => {
  assert.equal(PUBLIC_MAINNET.address, '0x2D868A718C5d8d6dF15E3C13c1a134C71cB0b218');
  assert.equal(PUBLIC_MAINNET.accountingModel, 'settled-v1');
  assert.equal(PUBLIC_MAINNET.maxLineSpend, 50000n);
  assert.equal(LEGACY_PUBLIC_MAINNET.address, '0xcA819e8713b04a4Bd7e437c04BB97ac9274e2ce5');
  assert.notEqual(PUBLIC_MAINNET.runtimeHash, LEGACY_PUBLIC_MAINNET.runtimeHash);
  assert.notEqual(PUBLIC_MAINNET_SERVICE.endpoint, LEGACY_PUBLIC_MAINNET_SERVICE.endpoint);
  assert.equal(PUBLIC_MAINNET_SERVICE.principal, '5000');
  assert.equal(LEGACY_PUBLIC_MAINNET.maxLineSpend, 5000n);
});
