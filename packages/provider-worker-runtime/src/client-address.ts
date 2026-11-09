import { isIP } from 'node:net';

/**
 * The only function that turns an incoming header into a caller identity.
 *
 * Trusted source: `CF-Connecting-IP` on a request that reached the public edge Worker through
 * Cloudflare's own front door, where the platform sets it and replaces any client-supplied copy.
 * Everything else (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `True-Client-IP`, `X-Shadow-Client-IP`) is
 * client-controlled and is never read.
 *
 * Returns a canonical lowercase address, or null for anything that is not exactly one routable-looking
 * IPv4/IPv6 literal: lists, ports, zones, whitespace, leading zeros, loopback, unspecified, multicast and
 * broadcast. IPv4-mapped IPv6 is folded to dotted IPv4 so one caller cannot hold two quota buckets.
 */
export function trustedClientAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length < 2 || value.length > 45) return null;
  // isIP accepts IPv6 zone identifiers (fe80::1%eth0) in Node and workerd; a zone is not an address.
  if (!/^[0-9a-fA-F:.]+$/.test(value) || isIP(value) === 0) return null;
  let address = value.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped && isIP(mapped[1]) === 4) address = mapped[1];
  if (isIP(address) === 4) {
    const [a] = address.split('.').map(Number);
    if (a === 0 || a === 127 || a >= 224) return null; // unspecified/this-network, loopback, multicast, reserved, broadcast
    return address;
  }
  if (address === '::' || address === '::1' || address.startsWith('ff')) return null;
  return address;
}

/** Headers that a client may send to claim another origin. None is trusted; any of them on an internal hop is refused. */
export const UNTRUSTED_FORWARDING_HEADERS = Object.freeze([
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded',
  'true-client-ip', 'x-client-ip', 'x-cluster-client-ip', 'x-shadow-client-ip', 'x-original-forwarded-for',
]);
