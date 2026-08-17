// Guarded outbound HTTP, for the one place the server fetches an address the
// account typed in (Home Assistant).
//
// Two problems this solves, both found in the July 2026 security review:
//
//   • SSRF — `baseUrl` went straight into fetch(), so any account could point
//     the server at 169.254.169.254, the router, or anything else it could
//     reach from inside the network, and read reachability off the reply.
//   • DNS rebinding — even with a check at save time, the name was resolved
//     again on every poll. A record with a 0 s TTL passes the check once and
//     then points somewhere else for the request that follows.
//
// The fix for the second is why this can't just be fetch() with a validation
// step in front: the address that gets *checked* has to be the address that
// gets *connected to*. So the name is resolved here, the resolved IP is
// validated, and the connection is pinned to that exact IP via net.connect's
// `lookup` hook. SNI and the Host header still carry the original hostname, so
// TLS verification and virtual hosting keep working.
//
// The policy is deliberately not "block every private address". A self-hosted
// Home Assistant normally *is* at 192.168.x.x, homeassistant.local or even
// 127.0.0.1 on this same Pi — blocking those would delete the feature. What is
// never a Home Assistant is link-local (169.254/16 and fe80::/10, where every
// cloud metadata service lives), multicast, or the reserved ranges, so those
// are refused always. Deployments whose HA is reachable over the internet can
// tighten it to "public addresses only" with HA_BLOCK_PRIVATE=1, and anyone who
// wants the strongest setting can name the exact hosts in HA_ALLOWED_HOSTS.
//
// Env:
//   HA_BLOCK_PRIVATE=1     also refuse loopback/RFC1918/CGNAT/ULA
//   HA_ALLOWED_HOSTS=a,b   allowlist; when set, only these hostnames/IPs pass

import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import httpRequest from 'node:http';
import httpsRequest from 'node:https';
// A refusal here is a sentence about the address you typed, so it is shown as
// written rather than swallowed. See server/user-error.js.
import { UserError } from './user-error.js';

const BLOCK_PRIVATE = process.env.HA_BLOCK_PRIVATE === '1' || process.env.HA_BLOCK_PRIVATE === 'true';
const ALLOWED_HOSTS = new Set(
  String(process.env.HA_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Never routable to a Home Assistant, and the ranges an SSRF actually wants:
// link-local carries the cloud metadata endpoints, the rest are unusable.
const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local + 169.254.169.254
ALWAYS_BLOCKED.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
ALWAYS_BLOCKED.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1
ALWAYS_BLOCKED.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
ALWAYS_BLOCKED.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2
ALWAYS_BLOCKED.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3
ALWAYS_BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
ALWAYS_BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, incl. 255.255.255.255
ALWAYS_BLOCKED.addAddress('::', 'ipv6'); // unspecified
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6'); // link-local
ALWAYS_BLOCKED.addSubnet('ff00::', 8, 'ipv6'); // multicast
ALWAYS_BLOCKED.addSubnet('2001:db8::', 32, 'ipv6'); // documentation

// Legitimate for a LAN Home Assistant, so only refused with HA_BLOCK_PRIVATE.
const PRIVATE_RANGES = new BlockList();
PRIVATE_RANGES.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_RANGES.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_RANGES.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT — tailscale lives here
PRIVATE_RANGES.addAddress('::1', 'ipv6');
PRIVATE_RANGES.addSubnet('fc00::', 7, 'ipv6'); // unique local

/**
 * An IPv4-mapped or NAT64 IPv6 address hides an IPv4 one; ::ffff:169.254.169.254
 * has to be judged as 169.254.169.254, not waved through as "some IPv6 address".
 */
function unwrapV4(address) {
  const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (m) return m[1];
  // ::ffff:7f00:1 — the same thing written in hex.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/**
 * Why this address may not be connected to, or null if it may.
 * Exported so it can be tested directly against every range that matters.
 */
export function addressRefusal(address) {
  const mapped = unwrapV4(address);
  const addr = mapped ?? address;
  const family = isIP(addr);
  if (!family) return 'that address could not be understood';
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (ALWAYS_BLOCKED.check(addr, type)) {
    return 'that address is link-local or reserved, which is never a Home Assistant';
  }
  if (BLOCK_PRIVATE && PRIVATE_RANGES.check(addr, type)) {
    return 'that address is on a private network, and this server is set to allow public addresses only';
  }
  return null;
}

/**
 * Resolve `hostname` and return the one address we're willing to talk to.
 * Every address the name resolves to is checked, not just the one we pick: a
 * name that answers with both a public and a link-local address is a rebinding
 * attempt, not a configuration accident.
 */
async function resolvePinned(rawHostname) {
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), and isIP()
  // doesn't recognise those — so an address written that way would skip the
  // literal branch entirely and be handed to the resolver instead.
  const hostname = rawHostname.replace(/^\[|\]$/g, '');

  if (ALLOWED_HOSTS.size && !ALLOWED_HOSTS.has(hostname.toLowerCase())) {
    throw new UserError(`This server only connects to approved addresses (${[...ALLOWED_HOSTS].join(', ')}).`);
  }

  // A literal IP needs no lookup — but still needs checking.
  const literal = isIP(hostname);
  if (literal) {
    const refusal = addressRefusal(hostname);
    if (refusal) throw new UserError(`Refusing to connect: ${refusal}.`);
    return { address: hostname, family: literal };
  }

  let records;
  try {
    records = await dnsLookup(hostname, { all: true });
  } catch {
    throw new UserError('Could not reach Home Assistant at that address.');
  }
  if (!records.length) throw new UserError('Could not reach Home Assistant at that address.');

  for (const r of records) {
    const refusal = addressRefusal(r.address);
    if (refusal) throw new UserError(`Refusing to connect: ${refusal}.`);
  }
  return records[0];
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * One guarded GET. Resolves, validates, then connects to the validated IP.
 *
 * Redirects are not followed: each hop would need resolving and checking again,
 * and a Home Assistant answering the API with a redirect means the address is
 * wrong rather than that we should chase it.
 *
 * @returns {Promise<{status:number, ok:boolean, json:any}>}
 */
export async function guardedGetJson(rawUrl, { headers = {}, timeoutMs = 30000 } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UserError('That does not look like a server address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UserError('That does not look like a server address.');
  }

  const pinned = await resolvePinned(url.hostname);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };

    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new UserError('Home Assistant did not answer in time.'));
    }, timeoutMs);

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname, // keeps Host + SNI honest
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        // The whole point: connect to the address that was checked, not to
        // whatever the name resolves to a second time.
        //
        // net calls this with `all: true` (it wants the full candidate list for
        // happy-eyeballs), and in that mode the callback takes an *array* of
        // {address, family} — handing it the three-argument form instead makes
        // the address arrive as undefined and every connection fail with
        // ERR_INVALID_IP_ADDRESS. Both shapes are answered here because which
        // one is asked for depends on the Node version and the socket options.
        lookup: (_hostname, opts, cb) =>
          (opts?.all
            ? cb(null, [{ address: pinned.address, family: pinned.family }])
            : cb(null, pinned.address, pinned.family)),
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          return done(
            reject,
            new UserError('That address answered with a redirect — use the address it points at instead.'),
          );
        }
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy();
            return done(reject, new UserError('Home Assistant sent more data than expected.'));
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* the caller decides whether unreadable is fatal */
          }
          done(resolve, {
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json,
          });
        });
        res.on('error', () => done(reject, new UserError('Could not reach Home Assistant at that address.')));
      },
    );

    req.on('error', () => done(reject, new UserError('Could not reach Home Assistant at that address.')));
    req.end();
  });
}
