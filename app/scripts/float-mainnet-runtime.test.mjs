import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// Hosted provider imports must not initialize deployment checks or a subprocess
// runner. The Node CLI still loads its admission guard explicitly in main().
test('provider and snapshot imports do not enter Node CLI preflight or subprocess initialization', () => {
  const server = new URL('../../examples/float-mainnet-provider-server/server.mjs', import.meta.url).href;
  const monitor = new URL('./float-mainnet-monitor.mjs', import.meta.url).href;
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (['float-mainnet-preflight.mjs', 'float-mainnet-monitor-runner.mjs', 'float-mainnet-provider-monitor-guard.mjs'].some(name => specifier.endsWith(name))) {
        throw new Error('CLI-only module entered the provider import graph: ' + specifier);
      }
      return nextResolve(specifier, context);
    }});
    const { createProviderServer } = await import(${JSON.stringify(server)});
    if (typeof createProviderServer !== 'function') throw new Error('provider export missing');
    const { monitorSnapshot } = await import(${JSON.stringify(monitor)});
    if (typeof monitorSnapshot !== 'function') throw new Error('monitor export missing');
    process.stdout.write('provider and monitor modules loaded');
  `;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 15000 }), 'provider and monitor modules loaded');
});
