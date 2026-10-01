import { gatewayAssert as assert } from './gateway-reserve-assert.mjs';
import { validateGatewayIntent, GATEWAY_TESTNET } from './gateway-reserve.mjs';

const phases = new Set(['approve-deposit', 'deposit', 'attestation', 'mint', 'approve-reserve', 'open']);
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const copy = value => JSON.parse(JSON.stringify(value));

/** Browser-profile recovery storage for one sponsor-owned funding operation.
 * Web Locks serialize tabs; localStorage is written and read back before an
 * effect is allowed. Neither protects a different device or cleared site data.
 * Only a mint with exact verified receipt evidence can be archived. Unknown
 * attempts cannot be reset. Archive before preparing another withdrawal.
 */
export function createGatewayBrowserJournal({ account, storage = globalThis.localStorage, locks = globalThis.navigator?.locks }) {
  assert.match(account, /^0x[0-9a-fA-F]{40}$/, 'Invalid sponsor account');
  assert.notEqual(BigInt(account), 0n, 'Invalid sponsor account');
  assert(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function', 'Recovery storage is unavailable');
  assert(locks && typeof locks.request === 'function', 'This browser cannot safely coordinate funding across tabs');
  const sponsor = account.toLowerCase();
  const key = `shadow:gateway:${GATEWAY_TESTNET.chainId}:${sponsor}:v1`;
  let locked = false;

  function checkRecord(record) {
    assert(record && record.version === 1 && record.account === sponsor && record.chainId === GATEWAY_TESTNET.chainId, 'Invalid saved Gateway recovery record; keep site data');
    assert.equal(validateGatewayIntent(record.intent, sponsor), record.operation, 'Saved Gateway identity changed');
    assert(record.steps && Object.getPrototypeOf(record.steps) === Object.prototype, 'Invalid saved Gateway steps');
    for (const [phase, step] of Object.entries(record.steps)) {
      assert(phases.has(phase), 'Unknown saved Gateway step');
      assert(step && ['unknown', 'confirmed'].includes(step.status) && typeof step.createdAt === 'string' && Number.isFinite(Date.parse(step.createdAt)), 'Invalid saved Gateway step state');
      assert(Object.hasOwn(step, 'request') && step.request !== null && typeof step.request === 'object', 'Missing saved Gateway request');
      assert(step.status !== 'confirmed' || (step.evidence !== null && typeof step.evidence === 'object'), 'Missing Gateway confirmation evidence');
    }
    return record;
  }
  function load() {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    try { return checkRecord(JSON.parse(raw)); }
    catch (cause) { throw new Error('Gateway recovery data is invalid. Keep site data; no new funding attempt is allowed.', { cause }); }
  }
  function save(record) {
    assert(locked, 'Gateway writes require the sponsor tab lock');
    const serialized = JSON.stringify(checkRecord(record));
    storage.setItem(key, serialized);
    assert.equal(storage.getItem(key), serialized, 'Recovery storage did not retain the write; no further action is allowed');
  }
  async function withLock(_name, callback) {
    return locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
      assert(lock, 'Gateway funding is already active in another tab');
      assert(!locked, 'Gateway funding is already active');
      locked = true;
      try { return await callback(); } finally { locked = false; }
    });
  }
  function phaseFor(stepKey, record) {
    const prefix = `gateway:${record.operation}:`;
    assert(stepKey.startsWith(prefix), 'Gateway operation does not match the saved funding intent');
    const phase = stepKey.slice(prefix.length);
    assert(phases.has(phase), 'Unknown Gateway funding phase');
    return phase;
  }
  return {
    key, load, withLock,
    async archiveMint() {
      return withLock('archive', async () => {
        const record = load(), mint = record?.steps.mint;
        assert(mint?.status === 'confirmed' && mint.evidence?.event === 'AttestationUsed' &&
          hex32.test(mint.evidence?.hash ?? '') && (!mint.response?.hash || mint.response.hash === mint.evidence.hash),
        'Only a verified Gateway withdrawal can be archived');
        const archiveKey = `${key}:archive:${record.operation}`;
        const serialized = JSON.stringify(record);
        storage.setItem(archiveKey, serialized);
        assert.equal(storage.getItem(archiveKey), serialized, 'Gateway archive was not retained');
        storage.removeItem(key);
        assert.equal(storage.getItem(key), null, 'Gateway active record was not cleared');
      });
    },
    async retryUnsentMint() {
      return withLock('retry', async () => {
        const record = load();
        const mint = record?.steps.mint;
        assert(mint?.status === 'confirmed' && mint.response?.notSubmitted === true &&
          mint.evidence?.notSubmitted === true && !mint.response.hash,
        'An uncertain Gateway mint cannot be retried');
        record.unsentMints = [...(record.unsentMints ?? []), mint];
        delete record.steps.mint;
        save(record);
      });
    },
    async begin(intent) {
      const operation = validateGatewayIntent(intent, sponsor);
      assert.match(operation, hex32);
      return withLock('begin', async () => {
        const prior = load();
        if (prior) {
          assert.deepEqual(prior.intent, intent, 'Resolve the existing Gateway funding operation before starting another');
          return prior;
        }
        const record = { version: 1, chainId: GATEWAY_TESTNET.chainId, account: sponsor, operation, intent: copy(intent), steps: {} };
        save(record);
        return copy(record);
      });
    },
    async get(stepKey) {
      const record = load();
      assert(record, 'Prepare and save the Gateway funding intent first');
      return record.steps[phaseFor(stepKey, record)] ?? null;
    },
    async put(stepKey, step) {
      assert(locked, 'Gateway writes require the sponsor tab lock');
      const record = load();
      assert(record, 'Saved Gateway funding intent is missing; stop and investigate');
      const phase = phaseFor(stepKey, record);
      const prior = record.steps[phase];
      if (prior) {
        assert.deepEqual(prior.request, step.request, 'A saved Gateway request cannot change');
        assert.equal(prior.createdAt, step.createdAt, 'A saved Gateway attempt cannot change');
        if (Object.hasOwn(prior, 'response')) assert.deepEqual(prior.response, step.response, 'A saved Gateway response cannot change');
        if (prior.status === 'confirmed') assert.deepEqual(prior, step, 'A confirmed Gateway outcome cannot change');
      }
      record.steps[phase] = copy(step);
      save(record);
    },
  };
}
