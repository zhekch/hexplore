// Does the SSRF guard refuse what it should — and, just as importantly, still
// let a real connection through?
//
// The second half is not padding. The first version of this guard handed
// net.connect's `lookup` hook the wrong callback shape, so every outbound
// request failed with ERR_INVALID_IP_ADDRESS — and the policy tests all still
// passed, because a refusal and a broken connection are indistinguishable when
// the only "allowed" addresses you test have nothing listening on them. Home
// Assistant sync was down for an hour. Always test a success.
//
//   node scripts/test/net-guard.mjs

import { createServer } from 'node:http';
import { addressRefusal, guardedGetJson } from '../../server/net-guard.js';

let pass = 0;
let fail = 0;
const check = (ok, label) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}`);
  ok ? pass++ : fail++;
};

// --- Policy: what must never be dialled ------------------------------------
for (const [addr, why] of [
  ['169.254.169.254', 'cloud metadata'],
  ['::ffff:169.254.169.254', 'metadata as IPv4-mapped IPv6'],
  ['::ffff:a9fe:a9fe', 'metadata as hex IPv4-mapped'],
  ['fe80::1', 'IPv6 link-local'],
  ['0.0.0.0', 'unspecified'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
  ['198.18.0.1', 'benchmark range'],
]) {
  check(addressRefusal(addr) !== null, `refuses ${addr} (${why})`);
}

// --- Policy: what a self-hosted HA legitimately is --------------------------
// Blocking these would delete the feature, so their being allowed is a
// requirement, not an oversight. HA_BLOCK_PRIVATE=1 is the opt-in for setups
// that don't need them.
for (const [addr, why] of [
  ['127.0.0.1', 'HA on this same machine'],
  ['192.168.1.50', 'HA on the LAN'],
  ['10.0.0.5', 'HA on the LAN'],
  ['100.64.0.1', 'HA over tailscale'],
  ['fd00::1', 'IPv6 ULA'],
  ['1.1.1.1', 'a public address'],
]) {
  check(addressRefusal(addr) === null, `allows ${addr} (${why})`);
}

// --- The connection actually works -----------------------------------------
// This MUST go through a hostname, not a literal IP. net.connect recognises an
// IP and skips the `lookup` hook entirely, so a literal-IP test exercises none
// of the pinning code and passes just as happily when it is broken — which is
// exactly how the ERR_INVALID_IP_ADDRESS bug reached production. "localhost"
// resolves through DNS and therefore actually runs the hook.
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'API running.', path: req.url }));
});
// No host: bind every interface, so it answers whichever of 127.0.0.1 / ::1
// "localhost" happens to resolve to first on this machine.
await new Promise((r) => server.listen(0, r));
const { port } = server.address();

try {
  const res = await guardedGetJson(`http://localhost:${port}/api/`, {
    headers: { Accept: 'application/json' },
    timeoutMs: 5000,
  });
  check(res.ok && res.status === 200, 'connects through a hostname (status 200)');
  check(res.json?.message === 'API running.', 'parses the JSON body back');
  check(res.json?.path === '/api/', 'sends the right path');
} catch (e) {
  check(false, `connects through a hostname — threw: ${e.message}`);
}

// And a literal IP must keep working too — it takes the other branch.
try {
  const res = await guardedGetJson(`http://127.0.0.1:${port}/api/`, { timeoutMs: 5000 });
  check(res.ok, 'connects through a literal IP as well');
} catch (e) {
  check(false, `connects through a literal IP — threw: ${e.message}`);
}

// A refusal must be a refusal, not a timeout.
try {
  await guardedGetJson('http://169.254.169.254/api/', { timeoutMs: 5000 });
  check(false, 'refuses metadata before connecting');
} catch (e) {
  check(/Refusing to connect/.test(e.message), 'refuses metadata before connecting');
}

server.close();
console.log(`\n${fail ? 'FAILED' : 'passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
