import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeHold, runMonitorOnce } from './float-mainnet-monitor-runner.mjs';
import { loadMainnetContext, notificationState, notifyMainnet } from './float-mainnet-monitor-alerts.mjs';

const now = 1800000000000;
const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-mainnet-alerts-'));
  const limits = { protocolReserve: '100', lineReserve: '100', lineSpend: '100', perSpend: '50', dailySpend: '100' };
  const identity = { chainId: '5042', address: addr(1), runtimeCodeHash: hash(1), usdc: '0x3600000000000000000000000000000000000000', deployBlock: '10' };
  const baseline = { schemaVersion: 1, identity, owner: addr(2), operators: [], sponsors: [], effectiveLimits: limits,
    pauses: { openingsPaused: true, spendsPaused: true }, lines: [], executor: { address: addr(3), fromBlock: '10' },
    policy: { intervalMs: 1000, runTimeoutMs: 5000, maxHeartbeatAgeMs: 10000, maxBlockAgeSeconds: 120, maxIndexLagSeconds: 120, warnBeforeSeconds: 3600, requireIndex: false } };
  const manifest = { ok: true, chainId: '5042', contract: { address: addr(1) }, bytecode: { onchainRuntimeKeccak256: hash(1) }, deployment: { blockNumber: '10' } };
  const options = { baselinePath: join(directory, 'baseline.json'), manifestPath: join(directory, 'manifest.json'), stateDir: join(directory, 'state') };
  writeFileSync(options.baselinePath, JSON.stringify(baseline)); writeFileSync(options.manifestPath, JSON.stringify(manifest));
  const context = loadMainnetContext(options);
  const snapshot = { ok: true, identity, observedAt: { blockNumber: '100', blockHash: hash(100), timestamp: String(now / 1000) },
    contract: { address: addr(1), owner: addr(2), pendingOwner: addr(0), ...baseline.pauses, effectiveLimits: limits, pendingCapIncreases: [], operators: [], totalSponsorObligations: '0', totalCommittedCapital: '0' },
    sponsors: [], discovery: { lines: 0, scanned: { fromBlock: '10', toBlock: '100' }, index: null }, lines: [], alerts: [],
    accounting: { ok: true, balance: '0', checks: ['balanceCoversObligations', 'obligationsEqualLines', 'committedCapitalEqualsLines', 'linesMatchReserveCap'].map(id => ({ id, status: 'PASS' })) },
    executionAudit: { fromBlock: '10', toBlock: '100', executions: [] } };
  return { context, snapshot, options, manifest, baseline, cleanup: () => rmSync(directory, { recursive: true, force: true }),
    run: (time = now, collect = async () => snapshot) => runMonitorOnce(context, { now: () => time, collect }) };
}

test('mainnet alerts bind manifest to approved deployment and reject testnet/mismatched files', () => {
  const f = fixture();
  try {
    for (const mutate of [m => m.ok = false, m => m.chainId = '5042002', m => m.contract.address = addr(7), m => m.bytecode.onchainRuntimeKeccak256 = hash(7), m => m.deployment.blockNumber = '11']) {
      const m = structuredClone(f.manifest); mutate(m); writeFileSync(f.options.manifestPath, JSON.stringify(m));
      assert.throws(() => loadMainnetContext(f.options));
    }
    f.baseline.identity.chainId = '5042002';
    writeFileSync(f.options.baselinePath, JSON.stringify(f.baseline));
    assert.throws(() => loadMainnetContext(f.options));
    assert.throws(() => notificationState({ ...f.context, baseline: f.baseline }, now), /MAINNET_ONLY/);
  } finally { f.cleanup(); }
});

test('missing, corrupt, stale and forged healthy state alerts through runner validation', async () => {
  const f = fixture();
  try {
    assert.equal(notificationState(f.context, now).ok, false);
    await f.run(); assert.equal(notificationState(f.context, now).ok, true);
    assert.equal(notificationState(f.context, now + 10001).ok, false);
    writeFileSync(join(f.context.stateDir, 'snapshot.json'), '{}');
    assert.ok(notificationState(f.context, now).codes.includes('SNAPSHOT_BINDING_MISMATCH'));
    writeFileSync(join(f.context.stateDir, 'heartbeat.json'), '{');
    assert.equal(notificationState(f.context, now).ok, false);
  } finally { f.cleanup(); }
});

