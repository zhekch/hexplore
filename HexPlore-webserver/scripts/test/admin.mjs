// Who runs the server, and what that gets them — through the real HTTP API.
//
// Three things are being checked, and the second and third are the ones that
// will still be earning their keep in a year.
//
// **That the first account to register is the admin, and no other is.** That is
// the whole of the bootstrap rule, and it is the one an install depends on: a
// server where nobody is an admin cannot be administered without a text editor
// and the database file.
//
// **That the gate holds.** Every route under /api/admin, and the backups that
// moved behind the same gate, must answer 403 for an ordinary account. Written
// as a list rather than as a handful of cases, so a route added later and not
// gated fails here rather than in somebody's browser.
//
// **That impersonation cannot escalate.** This is the sharp edge of the feature.
// An admin who opens somebody else's account gets a session that *is* that
// account, permissions included — so while it is going on, the admin routes must
// refuse it exactly as they refuse the account's owner, and the only way back
// must be the one route that reads the session rather than the account. A bug
// here is an account silently holding admin rights it was never granted.
//
//   node scripts/test/admin.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3212;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const dir = await mkdtemp(path.join(tmpdir(), 'visited-map-admin-'));
const DB = path.join(dir, 'test.db');
let server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: DB,
    BACKUP_DIR: path.join(dir, 'backups'),
    ALLOW_REGISTRATION: '1',
    UPDATE_CHECK: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (b) => { serverErr += b.toString(); });

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${BASE}/api/health`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

// One cookie jar per name, so three accounts can be signed in at once.
const jar = new Map();
async function api(method, url, body, who = 'a') {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.has(who) ? { Cookie: jar.get(who) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) jar.set(who, set.split(';')[0]);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

if (!(await waitForServer())) {
  console.error(`server did not start\n${serverErr}`);
  process.exit(1);
}

try {
  // --- Who is the admin ---------------------------------------------------------
  console.log('\nThe first account to register runs the server');
  {
    const first = await api('POST', '/api/register', { username: 'first', password: 'a-long-password' }, 'a');
    check(first.status === 200 && first.data?.admin === true, 'the first registration says so in its answer',
      JSON.stringify(first.data));

    const second = await api('POST', '/api/register', { username: 'second', password: 'a-long-password' }, 'b');
    check(second.status === 200 && second.data?.admin === false, 'and the second one does not',
      JSON.stringify(second.data));

    const me = await api('GET', '/api/me', null, 'a');
    check(me.data?.admin === true && me.data?.asAdmin === null,
      'the session check agrees, and reports nobody is being worn', JSON.stringify(me.data));

    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare('SELECT username, is_admin FROM users ORDER BY id').all();
    db.close();
    check(rows.length === 2 && rows[0].is_admin === 1 && rows[1].is_admin === 0,
      'and it is a column on the row, not a comparison of ids', JSON.stringify(rows));
  }

  // --- The gate -------------------------------------------------------------------
  //
  // Every admin route, and the backups that moved behind the same gate. Listed
  // rather than sampled: the failure this is written against is a route added
  // later that nobody remembers to gate.
  const GATED = [
    ['GET', '/api/admin/overview'],
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/password', { id: 1, password: 'a-long-password' }],
    ['POST', '/api/admin/grant', { id: 2, admin: true }],
    ['POST', '/api/admin/impersonate', { id: 1 }],
    ['POST', '/api/admin/sessions/end', { id: 1 }],
    ['GET', '/api/backup'],
    ['POST', '/api/backup', { enabled: false, cron: '0 4 * * *', keep: 3 }],
    ['POST', '/api/backup/run'],
    ['GET', '/api/backup/download?name=nope'],
  ];

  console.log('\nEverything instance-wide is behind the admin flag');
  {
    const refused = [];
    for (const [method, url, body] of GATED) {
      const r = await api(method, url, body, 'b');
      if (r.status !== 403) refused.push(`${url} → ${r.status}`);
    }
    check(refused.length === 0, `all ${GATED.length} of them answer 403 for an ordinary account`,
      refused.join(', '));

    const allowed = [];
    for (const [method, url] of GATED) {
      if (method !== 'GET' || url.includes('download')) continue;
      const r = await api(method, url, undefined, 'a');
      if (r.status !== 200) allowed.push(`${url} → ${r.status}`);
    }
    check(allowed.length === 0, 'and 200 for the admin', allowed.join(', '));

    const out = await api('GET', '/api/admin/overview', null, 'a');
    check(out.data?.totals?.users === 2 && out.data?.totals?.admins === 1,
      'the overview counts the accounts', JSON.stringify(out.data?.totals));
    check(typeof out.data?.server?.uptime === 'number' && out.data?.disk?.dbBytes > 0,
      'and reports the machine it is running on',
      `${out.data?.server?.uptime} ${out.data?.disk?.dbBytes}`);

    const users = await api('GET', '/api/admin/users', null, 'a');
    const names = (users.data?.users ?? []).map((u) => u.username);
    check(names.join(',') === 'first,second', 'the account list is every account', names.join(','));
    // The line this whole panel is drawn against: shape, never contents.
    const one = JSON.stringify(users.data?.users?.[0] ?? {});
    check(!/cell_id|geom|"lat"|"lng"/.test(one), 'and it carries counts and dates, not anybody\'s map', one);
    check(users.data?.users?.[0]?.lastLogin > 0, 'it says when each account last signed in',
      String(users.data?.users?.[0]?.lastLogin));
  }

  // --- Resetting a password ---------------------------------------------------------
  console.log('\nAn admin can let somebody back in');
  {
    const before = await api('GET', '/api/me', null, 'b');
    check(before.status === 200, "the second account's session works to begin with");

    const reset = await api('POST', '/api/admin/password', { id: 2, password: 'brand-new-password' }, 'a');
    check(reset.status === 200 && reset.data?.sessionsEnded === 1,
      'the reset succeeds and says how many sessions it ended', JSON.stringify(reset.data));

    const after = await api('GET', '/api/me', null, 'b');
    check(after.status === 401, 'and the old session is gone — a reset that leaves cookies alive is not one');

    const old = await api('POST', '/api/login', { username: 'second', password: 'a-long-password' }, 'c');
    check(old.status === 401, 'the old password no longer works');
    const now = await api('POST', '/api/login', { username: 'second', password: 'brand-new-password' }, 'b');
    check(now.status === 200, 'and the new one does');

    const short = await api('POST', '/api/admin/password', { id: 2, password: 'x' }, 'a');
    check(short.status === 400, 'a password below the minimum is refused, the same as at registration');
    const nobody = await api('POST', '/api/admin/password', { id: 999, password: 'a-long-password' }, 'a');
    check(nobody.status === 404, 'and an account that does not exist is a 404, not a 500');
  }

  // --- Granting and taking back ------------------------------------------------------
  console.log('\nAdmin can be handed over, and cannot be lost');
  {
    const self = await api('POST', '/api/admin/grant', { id: 1, admin: false }, 'a');
    check(self.status === 400, 'nobody can take their own admin away');

    const give = await api('POST', '/api/admin/grant', { id: 2, admin: true }, 'a');
    check(give.status === 200 && give.data?.admin === true, 'a second admin can be made');
    check((await api('GET', '/api/admin/overview', null, 'b')).status === 200,
      'and it takes effect at once');

    const take = await api('POST', '/api/admin/grant', { id: 2, admin: false }, 'a');
    check(take.status === 200, 'and unmade again');
    check((await api('GET', '/api/admin/overview', null, 'b')).status === 403, 'and that takes effect too');

    // The last one standing. `first` cannot demote themselves (checked above), so
    // this is asked of a second admin demoting the first — which leaves nobody.
    await api('POST', '/api/admin/grant', { id: 2, admin: true }, 'a');
    const last = await api('POST', '/api/admin/grant', { id: 1, admin: false }, 'b');
    check(last.status === 200, 'one of two admins may demote the other');
    const none = await api('POST', '/api/admin/grant', { id: 2, admin: false }, 'a');
    check(none.status === 403, 'and the demoted one is refused immediately after');
    // Put it back the way it was, for the impersonation checks below.
    await api('POST', '/api/admin/grant', { id: 1, admin: true }, 'b');
    await api('POST', '/api/admin/grant', { id: 2, admin: false }, 'a');
  }

  // --- Opening somebody else's account ------------------------------------------------
  console.log("\nAn admin can open somebody else's map, and cannot do more from inside it");
  {
    const mine = await api('POST', '/api/admin/impersonate', { id: 1 }, 'a');
    check(mine.status === 400, 'opening your own account is refused');

    const go = await api('POST', '/api/admin/impersonate', { id: 2 }, 'a');
    check(go.status === 200 && go.data?.username === 'second' && go.data?.asAdmin === 'first',
      'and somebody else\'s is opened, naming both ends', JSON.stringify(go.data));

    const me = await api('GET', '/api/me', null, 'a');
    check(me.data?.username === 'second', 'the session is now that account');
    check(me.data?.admin === false, 'and it is not an admin — the permissions come with the account');
    check(me.data?.asAdmin === 'first', 'while still saying who opened it, which is what the page draws');

    // The escalation check. Every gated route must refuse, or an admin could act
    // on the server while wearing somebody else's name.
    const leaked = [];
    for (const [method, url, body] of GATED) {
      const r = await api(method, url, body, 'a');
      if (r.status !== 403) leaked.push(`${url} → ${r.status}`);
    }
    check(leaked.length === 0, 'and every admin route refuses it, backups included', leaked.join(', '));

    const back0 = await api('POST', '/api/admin/return', null, 'a');
    check(back0.status === 200, 'the way back works');
    // …and the sharper version of the same check. An admin who opens *another
    // admin's* account has an effective user who passes `isAdmin`, so the gate
    // has to refuse on the session rather than on the account — otherwise every
    // line the server logs from in there names the wrong person.
    await api('POST', '/api/admin/grant', { id: 2, admin: true }, 'a');
    await api('POST', '/api/admin/impersonate', { id: 2 }, 'a');
    const wornAdmin = await api('GET', '/api/me', null, 'a');
    check(wornAdmin.data?.username === 'second' && wornAdmin.data?.admin === true,
      'an admin can open another admin, and the worn account really is an admin',
      JSON.stringify(wornAdmin.data));
    const stillLeaked = [];
    for (const [method, url, body] of GATED) {
      const r = await api(method, url, body, 'a');
      if (r.status !== 403) stillLeaked.push(`${url} → ${r.status}`);
    }
    check(stillLeaked.length === 0, 'and it is refused anyway, because the gate reads the session',
      stillLeaked.join(', '));
    await api('POST', '/api/admin/return', null, 'a');
    await api('POST', '/api/admin/grant', { id: 2, admin: false }, 'a');

    await api('POST', '/api/admin/impersonate', { id: 2 }, 'a');
    const back = await api('POST', '/api/admin/return', null, 'a');
    check(back.status === 200 && back.data?.username === 'first', 'the way back is the one route that reads the session');
    const home = await api('GET', '/api/me', null, 'a');
    check(home.data?.username === 'first' && home.data?.admin === true && home.data?.asAdmin === null,
      'and it lands on their own account, with their own rights', JSON.stringify(home.data));

    const again = await api('POST', '/api/admin/return', null, 'a');
    check(again.status === 400, 'returning from a session that is your own says so rather than doing anything');

    const nobody = await api('POST', '/api/admin/return', null, 'b');
    check(nobody.status === 400, 'and an ordinary account cannot use it to become anybody');
  }

  // --- ADMIN_USERS, and carrying an old database over ------------------------------
  //
  // A database made before the flag existed has nobody marked. Restarting must
  // find the first account and grant it, or an existing install comes back up
  // with a backups tab nobody can reach.
  console.log('\nA database from before the flag existed still has an admin');
  {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    const db = new DatabaseSync(DB);
    db.exec('UPDATE users SET is_admin = 0');
    db.close();

    server = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: DB,
        BACKUP_DIR: path.join(dir, 'backups'),
        ALLOW_REGISTRATION: '1',
        UPDATE_CHECK: '0',
        ADMIN_USERS: 'second',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (b) => { serverErr += b.toString(); });
    check(await waitForServer(), 'it comes back up');

    const check2 = new DatabaseSync(DB, { readOnly: true });
    const rows = check2.prepare('SELECT username, is_admin FROM users ORDER BY id').all();
    check2.close();
    const admins = rows.filter((r) => r.is_admin).map((r) => r.username);
    // ADMIN_USERS names `second`, which satisfies "somebody can administer this"
    // on its own — so the first-account fallback correctly does not also fire.
    check(admins.join(',') === 'second', 'ADMIN_USERS is granted, and the fallback stays out of the way',
      JSON.stringify(rows));

    server.kill();
    await new Promise((r) => server.once('exit', r));
    const db3 = new DatabaseSync(DB);
    db3.exec('UPDATE users SET is_admin = 0');
    db3.close();
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: DB,
        BACKUP_DIR: path.join(dir, 'backups'),
        ALLOW_REGISTRATION: '1',
        UPDATE_CHECK: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (b) => { serverErr += b.toString(); });
    await waitForServer();
    const db4 = new DatabaseSync(DB, { readOnly: true });
    const rows2 = db4.prepare('SELECT username, is_admin FROM users ORDER BY id').all();
    db4.close();
    check(rows2.filter((r) => r.is_admin).map((r) => r.username).join(',') === 'first',
      'and with nothing named, the first account gets it back', JSON.stringify(rows2));
  }
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
