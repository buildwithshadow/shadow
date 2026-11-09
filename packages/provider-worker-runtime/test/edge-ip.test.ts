import { beforeAll, describe, expect, it } from 'vitest';
import { trustedClientAddress } from '../src/client-address.ts';
import { coordinator, digestOf, edge, importThroughCoordinator, jsonOf } from './helpers.ts';

// Which caller address the provider's per-caller quotas see. Trusted source: the platform-established
// CF-Connecting-IP at the public edge. The actual server derives the caller from its request socket, which
// local workerd fills from that header on each request. These tests use synthetic requests only.
const BOUND = 12_000;
const LIMIT = 2; // requests per minute per caller, set for these tests

beforeAll(async () => {
  await importThroughCoordinator([]);
  await (await coordinator()).__override({ RATE_LIMIT_PER_MINUTE: String(LIMIT) });
});

const status = (ip: string | null, headers: Record<string, string> = {}) => edge(`/status/${digestOf(1)}`, { ip, headers });
const codes = async (ip: string, n: number, headers: () => Record<string, string> = () => ({})) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await status(ip, headers())).status);
  return out;
};

describe('trusted client address', () => {
  it('accepts one routable-looking literal and folds equivalent spellings', () => {
    expect(trustedClientAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(trustedClientAddress('2001:DB8::1')).toBe('2001:db8::1');
    expect(trustedClientAddress('::FFFF:192.0.2.9')).toBe('192.0.2.9');
    expect(trustedClientAddress('::ffff:192.0.2.9')).toBe('192.0.2.9');
  });
  it('rejects everything else', () => {
    for (const bad of [null, undefined, '', 'unknown', 'localhost', '999.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.4, 5.6.7.8', '1.2.3.4:80', '[::1]', '::1', '127.0.0.1', '127.9.9.9',
      '0.0.0.0', '::', '224.0.0.1', '239.255.255.255', '255.255.255.255', 'ff02::1', 'fe80::1%eth0', '::ffff:127.0.0.1', '2001:db8::zz', 'a'.repeat(100), '1.2.3.4/32']) {
      expect(trustedClientAddress(bad), String(bad)).toBeNull();
    }
  });
});

describe('through the public edge into the actual server', () => {
  it('spoofed forwarding headers neither move a caller to another bucket nor hide it from its own', { timeout: BOUND }, async () => {
    let n = 0;
    const spoof = () => ({
      'x-forwarded-for': `198.51.100.${++n}`, 'x-real-ip': `198.51.100.${n + 100}`, forwarded: `for=198.51.100.${n + 50}`,
      'x-shadow-client-ip': `198.51.100.${n + 150}`, 'true-client-ip': `198.51.100.${n + 200}`,
    });
    // Same real caller, a new fake origin every time: still one bucket, so the third request is refused.
    expect(await codes('192.0.2.10', 3, spoof)).toEqual([200, 200, 429]);
    // A different real caller is unaffected, even when it claims to be the first one.
    expect(await codes('192.0.2.11', 2, () => ({ 'x-forwarded-for': '192.0.2.10', 'x-shadow-client-ip': '192.0.2.10' }))).toEqual([200, 200]);
  });

  it('a caller cannot spend somebody else\'s quota by claiming their address', { timeout: BOUND }, async () => {
    const victim = '192.0.2.20';
    const attacker = Array.from({ length: 6 }, () => ({ 'x-forwarded-for': victim, 'x-real-ip': victim, 'x-shadow-client-ip': victim, forwarded: `for=${victim}` }));
    let i = 0;
    const seen = await codes('192.0.2.21', 6, () => attacker[i++]);
    expect(seen.slice(0, 2)).toEqual([200, 200]);
    expect(seen.slice(2).every(code => code === 429)).toBe(true); // the attacker exhausted only its own bucket
    expect(await codes(victim, 2)).toEqual([200, 200]); // the victim still has its full allowance
  });

  it('keeps concurrent callers separate', { timeout: BOUND }, async () => {
    // Public mode reserves two of four slots for recovery, so use two
    // independent status callers and verify the per-caller in-flight limit.
    const callers = ['192.0.2.31', '2001:db8::33'];
    const fired = callers.flatMap(ip => Array.from({ length: 3 }, () => status(ip).then(r => ({ ip, code: r.status }))));
    const results = await Promise.all(fired);
    for (const ip of callers) {
      const mine = results.filter(r => r.ip === ip).map(r => r.code).sort();
      expect(mine, ip).toEqual([200, 429, 429]);
    }
  });

  it('one caller written two ways shares one bucket', { timeout: BOUND }, async () => {
    expect(await codes('::FFFF:192.0.2.41', 1)).toEqual([200]);
    expect(await codes('192.0.2.41', 1)).toEqual([200]);
    expect(await codes('::ffff:192.0.2.41', 1)).toEqual([429]);
    expect(await codes('2001:DB8::42', 2)).toEqual([200, 200]);
    expect(await codes('2001:db8::42', 1)).toEqual([429]);
  });

  it('refuses a missing or invalid platform address before any Durable Object is reached', { timeout: BOUND }, async () => {
    const c = await coordinator();
    const before = (await c.__counters()).requests;
    for (const ip of [null, '', 'unknown', '999.1.1.1', '1.2.3.4, 5.6.7.8', '1.2.3.4:80', '127.0.0.1', '::1', '0.0.0.0', 'fe80::1%eth0', '01.2.3.4']) {
      const r = await status(ip);
      expect(r.status, String(ip)).toBe(400);
      expect(jsonOf(r)).toEqual({ error: 'Missing trusted client address' });
    }
    expect((await c.__counters()).requests).toBe(before);
  });

  it('the internal hop is not a way around the edge', { timeout: BOUND }, async () => {
    const c = await coordinator();
    const url = `https://provider.internal/status/${digestOf(1)}`;
    expect((await c.fetch(new Request(url))).status).toBe(400); // no platform address: never the shared loopback bucket
    expect((await c.fetch(new Request(url, { headers: { 'cf-connecting-ip': '127.0.0.1' } }))).status).toBe(400);
    for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-shadow-client-ip', 'true-client-ip']) {
      const r = await c.fetch(new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.50', [header]: '198.51.100.1' } }));
      expect(r.status, header).toBe(400);
      expect(await r.text()).toContain('Untrusted forwarding header');
    }
    expect((await c.fetch(new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.50' } }))).status).toBe(200);
  });
});