test('bounded check is quiet but release drift, stale check and latched hold are never suppressed', async () => {
  const f = fixture(); let finish;
  try {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const running = f.run(now, async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
    await started;
    assert.equal(notificationState(f.context, now), null);
    writeFileSync(join(f.context.stateDir, 'publication.json'), '{');
    assert.equal(notificationState(f.context, now).ok, false);
    rmSync(join(f.context.stateDir, 'publication.json'));
    assert.equal(notificationState(f.context, now + 5001).ok, false);
    assert.equal(notificationState({ ...f.context, manifestHash: 'changed' }, now).ok, false);
    writeFileSync(join(f.context.stateDir, 'hold.json'), JSON.stringify({ incidentId: 'existing-incident' }));
    assert.ok(notificationState(f.context, now).codes.includes('HOLD_LATCHED'));
    finish(f.snapshot); await running;
    assert.equal(notificationState(f.context, now).ok, false);
  } finally { f.cleanup(); }
});

test('failure persists across healthy scans; recovery notifies only after explicit acknowledgement', async () => {
  const f = fixture(); let previous; const messages = [];
  const notify = (time = now, context = f.context, destinationId = '-123') => notifyMainnet({ context, previous, destinationId, now: time,
    send: async m => messages.push(m), save: async p => { previous = p; } });
  try {
    await f.run(); await notify(); await notify(); assert.equal(messages.length, 1); assert.match(messages[0], /MAINNET.*CONNECTED/);
    await f.run(now + 1, async () => { throw Error('https://secret@rpc.invalid'); });
    await notify(now + 1); await notify(now + 1); assert.equal(messages.length, 2); assert.match(messages[1], /ATTENTION/);
    assert.doesNotMatch(messages[1], /secret|rpc.invalid/);
    const recovering = await f.run(now + 2);
    await notify(now + 2); assert.doesNotMatch(messages.at(-1), /RECOVERED/);
    acknowledgeHold(f.context, recovering.incidentId, now + 2);
    await notify(now + 2); assert.match(messages.at(-1), /RECOVERED/);
    const count = messages.length; await notify(now + 2); assert.equal(messages.length, count);
    await notify(now + 2, f.context, '-456'); assert.match(messages.at(-1), /CONNECTED/);
    await notify(now + 2, { ...f.context, manifestHash: 'different' }, '-456'); assert.match(messages.at(-1), /ATTENTION/);
  } finally { f.cleanup(); }
});

test('delivery failures retry, six-hour reminders recur, and changed failure codes notify immediately', async () => {
  const f = fixture(); let previous; let sent = 0;
  const notify = time => notifyMainnet({ context: f.context, previous, destinationId: '-123', now: time, send: async () => { sent++; }, save: async p => { previous = p; } });
  try {
    await assert.rejects(notifyMainnet({ context: f.context, destinationId: '-123', now, send: async () => { throw Error('offline'); }, save: async () => assert.fail('must not save') }));
    await notify(now); await notify(now); assert.equal(sent, 1);
    await notify(now + 21600000); assert.equal(sent, 2);
    await f.run(now, async () => { throw Error('offline'); });
    await notify(now); assert.equal(sent, 3);
    assert.deepEqual(readFileSync(join(f.context.stateDir, 'hold.json'), 'utf8').includes('secret'), false);
    await assert.rejects(notifyMainnet({ context: f.context, destinationId: 'invalid', send: async () => assert.fail(), save: async () => assert.fail() }));
  } finally { f.cleanup(); }
});

test('a newly latched incident with the same codes alerts even if recovery was not observed', async () => {
  const f = fixture(); let previous; const messages = [];
  const fail = async () => { throw Error('offline'); };
  const notify = time => notifyMainnet({ context: f.context, previous, destinationId: '-123', now: time,
    send: async m => messages.push(m), save: async p => { previous = p; } });
  try {
    const first = await f.run(now, fail); await notify(now);
    const firstKey = previous.key;
    const recovered = await f.run(now + 1);
    acknowledgeHold(f.context, recovered.incidentId, now + 1);
    // No notification timer runs during the brief recovered interval.
    const second = await f.run(now + 2, fail);
    assert.notEqual(first.incidentId, second.incidentId);
    await notify(now + 2);
    assert.notEqual(previous.key, firstKey);
    assert.equal(messages.length, 2); assert.match(messages[1], /ATTENTION/);
    await notify(now + 2); assert.equal(messages.length, 2);
  } finally { f.cleanup(); }
});


test('a bounded scan of an already notified hold does not alternate transient failure alerts', async () => {
  const f = fixture(); let previous; const messages = []; let finish;
  const notify = (time = now, context = f.context) => notifyMainnet({ context, previous, destinationId: '-123', now: time,
    send: async m => messages.push(m), save: async p => { previous = p; } });
  try {
    await f.run(now, async () => { throw Error('RPC timed out'); });
    await notify(now);
    const completed = await f.run(now + 1); await notify(now + 1);
    const count = messages.length;
    let entered; const started = new Promise(resolve => { entered = resolve; });
    const running = f.run(now + 2, async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
    await started;
    const inFlight = notificationState(f.context, now + 2);
    assert.equal(inFlight.ok, false); assert.equal(inFlight.checking, true);
    assert.equal(inFlight.incidentId, completed.incidentId);
    assert.equal((await notify(now + 2)).reason, 'known-incident-scan-in-progress');
    assert.equal(messages.length, count);
    // A genuinely stuck scan and a changed binding still notify immediately.
    await notify(now + 5003); assert.equal(messages.length, count + 1);
    await notify(now + 3, { ...f.context, manifestHash: 'different' });
    assert.equal(messages.length, count + 2);
    finish(f.snapshot); await running;
    assert.equal(notificationState(f.context, now + 3).ok, false);
    assert.doesNotMatch(messages.join('\n'), /RECOVERED/);
  } finally { f.cleanup(); }
});

test('an unseen hold and malformed hold remain audible during a bounded scan', async () => {
  const f = fixture(); let finish;
  try {
    const failed = await f.run(now, async () => { throw Error('RPC timed out'); });
    await f.run(now + 1); // intact completed snapshot; incident has not been notified
    let entered; const started = new Promise(resolve => { entered = resolve; });
    const running = f.run(now + 1, async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
    await started;
    let message; let saved;
    const sent = await notifyMainnet({context:f.context,destinationId:'-123',now:now+1,send:async m=>{message=m;},save:async p=>{saved=p;}});
    assert.equal(sent.sent,true); assert.match(message,/HOLD_LATCHED/);assert.match(message,/Original incident: RPC_CHECK_FAILED/);
    assert.equal(saved.incidentId,failed.incidentId);
    writeFileSync(join(f.context.stateDir,'hold.json'), '{');
    assert.equal(notificationState(f.context,now+1).ok,false);
    assert.notEqual(notificationState(f.context,now+1).checking,true);
    writeFileSync(join(f.context.stateDir,'hold.json'),JSON.stringify({incidentId:failed.incidentId,baselineHash:'wrong',createdAt:new Date(now).toISOString(),alerts:[{code:'RPC_CHECK_FAILED'}]}));
    assert.notEqual(notificationState(f.context,now+1).checking,true);
    finish(f.snapshot); await running;
  } finally { f.cleanup(); }
});


test('corrupted or missing completed snapshot stays audible during a known held scan', async () => {
  for (const corrupt of [p => writeFileSync(p, '{'), p => rmSync(p), p => writeFileSync(p, '{}')]) {
    const f = fixture(); let previous; let finish; let sent = 0;
    const notify = time => notifyMainnet({ context:f.context, previous, destinationId:'-123', now:time,
      send:async()=>{sent++;},save:async p=>{previous=p;} });
    try {
      await f.run(now,async()=>{throw Error('offline');}); await f.run(now+1); await notify(now+1);
      let entered;const started=new Promise(r=>{entered=r;});
      const running=f.run(now+2,async()=>{entered();return new Promise(r=>{finish=r;});}); await started;
      corrupt(join(f.context.stateDir,'snapshot.json'));
      const state=notificationState(f.context,now+2); assert.equal(state.ok,false); assert.notEqual(state.checking,true);
      await notify(now+2); assert.equal(sent,2);
      finish(f.snapshot);await running;
    } finally {f.cleanup();}
  }
});

test('six-hour reminder in a held scan retains completed key and avoids duplicate on completion', async () => {
  const f=fixture();let previous;let finish;let sent=0;
  const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
  try{
    await f.run(now,async()=>{throw Error('offline');});await f.run(now+1);await notify(now+1);
    const completedKey=previous.key;previous.sentAt=new Date(now-21600000).toISOString();
    let entered;const started=new Promise(r=>{entered=r;});const running=f.run(now+2,async()=>{entered();return new Promise(r=>{finish=r;});});await started;
    assert.equal((await notify(now+3)).sent,true);assert.equal(sent,2);assert.equal(previous.key,completedKey);
    finish(f.snapshot);await running;assert.equal((await notify(now+4)).sent,false);assert.equal(sent,2);
    // A real newly completed RPC failure still gets through immediately.
    await f.run(now+5,async()=>{throw Error('offline again');});await notify(now+5);assert.equal(sent,3);
  }finally{f.cleanup();}
});


test('collection failures retain the last snapshot binding for the next bounded scan', async () => {
 const f=fixture();let previous;let finish;let sent=0;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{await f.run();const failed=await f.run(now+1,async()=>{throw Error('RPC timeout');});await notify(now+1);
 assert.ok(failed.snapshotHash);let entered;const started=new Promise(r=>{entered=r;});
 const running=f.run(now+2,async()=>{entered();return new Promise(r=>{finish=r;});});await started;
 assert.equal((await notify(now+3)).reason,'known-incident-scan-in-progress');assert.equal(sent,1);
 finish(f.snapshot);await running;
 }finally{f.cleanup();}
});

test('snapshot publication generation is quiet while corruption and stale publication still alert',async()=>{
 const f=fixture();let previous;let finish;let sent=0;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{await f.run(now,async()=>{throw Error('offline');});await f.run(now+1);await notify(now+1);
 const next=structuredClone(f.snapshot);next.observedAt.blockNumber='101';next.observedAt.blockHash=hash(101);next.discovery.scanned.toBlock='101';next.executionAudit.toBlock='101';
 let entered;const started=new Promise(r=>{entered=r;});
 const running=runMonitorOnce(f.context,{now:()=>now+2,collect:async()=>next,afterSnapshotPublished:async()=>{entered();await new Promise(r=>{finish=r;});}});await started;
 assert.equal((await notify(now+3)).reason,'known-incident-scan-in-progress');assert.equal(sent,1);
 const rawHeartbeat=readFileSync(join(f.context.stateDir,'heartbeat.json'),'utf8');
 writeFileSync(join(f.context.stateDir,'heartbeat.json'),JSON.stringify({...JSON.parse(rawHeartbeat),manifestHash:'wrong'}));
 assert.notEqual(notificationState(f.context,now+3).checking,true);
 assert.ok(notificationState(f.context,now+3).codes.includes('HEARTBEAT_BINDING_MISMATCH'));
 for(const corrupt of [{snapshotHash:'wrong'}, {observedAt:{}}, {runId:'invalid'}, {startedAt:[JSON.parse(rawHeartbeat).startedAt]}, {alerts:[{code:'CHECK_IN_PROGRESS',severity:'warning',detail:'invalid'}]}]){
  writeFileSync(join(f.context.stateDir,'heartbeat.json'),JSON.stringify({...JSON.parse(rawHeartbeat),...corrupt}));
  assert.notEqual(notificationState(f.context,now+3).checking,true);
 }
 writeFileSync(join(f.context.stateDir,'heartbeat.json'),rawHeartbeat);
 writeFileSync(join(f.context.stateDir,'snapshot.json'),'{}');await notify(now+3);assert.equal(sent,2);
 writeFileSync(join(f.context.stateDir,'snapshot.json'),JSON.stringify(next));
 assert.notEqual(notificationState(f.context,now+5003).checking,true);
 assert.ok(notificationState(f.context,now+5003).codes.includes('HEARTBEAT_STALE'));
 assert.notEqual((await notify(now+5003)).reason,'known-incident-scan-in-progress');
 finish();await running;
 }finally{f.cleanup();}
});

test('continuing outage with a stale retained snapshot does not alternate scan alerts',async()=>{
 const f=fixture();let previous;let finish;let sent=0;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{await f.run();await f.run(now+1,async()=>{throw Error('offline');});await notify(now+1);
 const later=now+121000;await f.run(later,async()=>{throw Error('still offline');});await notify(later);const count=sent;
 let entered;const started=new Promise(r=>{entered=r;});const running=f.run(later+1,async()=>{entered();return new Promise(r=>{finish=r;});});await started;
 assert.equal(notificationState(f.context,later+2).checking,true);
 assert.equal((await notify(later+2)).reason,'known-incident-scan-in-progress');assert.equal(sent,count);
 finish(f.snapshot);await running;
 }finally{f.cleanup();}
});


test('new validation failure during publication notifies once with the completed-state key',async()=>{
 const f=fixture();let previous;let finish;let sent=0;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{await f.run(now,async()=>{throw Error('offline');});await f.run(now+1);await notify(now+1);
 const next=structuredClone(f.snapshot);next.contract.effectiveLimits.perSpend='49';
 let entered;const started=new Promise(r=>{entered=r;});const running=runMonitorOnce(f.context,{now:()=>now+2,collect:async()=>next,afterSnapshotPublished:async()=>{entered();await new Promise(r=>{finish=r;});}});await started;
 assert.equal((await notify(now+3)).sent,true);assert.equal(sent,2);const key=previous.key;
 assert.ok(previous.codes.includes('CAP_DRIFT'));assert.ok(!previous.codes.includes('RPC_CHECK_FAILED'));
 finish();await running;assert.equal(notificationState(f.context,now+4).key,key);
 assert.equal((await notify(now+4)).sent,false);assert.equal(sent,2);
 }finally{f.cleanup();}
});


test('restart from a checking heartbeat preserves its last snapshot binding',async()=>{
 const f=fixture();let previous;let finish;let sent=0;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{await f.run(now,async()=>{throw Error('offline');});await f.run(now+1);await notify(now+1);
 let entered;let started=new Promise(r=>{entered=r;});let running=f.run(now+2,async()=>{entered();return new Promise(r=>{finish=r;});});await started;
 const interrupted=readFileSync(join(f.context.stateDir,'heartbeat.json'),'utf8');finish(f.snapshot);await running;
 writeFileSync(join(f.context.stateDir,'heartbeat.json'),interrupted);
 started=new Promise(r=>{entered=r;});running=f.run(now+3,async()=>{entered();return new Promise(r=>{finish=r;});});await started;
 assert.equal((await notify(now+4)).reason,'known-incident-scan-in-progress');assert.equal(sent,1);
 finish(f.snapshot);await running;
 // A subsequent snapshot-less failure also retains that same binding.
 writeFileSync(join(f.context.stateDir,'heartbeat.json'),interrupted);
 const failed=await f.run(now+5,async()=>{throw Error('offline again');});
 assert.equal(failed.snapshotHash,JSON.parse(interrupted).previousSnapshotHash);
 }finally{f.cleanup();}
});


test('restart after snapshot publication inherits the matching interrupted generation',async()=>{
 const f=fixture();let previous;let finish;let rejectCollect;let sent=0;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{await f.run(now,async()=>{throw Error('offline');});await f.run(now+1);await notify(now+1);
 const next=structuredClone(f.snapshot);next.observedAt.blockNumber='101';next.observedAt.blockHash=hash(101);next.discovery.scanned.toBlock='101';next.executionAudit.toBlock='101';
 let entered;let started=new Promise(r=>{entered=r;});let running=runMonitorOnce(f.context,{now:()=>now+2,collect:async()=>next,afterSnapshotPublished:async()=>{entered();await new Promise(r=>{finish=r;});}});await started;
 const interrupted=readFileSync(join(f.context.stateDir,'heartbeat.json'),'utf8');
 const marker=readFileSync(join(f.context.stateDir,'publication.json'),'utf8');
 finish();await running;writeFileSync(join(f.context.stateDir,'heartbeat.json'),interrupted);writeFileSync(join(f.context.stateDir,'publication.json'),marker);
 started=new Promise(r=>{entered=r;});running=runMonitorOnce(f.context,{now:()=>now+3,afterCheckingPublished:async()=>{
 assert.equal(readFileSync(join(f.context.stateDir,'publication.json'),'utf8'),marker);
 assert.equal((await notify(now+3)).reason,'known-incident-scan-in-progress');assert.equal(sent,1);
 },collect:async()=>{entered();return new Promise((resolve,reject)=>{rejectCollect=reject;});}});await started;
 assert.equal((await notify(now+4)).reason,'known-incident-scan-in-progress');assert.equal(sent,1);
 rejectCollect(Error('restarted collection timed out'));const failed=await running;
 assert.equal(failed.snapshotHash,JSON.parse(marker).snapshotHash);
 assert.ok(!notificationState(f.context,now+5).codes.includes('SNAPSHOT_BINDING_MISMATCH'));
 }finally{f.cleanup();}
});


test('new runner-only incident exposed during publication has the completed fingerprint',async()=>{
 for(const cause of ['head-regression','timeout']){
 const f=fixture();let previous;let finish;let sent=0;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{await f.run();await notify(now);const next=structuredClone(f.snapshot);let time=now+1;
 if(cause==='head-regression'){next.observedAt.blockNumber='99';next.observedAt.blockHash=hash(99);next.discovery.scanned.toBlock='99';next.executionAudit.toBlock='99';}
 let entered;const started=new Promise(r=>{entered=r;});const running=runMonitorOnce(f.context,{now:()=>time,collect:async()=>{if(cause==='timeout')time=now+6001;return next;},afterHoldLatched:async()=>{entered();await new Promise(r=>{finish=r;});}});await started;
 const expected=cause==='timeout'?'CHECK_TIMEOUT':'CANONICAL_HEAD_CHANGED';
 const notificationTime=time+1500; // descheduled publication beyond the old one-second cutoff
 assert.equal((await notify(notificationTime)).sent,true);assert.equal(sent,2);assert.ok(previous.codes.includes(expected));const key=previous.key;
 finish();await running;assert.equal(notificationState(f.context,notificationTime).key,key);assert.equal((await notify(notificationTime)).sent,false);assert.equal(sent,2);
 }finally{f.cleanup();}
 }
});


test('a newly created hold after an absent read cannot cause a transient unknown-incident alert',async()=>{
 const fs=await import('node:fs');const {syncBuiltinESMExports}=await import('node:module');
 const originalRead=fs.default.readFileSync;const f=fixture();let previous;let finish;let sent=0;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{await f.run();await notify(now);const next=structuredClone(f.snapshot);next.observedAt.blockNumber='99';next.observedAt.blockHash=hash(99);next.discovery.scanned.toBlock='99';next.executionAudit.toBlock='99';
 let entered;const started=new Promise(r=>{entered=r;});const running=runMonitorOnce(f.context,{now:()=>now+1,collect:async()=>next,afterSnapshotPublished:async()=>{entered();await new Promise(r=>{finish=r;});}});await started;
 const holdPath=join(f.context.stateDir,'hold.json');let intercepted=false;
 fs.default.readFileSync=function(path,...args){
  if(path===holdPath&&!intercepted){intercepted=true;try{return originalRead(path,...args);}catch(error){
   writeFileSync(holdPath,JSON.stringify({incidentId:'12345678-1234-4123-8123-123456789abc',createdAt:new Date(now+1).toISOString(),baselineHash:f.context.baselineHash,alerts:[{code:'CANONICAL_HEAD_CHANGED',severity:'critical',detail:'concurrent runner latch'}]}));throw error;
  }}return originalRead(path,...args);
 };syncBuiltinESMExports();
 const first=await notify(now+1);assert.equal(first.sent,false);assert.equal(sent,1);assert.equal(intercepted,true);
 fs.default.readFileSync=originalRead;syncBuiltinESMExports();finish();await running;
 await notify(now+1);assert.equal(sent,2);await notify(now+1);assert.equal(sent,2);
 }finally{fs.default.readFileSync=originalRead;syncBuiltinESMExports();f.cleanup();}
});

test('a first collection failure without a snapshot alerts once across publication and completion',async()=>{
 const f=fixture();let previous;let finish;let sent=0;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{
 let entered;const started=new Promise(r=>{entered=r;});const running=runMonitorOnce(f.context,{now:()=>now,collect:async()=>{throw Error('offline');},afterHoldLatched:async()=>{entered();await new Promise(r=>{finish=r;});}});await started;
 try{
 await notify(now);assert.equal(sent,1);assert.ok(previous.codes.includes('RPC_CHECK_FAILED'));assert.ok(previous.codes.includes('SNAPSHOT_BINDING_MISMATCH'));assert.ok(!previous.codes.includes('CHECK_IN_PROGRESS'));
 const key=previous.key;
 writeFileSync(join(f.context.stateDir,'snapshot.json'),'{');assert.ok(notificationState(f.context,now).codes.includes('LOCAL_STATE_INVALID'));rmSync(join(f.context.stateDir,'snapshot.json'));
 finish();finish=null;await running;
 assert.equal(notificationState(f.context,now).key,key);assert.equal((await notify(now)).sent,false);assert.equal(sent,1);
 for(let offset=1;offset<=2;offset++){
 let collecting;let failCollect;const collectingStarted=new Promise(r=>{collecting=r;});
 const retry=f.run(now+offset,async()=>{collecting();return new Promise((resolve,reject)=>{failCollect=reject;});});await collectingStarted;
 try{
 assert.equal(notificationState(f.context,now+offset).key,key);assert.equal((await notify(now+offset)).sent,false);assert.equal(sent,1);
 }finally{failCollect(Error('still offline'));await retry;}
 assert.equal(notificationState(f.context,now+offset).key,key);assert.equal((await notify(now+offset)).sent,false);assert.equal(sent,1);
 }
 let stalled;const latched=new Promise(r=>{stalled=r;});let resume;
 // Use the runner's actual snapshot-less publication.
 const publishing=runMonitorOnce(f.context,{now:()=>now+3,collect:async()=>{throw Error('offline');},afterHoldLatched:async()=>{stalled();await new Promise(r=>{resume=r;});}});await latched;
 const savedHeartbeat=readFileSync(join(f.context.stateDir,'heartbeat.json'));const savedMarker=readFileSync(join(f.context.stateDir,'publication.json'));
 resume();await publishing;
 writeFileSync(join(f.context.stateDir,'heartbeat.json'),savedHeartbeat);writeFileSync(join(f.context.stateDir,'publication.json'),savedMarker);
 let enteredRetry;let failRetry;const retryStarted=new Promise(r=>{enteredRetry=r;});
 const restarted=runMonitorOnce(f.context,{now:()=>now+4,afterCheckingPublished:async()=>{
 assert.deepEqual(readFileSync(join(f.context.stateDir,'publication.json')),savedMarker);
 assert.equal(notificationState(f.context,now+4).key,key);assert.equal((await notify(now+4)).sent,false);assert.equal(sent,1);
 const heartbeat=JSON.parse(readFileSync(join(f.context.stateDir,'heartbeat.json')));
 const currentMarker={...JSON.parse(savedMarker),runId:heartbeat.runId,startedAt:heartbeat.startedAt,completedAt:heartbeat.startedAt};
 for(const corrupt of ['{',JSON.stringify({...currentMarker,manifestHash:'wrong'}),JSON.stringify({...currentMarker,completedAt:'invalid'}),JSON.stringify({})]){
  writeFileSync(join(f.context.stateDir,'publication.json'),corrupt);
  assert.notEqual(notificationState(f.context,now+4).checking,true);
  assert.ok(notificationState(f.context,now+4).codes.includes('CHECK_IN_PROGRESS'));
 }
 writeFileSync(join(f.context.stateDir,'publication.json'),savedMarker);
 },collect:async()=>{enteredRetry();return new Promise((resolve,reject)=>{failRetry=reject;});}});await retryStarted;
 try{assert.equal(notificationState(f.context,now+4).key,key);assert.equal((await notify(now+4)).sent,false);assert.equal(sent,1);}
 finally{failRetry(Error('still offline after restart'));await restarted;}
 assert.equal((await notify(now+4)).sent,false);assert.equal(sent,1);
 }finally{if(finish){finish();await running;}}
 }finally{f.cleanup();}
});

test('restart from the first failed publication retains its codes even if the marker vanishes during read',async()=>{
 const fs=await import('node:fs');const {syncBuiltinESMExports}=await import('node:module');const originalRead=fs.default.readFileSync;
 const f=fixture();let previous;let sent=0;let finish;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{
 let latched;const firstLatched=new Promise(r=>{latched=r;});
 const first=runMonitorOnce(f.context,{now:()=>now,collect:async()=>{throw Error('offline');},afterHoldLatched:async()=>{latched();await new Promise(r=>{finish=r;});}});await firstLatched;
 await notify(now);assert.equal(sent,1);const key=previous.key;
 const savedHeartbeat=readFileSync(join(f.context.stateDir,'heartbeat.json'));const markerPath=join(f.context.stateDir,'publication.json');const savedMarker=readFileSync(markerPath);
 assert.equal(JSON.parse(savedHeartbeat).previousFailureCodes,null);
 finish();finish=null;await first;writeFileSync(join(f.context.stateDir,'heartbeat.json'),savedHeartbeat);writeFileSync(markerPath,savedMarker);
 let collecting;let fail;const started=new Promise(r=>{collecting=r;});
 const restarted=runMonitorOnce(f.context,{now:()=>now+1,afterCheckingPublished:async()=>{
  assert.ok(JSON.parse(readFileSync(join(f.context.stateDir,'heartbeat.json'))).previousFailureCodes.includes('RPC_CHECK_FAILED'));
  assert.equal(notificationState(f.context,now+1).key,key);
  let intercepted=false;
  fs.default.readFileSync=function(path,...args){if(path===markerPath&&!intercepted){intercepted=true;rmSync(markerPath);}return originalRead(path,...args);};syncBuiltinESMExports();
  try{assert.equal((await notify(now+1)).sent,false);assert.equal(sent,1);assert.equal(intercepted,true);}
  finally{fs.default.readFileSync=originalRead;syncBuiltinESMExports();}
 },collect:async()=>{collecting();return new Promise((resolve,reject)=>{fail=reject;});}});await started;
 try{assert.equal((await notify(now+1)).sent,false);assert.equal(sent,1);}finally{fail(Error('still offline'));await restarted;}
 assert.equal(notificationState(f.context,now+1).key,key);assert.equal((await notify(now+1)).sent,false);assert.equal(sent,1);
 }finally{fs.default.readFileSync=originalRead;syncBuiltinESMExports();f.cleanup();}
});

test('mixed old or absent snapshot reads retry to the published failure generation',async()=>{
 const fs=await import('node:fs');const {syncBuiltinESMExports}=await import('node:module');const originalRead=fs.default.readFileSync;
 for(const mode of ['old','absent']){
 const f=fixture();let previous;let sent=0;let finish;
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{
 let oldSnapshot;
 if(mode==='old'){await f.run();await notify(now);oldSnapshot=readFileSync(join(f.context.stateDir,'snapshot.json'),'utf8');}
 const next=structuredClone(f.snapshot);next.contract.effectiveLimits.perSpend='49';let latched;const started=new Promise(r=>{latched=r;});
 const running=runMonitorOnce(f.context,{now:()=>now+1,collect:async()=>next,afterHoldLatched:async()=>{latched();await new Promise(r=>{finish=r;});}});await started;
 let intercepted=false;const snapshotPath=join(f.context.stateDir,'snapshot.json');
 fs.default.readFileSync=function(path,...args){if(path===snapshotPath&&!intercepted){intercepted=true;if(mode==='old')return oldSnapshot;const error=Error('prior observation had no snapshot');error.code='ENOENT';throw error;}return originalRead(path,...args);};syncBuiltinESMExports();
 try{
 await notify(now+1);assert.equal(intercepted,true);assert.ok(previous.codes.includes('CAP_DRIFT'));assert.ok(!previous.codes.includes('CHECK_IN_PROGRESS'));
 const key=previous.key;const count=sent;
 fs.default.readFileSync=originalRead;syncBuiltinESMExports();finish();finish=null;await running;
 assert.equal(notificationState(f.context,now+1).key,key);assert.equal((await notify(now+1)).sent,false);assert.equal(sent,count);
 }finally{fs.default.readFileSync=originalRead;syncBuiltinESMExports();if(finish){finish();await running;}}
 }finally{fs.default.readFileSync=originalRead;syncBuiltinESMExports();f.cleanup();}
 }
});

test('a valid no-hold publication stays quiet before its snapshot rename',async()=>{
 const fs=await import('node:fs');const {syncBuiltinESMExports}=await import('node:module');const originalRename=fs.default.renameSync;
 for(const mode of ['old','absent']){
 const f=fixture();let intercepted=false;
 try{
 if(mode==='old')await f.run();
 const next=structuredClone(f.snapshot);next.observedAt.blockNumber='101';next.observedAt.blockHash=hash(101);next.discovery.scanned.toBlock='101';next.executionAudit.toBlock='101';
 fs.default.renameSync=function(from,to){const result=originalRename(from,to);if(to===join(f.context.stateDir,'publication.json')){intercepted=true;assert.equal(notificationState(f.context,now+1),null);}return result;};syncBuiltinESMExports();
 await f.run(now+1,async()=>next);assert.equal(intercepted,true);assert.equal(notificationState(f.context,now+1).ok,true);
 }finally{fs.default.renameSync=originalRename;syncBuiltinESMExports();f.cleanup();}
 }
});

test('three normal generation transitions yield an inconclusive sample rather than a transient alert',async()=>{
 const fs=await import('node:fs');const {syncBuiltinESMExports}=await import('node:module');const {digestJson}=await import('./float-mainnet-monitor-policy.mjs');const originalRead=fs.default.readFileSync;
 const f=fixture();let previous;let sent=0;let running;let finish;let releaseChecking;let enteredCollect;const collectingStarted=new Promise(r=>{enteredCollect=r;});
 const notify=time=>notifyMainnet({context:f.context,previous,destinationId:'-123',now:time,send:async()=>{sent++;},save:async p=>{previous=p;}});
 try{
 await f.run(now,async()=>{throw Error('offline');});await f.run(now+1);await notify(now+1);assert.equal(sent,1);
 const next=structuredClone(f.snapshot);next.contract.effectiveLimits.perSpend='49';const heartbeatPath=join(f.context.stateDir,'heartbeat.json');const markerPath=join(f.context.stateDir,'publication.json');const snapshotPath=join(f.context.stateDir,'snapshot.json');let heartbeatReads=0;let markerReads=0;
 fs.default.readFileSync=function(path,...args){
  if(path===heartbeatPath&&++heartbeatReads===2)running=runMonitorOnce(f.context,{now:()=>now+2,afterCheckingPublished:async()=>new Promise(r=>{releaseChecking=r;}),collect:async()=>{enteredCollect();return new Promise(r=>{finish=r;});}});
  if(path===markerPath){markerReads++;
   if(markerReads===4){const raw=JSON.parse(originalRead(heartbeatPath,'utf8'));const marker={...raw,completedAt:new Date(now+2).toISOString(),snapshotHash:digestJson(next),alertCodes:['CAP_DRIFT']};writeFileSync(markerPath,JSON.stringify(marker));}
   if(markerReads===6)writeFileSync(snapshotPath,JSON.stringify(next));
  }
  return originalRead(path,...args);
 };syncBuiltinESMExports();
 const uncertain=await notify(now+2);assert.equal(uncertain.sent,false);assert.equal(sent,1);assert.equal(markerReads,6);
 fs.default.readFileSync=originalRead;syncBuiltinESMExports();
 await notify(now+2);assert.equal(sent,2);assert.ok(previous.codes.includes('CAP_DRIFT'));assert.ok(!previous.codes.includes('CHECK_IN_PROGRESS'));const key=previous.key;
 releaseChecking();releaseChecking=null;await collectingStarted;finish(next);finish=null;await running;assert.equal(notificationState(f.context,now+2).key,key);assert.equal((await notify(now+2)).sent,false);assert.equal(sent,2);
 }finally{fs.default.readFileSync=originalRead;syncBuiltinESMExports();if(releaseChecking){releaseChecking();await collectingStarted;}if(finish){finish(f.snapshot);await running;}f.cleanup();}
});
