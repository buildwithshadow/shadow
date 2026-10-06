import assert from 'node:assert/strict';

// The browser engine needs synchronous Storage reads. Writes are queued through
// the protected journal, and every external side effect must await flush first.
export async function createCircleRunnerState({ journal, agent, line, contract, chainId = 5042002 }) {
  const normalize = (value, size) => {
    assert.match(value, new RegExp(`^0x[0-9a-fA-F]{${size}}$`));
    return value.toLowerCase();
  };
  const identity = { agent: normalize(agent, 40), line: normalize(line, 64), contract: normalize(contract, 40), chainId };
  const key = `runner-state:${chainId}:${identity.contract}:${identity.agent}:${identity.line}`;
  const state = await journal.get(key) ?? { version: 1, ...identity, storage: {}, requests: {} };
  assert.equal(state.version, 1, 'Unsupported runner state version');
  for (const [name, value] of Object.entries(identity)) assert.equal(state[name], value, 'Runner journal identity mismatch');
  assert(state.storage && typeof state.storage === 'object' && !Array.isArray(state.storage));
  assert(state.requests && typeof state.requests === 'object' && !Array.isArray(state.requests));
  function validateValue(value) {
    assert.equal(typeof value, 'string', 'Runner storage must contain serialized records');
    const record = JSON.parse(value);
    assert(record.intent?.typedData?.message, 'Runner purchase record has no intent');
    const message = record.intent.typedData.message;
    assert.equal(normalize(message.lineId, 64), identity.line, 'Saved purchase belongs to another funding line');
    assert.equal(normalize(message.agent, 40), identity.agent, 'Saved purchase belongs to another agent');
    assert.equal(normalize(record.account, 40), identity.agent, 'Saved purchase account changed');
    assert.equal(normalize(record.contract, 40), identity.contract, 'Saved purchase belongs to another contract');
    assert.equal(record.chainId, chainId, 'Saved purchase belongs to another chain');
  }
  for (const value of Object.values(state.storage)) validateValue(value);
  let queued = Promise.resolve(), failure;
  function enqueue() {
    if (failure) throw failure;
    const snapshot = JSON.parse(JSON.stringify(state));
    queued = queued.then(async () => {
      if (failure) return;
      try { await journal.put(key, snapshot); } catch (error) { failure = error; }
    });
  }
  async function flush() { await queued; if (failure) throw failure; }
  async function save() { enqueue(); await flush(); }
  const storage = {
    getItem: name => Object.hasOwn(state.storage, name) ? state.storage[name] : null,
    setItem(name, value) { if (failure) throw failure; validateValue(value); state.storage[name] = value; enqueue(); },
    removeItem(name) { if (failure) throw failure; delete state.storage[name]; enqueue(); },
  };
  return { state, storage, save, flush, key };
}
