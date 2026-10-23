import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { config } from './config.js';

// Addresses an admin-supplied URL must not reach: the cluster network, the
// node itself, cloud metadata endpoints and other non-public ranges.
const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

export class SsrfError extends Error {}

function isBlocked(address: string): boolean {
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, family);
}

/** Throws unless the URL is http(s) and every address it resolves to is public (or the host is allowlisted). */
export async function assertPublicUrl(raw: string | URL): Promise<void> {
  const url = typeof raw === 'string' ? new URL(raw) : raw;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('only http and https URLs are allowed');
  if (!config.ssrfProtection) return;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (config.allowedInternalHosts.includes(host)) return;

  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new SsrfError(`cannot resolve host '${host}'`);
  const bad = addresses.find(isBlocked);
  if (bad) throw new SsrfError(`'${host}' resolves to a private address (${bad}); add it to the internal allowlist if it is trusted`);
}

/**
 * fetch for upstream MCP traffic: re-checks the target on every request (DNS
 * may have changed since the URL was saved) and refuses redirects, which could
 * otherwise bounce a request onto an internal address.
 */
export const guardedFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  await assertPublicUrl(url);
  return fetch(input, { ...init, redirect: 'error' });
};
