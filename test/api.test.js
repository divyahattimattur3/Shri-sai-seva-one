'use strict';
// Integration tests: starts the real server on a temporary database. Run:  node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const ROOT = path.join(__dirname, '..'), PORT = 5400 + Math.floor(Math.random() * 400);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'seva-test-'));
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = 'Admin@12345';
let proc, out = '';

function startServer(extra = {}) {
  return new Promise((ok, no) => {
    proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_PASSWORD: ADMIN_PW, SMS_PROVIDER: 'console', RATE_LIMIT_SCALE: '100', TRUST_PROXY: 'true', REQUIRE_OTP: 'true', ...extra } });
    proc.stdout.on('data', d => { out += d; if (out.includes('running at')) ok(); });
    proc.stderr.on('data', d => { if (/Error|error/.test(String(d)) && !/ExperimentalWarning/.test(String(d))) out += d; });
    setTimeout(() => no(new Error('server did not start:\n' + out)), 8000);
  });
}
const stop = () => new Promise(r => { if (!proc) return r(); proc.once('exit', r); proc.kill(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const otpSeen = {};
async function lastOtp(mobile) {   // waits briefly for a NEW OTP line from the server console, else reuses the latest
  const re = new RegExp(`\\[SMS otp\\] to ${mobile}: .*?OTP is (\\d{6})`, 'g');
  for (let i = 0; i < 20; i++) {
    const m = [...out.matchAll(re)];
    if (m.length > (otpSeen[mobile] || 0)) { otpSeen[mobile] = m.length; return m[m.length - 1][1]; }
    await sleep(25);
  }
  const m = [...out.matchAll(re)]; return m.length ? m[m.length - 1][1] : null;
}

class Client {
  constructor(ip) { this.cookie = ''; this.ip = ip || `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; }
  async req(method, url, body, headers = {}) {
    const r = await fetch(BASE + url, { method, headers: { 'X-Forwarded-For': this.ip, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) { const v = sc.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    let d = {}; try { d = await r.json(); } catch {}
    return { s: r.status, d, h: r.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
}
let seq = 0;
async function newRetailer(extra = {}) {
  const n = ++seq, mobile = '98' + String(10000000 + n * 7 + Math.floor(Math.random() * 1000)).slice(0, 8);
  const c = new Client(), email = `user${n}_${Date.now()}@example.com`, password = 'Secret123';
  assert.equal((await c.post('/api/otp/send', { mobile, purpose: 'register' })).s, 200);
  const reg = await c.post('/api/register', { name: 'Test User ' + [...String(n)].map(d => 'ABCDEFGHIJ'[d]).join(''), mobile, email, state: 'Karnataka', password, code: await lastOtp(mobile), ...extra });
  assert.equal(reg.s, 200, JSON.stringify(reg.d));
  assert.equal((await c.post('/api/login', { id: mobile, password })).s, 200);
  return { c, mobile, email, password, me: async () => (await c.get('/api/state')).d.me };
}
async function adminClient() { const c = new Client(); assert.equal((await c.post('/api/login', { id: 'sachinah98@gmail.com', password: ADMIN_PW })).s, 200); return c; }
async function fund(admin, uid, amount) { const r = await admin.post(`/api/admin/users/${uid}/funds`, { amount, note: 'test funds' }); assert.equal(r.s, 200, JSON.stringify(r.d)); }

before(async () => { await startServer(); });
after(async () => { await stop(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('public surface: config, home page, nothing sensitive is downloadable', async () => {
  const c = new Client(), cfg = await c.get('/api/config');
  assert.equal(cfg.s, 200); assert.equal(cfg.d.services.length, 41); assert.equal(cfg.d.minRecharge, 300);
  assert.ok(!JSON.stringify(cfg.d).includes('pass'));
  const home = await fetch(BASE + '/'); assert.equal(home.status, 200);
  assert.ok(home.headers.get('content-security-policy')); assert.equal(home.headers.get('x-frame-options'), 'DENY');
  for (const p of ['/server.js', '/lib/auth.js', '/data/seva.db', '/.env', '/package.json', '/%2e%2e/server.js', '/..%2fserver.js', '/public/../server.js']) {
    const r = await fetch(BASE + p); assert.equal(r.status, 404, p);
  }
});

test('registration: validation, OTP required, duplicates, referral bonus', async () => {
  const c = new Client(), mobile = '9000000011';
  assert.equal((await c.post('/api/otp/send', { mobile: '123' , purpose: 'register' })).s, 400);
  assert.equal((await c.post('/api/otp/send', { mobile, purpose: 'hack' })).s, 400);
  assert.equal((await c.post('/api/otp/send', { mobile, purpose: 'register' })).s, 200);
  const base = { name: 'Asha Rao', mobile, email: 'asha@example.com', state: 'Karnataka', password: 'Secret123', code: await lastOtp(mobile) };
  assert.equal((await c.post('/api/register', { ...base, password: 'short1' })).s, 400);           // weak
  assert.equal((await c.post('/api/register', { ...base, password: 'onlyletters' })).s, 400);       // no digit
  assert.equal((await c.post('/api/register', { ...base, state: 'Mars' })).s, 400);
  assert.equal((await c.post('/api/register', { ...base, email: 'nope' })).s, 400);
  assert.equal((await c.post('/api/register', { ...base, code: '000000' })).s, 400);                // wrong OTP
  const refOwner = await newRetailer(); const owner = await refOwner.me();
  assert.equal((await c.post('/api/register', { ...base, referral: 'NOPE999' })).s, 400);
  await c.post('/api/otp/send', { mobile, purpose: 'register' }).catch(() => {});                    // cooldown may apply
  const okReg = await c.post('/api/register', { ...base, code: await lastOtp(mobile), referral: owner.code });
  assert.equal(okReg.s, 200, JSON.stringify(okReg.d));
  assert.equal((await c.post('/api/register', { ...base, code: await lastOtp(mobile) })).s, 409);         // duplicate / OTP used
  const after = await refOwner.me(); assert.equal(after.earn, 0); assert.equal(after.refs, 1);   // no bonus at sign-up (stops free-money farming)
  assert.equal((await c.post('/api/login', { id: mobile, password: 'Secret123' })).s, 200);
  const admin = await adminClient();
  for (const [amt, utr] of [[300, '600000000001'], [300, '600000000002']]) {
    const pid = (await c.post('/api/payments', { amount: amt })).d.id; await c.post(`/api/payments/${pid}/utr`, { utr });
    assert.equal((await admin.post(`/api/admin/payments/${pid}/decide`, { approve: true })).s, 200);
    assert.equal((await refOwner.me()).earn, 10);                                                    // paid once, on the first approved recharge only
  }
});

test('login: generic errors, HttpOnly cookie, logout, remember-me', async () => {
  const u = await newRetailer(), c = new Client();
  const bad1 = await c.post('/api/login', { id: u.mobile, password: 'Wrong1234' }), bad2 = await c.post('/api/login', { id: 'nobody@example.com', password: 'Wrong1234' });
  assert.equal(bad1.s, 401); assert.equal(bad1.d.error, bad2.d.error);
  const ok = await c.post('/api/login', { id: u.email.toUpperCase(), password: u.password });
  assert.equal(ok.s, 200); const ck = ok.h.get('set-cookie');
  assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Lax/); assert.ok(!/Max-Age/.test(ck));
  assert.equal((await c.get('/api/state')).s, 200);
  assert.equal((await c.post('/api/logout')).s, 200); assert.equal((await c.get('/api/state')).s, 401);
  const rem = await new Client().post('/api/login', { id: u.mobile, password: u.password, remember: true });
  assert.match(rem.h.get('set-cookie'), /Max-Age=2592000/);
});

test('authorization: login required, admin endpoints locked, no cross-user access', async () => {
  const anon = new Client(), a = await newRetailer(), b = await newRetailer(), admin = await adminClient();
  for (const [m, u] of [['GET', '/api/state'], ['POST', '/api/payments'], ['POST', '/api/applications'], ['POST', '/api/admin/announcement']]) assert.equal((await anon.req(m, u, m === 'POST' ? {} : undefined)).s, 401, u);
  assert.equal((await a.c.post('/api/admin/announcement', { text: 'hi' })).s, 403);
  assert.equal((await a.c.post('/api/admin/payments/PAY1001/decide', { approve: true })).s, 403);
  assert.equal((await a.c.post('/api/admin/users/x/funds', { amount: 5000 })).s, 403);
  const pay = (await b.c.post('/api/payments', { amount: 500 })).d.id;
  assert.equal((await a.c.post(`/api/payments/${pay}/utr`, { utr: '111122223333' })).s, 404);       // not A's payment
  assert.equal((await a.c.post(`/api/payments/${pay}/cancel`)).s, 404);
  const st = (await a.c.get('/api/state')).d; assert.equal(st.payments.length, 0); assert.equal(st.users.length, 1);
  assert.ok(!JSON.stringify(st).includes(b.mobile) && !JSON.stringify(st).includes(b.email));
  assert.ok(!JSON.stringify((await admin.get('/api/state')).d).includes('pass_hash'));
});

test('browser safety: JSON only, cross-site posts blocked, bad JSON handled', async () => {
  const c = new Client();
  assert.equal((await c.req('POST', '/api/login', undefined, { 'Content-Type': 'text/plain' })).s, 415);
  assert.equal((await c.req('POST', '/api/login', { id: 'x', password: 'y' }, { Origin: 'https://evil.example' })).s, 403);
  const raw = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }); assert.equal(raw.status, 400);
  const big = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'x'.repeat(40000) }) }).then(r => r.status).catch(() => 'closed');
  assert.ok(big === 413 || big === 'closed');
  assert.equal((await c.get('/api/health')).s, 200);
});

test('wallet recharge: amount rules, UTR rules, admin approval credits exactly once', async () => {
  const u = await newRetailer(), admin = await adminClient();
  for (const amount of [299, 50001, 500.5, '500', -5, null, 'abc']) assert.equal((await u.c.post('/api/payments', { amount })).s, 400, String(amount));
  const p = (await u.c.post('/api/payments', { amount: 500 })).d.id;
  assert.equal((await u.c.post(`/api/payments/${p}/utr`, { utr: '123' })).s, 400);
  assert.equal((await admin.post(`/api/admin/payments/${p}/decide`, { approve: true })).s, 400);   // not submitted yet
  assert.equal((await u.c.post(`/api/payments/${p}/utr`, { utr: '412345678901' })).s, 200);
  const p2 = (await u.c.post('/api/payments', { amount: 300 })).d.id;
  assert.equal((await u.c.post(`/api/payments/${p2}/utr`, { utr: '412345678901' })).s, 400);       // duplicate UTR
  assert.equal((await u.c.post(`/api/payments/${p}/utr`, { utr: '999999999999' })).s, 400);        // already submitted
  assert.equal((await u.me()).wallet, 0);                                                              // not credited before approval
  assert.equal((await admin.post(`/api/admin/payments/${p}/decide`, { approve: true })).s, 200);
  assert.equal((await admin.post(`/api/admin/payments/${p}/decide`, { approve: true })).s, 400);    // no double credit
  assert.equal((await u.me()).wallet, 500);
  assert.equal((await u.c.post(`/api/payments/${p2}/utr`, { utr: '555566667777' })).s, 200);
  assert.equal((await admin.post(`/api/admin/payments/${p2}/decide`, { approve: false })).s, 200);  // rejected
  const st = (await u.c.get('/api/state')).d; assert.equal(st.me.wallet, 500);
  assert.equal(st.payments.find(x => x.id === p2).status, 'Rejected');
  assert.ok(st.tx.some(t => t.amt === 500 && /UTR 412345678901/.test(t.desc)));
  assert.equal((await u.c.post(`/api/payments/${p}/cancel`)).s, 200);                                 // cancelling a paid one changes nothing
  assert.equal((await u.me()).wallet, 500);
});

test('applications: server-side price, balance checks, commission and refund rules', async () => {
  const u = await newRetailer(), admin = await adminClient(), uid = (await u.me()).id;
  const body = { cat: 'PAN', svc: 'New PAN Application', name: 'Customer One', mobile: '9123456780', aadhaar: '1234' };
  assert.equal((await u.c.post('/api/applications', body)).d.code, 'LOW_BALANCE');
  assert.equal((await u.me()).wallet, 0);
  await fund(admin, uid, 1000);
  assert.equal((await u.c.post('/api/applications', { ...body, svc: 'Nope' })).s, 400);
  assert.equal((await u.c.post('/api/applications', { ...body, mobile: '123' })).s, 400);
  const r = await u.c.post('/api/applications', { ...body, fee: 1, amount: 1, comm: 9999 });          // forged fee fields are ignored
  assert.equal(r.s, 200); assert.equal((await u.me()).wallet, 1000 - 120);
  const a1 = r.d.id;
  assert.equal((await admin.post(`/api/admin/applications/${a1}/status`, { status: 'In process' })).s, 200);
  assert.equal((await admin.post(`/api/admin/applications/${a1}/status`, { status: 'Received' })).s, 400);
  assert.equal((await admin.post(`/api/admin/applications/${a1}/status`, { status: 'Completed' })).s, 200);
  assert.equal((await u.me()).earn, 12);                                                                // 10% of 120
  assert.equal((await admin.post(`/api/admin/applications/${a1}/status`, { status: 'Rejected' })).s, 400); // closed
  assert.equal((await u.me()).earn, 12); assert.equal((await u.me()).wallet, 880);
  const a2 = (await u.c.post('/api/applications', { ...body, cat: 'Print', svc: 'Aadhaar Print' })).d.id; // fee 15
  assert.equal((await u.me()).wallet, 865);
  assert.equal((await admin.post(`/api/admin/applications/${a2}/status`, { status: 'Rejected' })).s, 200);
  assert.equal((await u.me()).wallet, 880);                                                              // refunded once
  assert.equal((await admin.post(`/api/admin/applications/${a2}/status`, { status: 'Rejected' })).s, 400);
  assert.equal((await u.me()).wallet, 880);
  const mv = await u.c.post('/api/wallet/move'); assert.equal(mv.d.moved, 12);
  const me = await u.me(); assert.equal(me.earn, 0); assert.equal(me.wallet, 892);
  assert.equal((await u.c.post('/api/wallet/move')).s, 400);
});

test('money safety: parallel requests can never overspend or double-credit', async () => {
  const u = await newRetailer(), admin = await adminClient(), uid = (await u.me()).id;
  await fund(admin, uid, 350);                                                                           // enough for 3 x ₹120
  const body = { cat: 'PAN', svc: 'New PAN Application', name: 'Customer', mobile: '9123456780' };
  const res = await Promise.all(Array.from({ length: 10 }, () => u.c.post('/api/applications', body)));
  assert.equal(res.filter(r => r.s === 200).length, 2); assert.equal(res.filter(r => r.s === 402).length, 8);
  const me = await u.me(); assert.equal(me.wallet, 350 - 240); assert.ok(me.wallet >= 0);
  const ids = res.filter(r => r.s === 200).map(r => r.d.id); assert.equal(new Set(ids).size, ids.length);
  const p = (await u.c.post('/api/payments', { amount: 400 })).d.id; await u.c.post(`/api/payments/${p}/utr`, { utr: '700000000001' });
  const ap = await Promise.all([1, 2, 3, 4, 5].map(() => admin.post(`/api/admin/payments/${p}/decide`, { approve: true })));
  assert.equal(ap.filter(r => r.s === 200).length, 1); assert.equal((await u.me()).wallet, 110 + 400);
});

test('passwords: change, admin-assisted reset with a temporary password, old sessions die, no account enumeration', async () => {
  const u = await newRetailer(), other = new Client();
  await other.post('/api/login', { id: u.mobile, password: u.password });
  assert.equal((await u.c.post('/api/password/change', { current: 'Wrong1234', password: 'NewSecret1' })).s, 400);
  assert.equal((await u.c.post('/api/password/change', { current: u.password, password: 'weak' })).s, 400);
  assert.equal((await u.c.post('/api/password/change', { current: u.password, password: 'NewSecret1' })).s, 200);
  assert.equal((await other.get('/api/state')).s, 401);                                                  // other device logged out
  assert.equal((await u.c.get('/api/state')).s, 200);                                                    // this one stays
  assert.equal((await new Client().post('/api/login', { id: u.mobile, password: u.password })).s, 401);
  const anon = new Client(), admin = await adminClient();
  const real = await anon.post('/api/forgot/start', { id: u.mobile }), fake = await anon.post('/api/forgot/start', { id: '9999999999' });
  assert.deepEqual(real.d, fake.d);                                                                       // no account enumeration
  await anon.post('/api/forgot/start', { id: u.email }); await anon.post('/api/forgot/start', { id: u.mobile });
  const reqs = (await admin.get('/api/state')).d.resets.filter(r => r.mobile === u.mobile); assert.equal(reqs.length, 1);   // duplicates collapse into one request
  assert.equal((await anon.post('/api/forgot/start', { id: 'sachinah98@gmail.com' })).s, 200);
  assert.ok(!(await admin.get('/api/state')).d.resets.some(r => r.email === 'sachinah98@gmail.com'));   // the admin account cannot be reset this way
  assert.equal((await anon.post('/api/forgot/reset', { id: u.mobile, code: '000000', password: 'Another123' })).s, 404);   // OTP reset is off in this mode
  assert.equal((await u.c.post(`/api/admin/resets/${reqs[0].id}/issue`)).s, 403);                         // retailers cannot issue passwords
  const issued = await admin.post(`/api/admin/resets/${reqs[0].id}/issue`); assert.equal(issued.s, 200);
  const temp = issued.d.password; assert.ok(temp.length >= 12 && /[A-Za-z]/.test(temp) && /\d/.test(temp));
  assert.equal((await admin.post(`/api/admin/resets/${reqs[0].id}/issue`)).s, 400);                       // an issued request is closed
  assert.equal((await u.c.get('/api/state')).s, 401);                                                     // old sessions end
  assert.equal((await new Client().post('/api/login', { id: u.mobile, password: 'NewSecret1' })).s, 401); // old password is dead
  const tc = new Client(); assert.equal((await tc.post('/api/login', { id: u.mobile, password: temp })).s, 200);
  assert.equal((await tc.get('/api/state')).d.me.mustChange, true);
  assert.equal((await tc.post('/api/payments', { amount: 500 })).d.code, 'MUST_CHANGE');                  // locked until a new password is chosen
  assert.equal((await tc.post('/api/profile', { name: 'Test User', email: u.email, mobile: u.mobile, state: 'Goa' })).s, 403);
  assert.equal((await tc.post('/api/password/change', { current: temp, password: temp })).s, 400);
  assert.equal((await tc.post('/api/password/change', { current: temp, password: 'Another123' })).s, 200);
  assert.equal((await tc.post('/api/payments', { amount: 500 })).s, 200);                                 // normal use resumes
  assert.equal((await new Client().post('/api/login', { id: u.mobile, password: temp })).s, 401);         // temporary password is dead
  assert.equal((await new Client().post('/api/login', { id: u.mobile, password: 'Another123' })).s, 200);
  const dm = await newRetailer(); await anon.post('/api/forgot/start', { id: dm.mobile });
  const rq = (await admin.get('/api/state')).d.resets.find(r => r.mobile === dm.mobile);
  assert.equal((await admin.post(`/api/admin/resets/${rq.id}/dismiss`)).s, 200);
  assert.ok(!(await admin.get('/api/state')).d.resets.some(r => r.mobile === dm.mobile));
  assert.equal((await dm.c.get('/api/state')).s, 200);                                                    // dismissing changes nothing for the retailer
  const log = (await admin.get('/api/state')).d.audit; assert.ok(log.some(a => a.action === 'password_reset_issued') && log.some(a => a.action === 'password_reset_requested'));
});

test('login brute force is throttled per account', async () => {
  const u = await newRetailer(); let last;
  for (let i = 0; i < 10; i++) last = await new Client('10.77.7.7').post('/api/login', { id: u.mobile, password: 'Wrong' + i + 'abcd' });
  assert.equal(last.s, 429);
  assert.equal((await new Client('10.77.7.7').post('/api/login', { id: u.mobile, password: u.password })).s, 429);  // that attacker is locked out...
  assert.equal((await new Client('10.88.8.8').post('/api/login', { id: u.mobile, password: u.password })).s, 200);  // ...but the real owner is not (no remote lock-out)
});

test('profile, agents, tickets, notifications, announcement, SMS log', async () => {
  const u = await newRetailer(), admin = await adminClient(), v = await u.me();
  assert.equal((await u.c.post('/api/profile', { name: 'New Name', email: v.email, mobile: v.mobile, state: 'Kerala', username: 'ab' })).s, 400);
  assert.equal((await u.c.post('/api/profile', { name: 'New Name', email: v.email, mobile: v.mobile, state: 'Kerala', username: 'new_name' })).s, 200);
  const chg = { name: 'New Name', email: v.email, mobile: '9333333333', state: 'Kerala', username: 'new_name' };
  assert.equal((await u.c.post('/api/profile', chg)).s, 400);                                                       // changing the mobile needs the current password
  assert.equal((await u.c.post('/api/profile', { ...chg, current: 'Wrong1234' })).s, 400);
  assert.equal((await u.c.post('/api/otp/send', { mobile: '9333333333', purpose: 'mobile' })).s, 400);               // no OTP step any more
  assert.equal((await u.c.post('/api/profile', { ...chg, email: 'other@example.com' })).s, 400);                   // e-mail change needs it too
  assert.equal((await u.c.post('/api/profile', { ...chg, password: 'Brand9New1' })).s, 400);                       // so does a password change
  assert.equal((await u.c.post('/api/profile', { ...chg, current: u.password })).s, 200);
  const dev2 = new Client(); await dev2.post('/api/login', { id: '9333333333', password: u.password });
  assert.equal((await u.c.post('/api/profile', { ...chg, current: u.password, password: 'Brand9New1' })).s, 200);
  assert.equal((await dev2.get('/api/state')).s, 401); assert.equal((await u.c.get('/api/state')).s, 200);          // other devices are signed out, this one stays
  u.password = 'Brand9New1';
  const me = await u.me(); assert.equal(me.mobile, '9333333333'); assert.equal(me.username, 'new_name'); assert.equal(me.state, 'Kerala');
  assert.equal((await new Client().post('/api/login', { id: 'new_name', password: 'Brand9New1' })).s, 200);
  assert.equal((await admin.post('/api/profile', { name: 'Hacker', email: 'x@y.com', mobile: '9444444444', state: 'Goa' })).s, 403);
  assert.equal((await u.c.post('/api/agents', { name: 'Agent', mobile: '9555555555' })).s, 200);
  assert.equal((await u.c.post('/api/agents', { name: 'Agent', mobile: '12' })).s, 400);
  const g = (await u.c.get('/api/state')).d.me.agents; assert.equal(g.length, 1);
  await u.c.post('/api/agents/delete', { id: g[0].id }); assert.equal((await u.c.get('/api/state')).d.me.agents.length, 0);
  assert.equal((await u.c.post('/api/tickets', { topic: 'Bogus', msg: 'help please' })).s, 400);
  assert.equal((await u.c.post('/api/tickets', { topic: 'Payment issue', msg: 'help please' })).s, 200);
  const tk = (await u.c.get('/api/state')).d.tickets[0]; assert.equal(tk.status, 'Open');
  assert.equal((await u.c.post(`/api/admin/tickets/${tk.id}/resolve`)).s, 403);
  assert.equal((await admin.post(`/api/admin/tickets/${tk.id}/resolve`)).s, 200);
  assert.equal((await u.c.get('/api/state')).d.tickets[0].status, 'Resolved');
  assert.ok((await u.c.get('/api/state')).d.me.n.some(n => /resolved/.test(n.m)));
  await u.c.post('/api/notifications/read'); assert.ok((await u.c.get('/api/state')).d.me.n.every(n => n.r === 1));
  assert.equal((await admin.post('/api/admin/announcement', { text: '' })).s, 400);
  assert.equal((await admin.post('/api/admin/announcement', { text: 'Holiday on Sunday' })).s, 200);
  assert.equal((await new Client().get('/api/config')).d.announcement, 'Holiday on Sunday');
  assert.equal((await admin.post('/api/admin/sms/test', { mobile: '9666666666' })).s, 200);
  assert.ok((await admin.get('/api/state')).d.sms.some(s => s.type === 'TEST'));
});

test('data survives a server restart', async () => {
  const u = await newRetailer(), admin = await adminClient(), v = await u.me();
  await fund(admin, v.id, 777);
  await stop(); out = ''; for (const k in otpSeen) delete otpSeen[k]; await startServer();
  assert.equal((await u.c.get('/api/state')).d.me.wallet, 777);                                          // same session cookie still valid
  assert.equal((await new Client().post('/api/login', { id: v.mobile, password: u.password })).s, 200);
});

test('disabling a retailer: signed out, cannot log in, can be re-enabled, audited', async () => {
  const u = await newRetailer(), admin = await adminClient(), v = await u.me();
  assert.equal((await u.c.post(`/api/admin/users/${v.id}/status`, { disabled: true, reason: 'x y z' })).s, 403);   // retailers cannot
  assert.equal((await admin.post(`/api/admin/users/${v.id}/status`, { disabled: true })).s, 400);                    // reason required
  assert.equal((await admin.post('/api/admin/users/admin/status', { disabled: true, reason: 'nope nope' })).s, 404);  // admin cannot be disabled
  assert.equal((await admin.post(`/api/admin/users/${v.id}/status`, { disabled: true, reason: 'Suspicious activity' })).s, 200);
  assert.equal((await u.c.get('/api/state')).s, 401);                                                                 // existing session dies at once
  const bad = await new Client().post('/api/login', { id: v.mobile, password: 'Wrong12345' }), good = await new Client().post('/api/login', { id: v.mobile, password: u.password });
  assert.equal(bad.s, 401); assert.equal(good.s, 403); assert.match(good.d.error, /disabled/);                         // only the real owner is told why
  assert.ok((await admin.get('/api/state')).d.users.find(x => x.id === v.id).disabled);
  assert.equal((await admin.post(`/api/admin/users/${v.id}/status`, { disabled: false })).s, 200);
  assert.equal((await new Client().post('/api/login', { id: v.mobile, password: u.password })).s, 200);
  const log = (await admin.get('/api/state')).d.audit;
  assert.ok(log.some(a => a.action === 'user_disabled' && /Suspicious activity/.test(a.detail)) && log.some(a => a.action === 'user_enabled'));
  assert.ok(log.some(a => a.action === 'login'));                                                                      // admin sign-ins are recorded
});

test('input hygiene: names, usernames and free text cannot carry markup or fake logins', async () => {
  const c = new Client(), mobile = '9000000077', ok = { mobile, email: 'x77@example.com', state: 'Goa', password: 'Secret123' };
  await c.post('/api/otp/send', { mobile, purpose: 'register' });
  for (const name of ['<img src=x onerror=alert(1)>', 'Bob123', 'A', '<b>Bob</b>']) assert.equal((await c.post('/api/register', { ...ok, name, code: await lastOtp(mobile) })).s, 400, name);
  const u = await newRetailer(), v = await u.me(), admin = await adminClient();
  for (const username of ['9876543210', '1abc', 'a@b.co', 'x y', 'ab']) assert.equal((await u.c.post('/api/profile', { name: 'Okay Name', email: v.email, mobile: v.mobile, state: 'Goa', username })).s, 400, username);
  await fund(admin, v.id, 500);
  const app = { cat: 'PAN', svc: 'PAN Reprint', name: 'Customer', mobile: '9123456780' };
  assert.equal((await u.c.post('/api/applications', { ...app, note: '<script>alert(1)</script>' })).s, 400);
  assert.equal((await u.c.post('/api/applications', { ...app, name: 'Cust<>' })).s, 400);
  assert.equal((await u.c.post('/api/tickets', { topic: 'Other', msg: '<img src=x onerror=1>' })).s, 400);
  assert.equal((await admin.post(`/api/admin/users/${v.id}/funds`, { amount: 10 })).s, 400);                       // reason required
});

test('sessions: capped per account, HSTS only over HTTPS', async () => {
  const u = await newRetailer(), first = new Client(); await first.post('/api/login', { id: u.mobile, password: u.password });
  for (let i = 0; i < 11; i++) await new Client().post('/api/login', { id: u.mobile, password: u.password });
  assert.equal((await first.get('/api/state')).s, 401);                                                              // oldest of >10 sessions dropped
  const plain = await new Client().get('/api/health'), tls = await new Client().req('GET', '/api/health', undefined, { 'X-Forwarded-Proto': 'https' });
  assert.ok(!plain.h.get('strict-transport-security')); assert.match(tls.h.get('strict-transport-security'), /max-age/);
  const login = await new Client().req('POST', '/api/login', { id: u.mobile, password: u.password }, { 'X-Forwarded-Proto': 'https' });
  assert.match(login.h.get('set-cookie'), /; Secure/);
});

test('reports and CSV exports: correct totals, admin only, formula-injection safe', async () => {
  const admin = await adminClient(), before = (await admin.get('/api/admin/reports')).d;
  const u = await newRetailer(), v = await u.me();
  const pid = (await u.c.post('/api/payments', { amount: 1000 })).d.id; await u.c.post(`/api/payments/${pid}/utr`, { utr: '800000000001' });
  await admin.post(`/api/admin/payments/${pid}/decide`, { approve: true });
  const a1 = (await u.c.post('/api/applications', { cat: 'PAN', svc: 'New PAN Application', name: 'Customer', mobile: '9123456780', note: '=HYPERLINK("http://x")' })).d.id;
  const a2 = (await u.c.post('/api/applications', { cat: 'Print', svc: 'Aadhaar Print', name: 'Customer', mobile: '9123456780' })).d.id;
  await admin.post(`/api/admin/applications/${a1}/status`, { status: 'Completed' }); await admin.post(`/api/admin/applications/${a2}/status`, { status: 'Rejected' });
  const r = (await admin.get('/api/admin/reports')).d;
  assert.equal(r.recharges.amount - before.recharges.amount, 1000); assert.equal(r.recharges.count - before.recharges.count, 1);
  assert.equal(r.revenue - before.revenue, 120); assert.equal(r.refunds - before.refunds, 15); assert.equal(r.commission - before.commission, 12);
  assert.equal(r.newRetailers - before.newRetailers, 1); assert.ok(r.daily.length === 30 && r.daily.at(-1).recharge >= 1000);
  assert.ok(r.topServices.some(s => s.name === 'New PAN Application')); assert.equal(r.appsByStatus.Rejected - (before.appsByStatus.Rejected || 0), 1);
  assert.equal((await admin.get('/api/admin/reports?from=2026-13-01&to=2026-01-01')).s, 400);
  assert.equal((await admin.get('/api/admin/reports?from=2020-01-01&to=2026-01-01')).s, 400);                        // > 366 days
  assert.equal((await u.c.get('/api/admin/reports')).s, 403); assert.equal((await u.c.get('/api/admin/export/retailers')).s, 403);
  assert.equal((await new Client().get('/api/admin/export/payments')).s, 401);
  const res = await fetch(`${BASE}/api/admin/export/applications`, { headers: { Cookie: admin.cookie } }), raw = Buffer.from(await res.arrayBuffer()), text = raw.toString('utf8');
  assert.deepEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);                                                      // UTF-8 BOM so Excel reads it correctly
  assert.match(res.headers.get('content-type'), /text\/csv/); assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.ok(text.includes("'=HYPERLINK") && !text.includes(',=HYPERLINK') && !text.includes('"=HYPERLINK'));          // formula neutralised
  assert.ok(text.startsWith('\uFEFFApplication ID') && text.includes(a1));
  assert.equal((await fetch(`${BASE}/api/admin/export/nothing`, { headers: { Cookie: admin.cookie } })).status, 404);
  const csvR = await (await fetch(`${BASE}/api/admin/export/retailers`, { headers: { Cookie: admin.cookie } })).text();
  assert.ok(csvR.includes(v.mobile) && !/scrypt/.test(csvR));                                                         // no password hashes ever
  assert.ok((await admin.get('/api/state')).d.audit.some(a => a.action === 'export'));
});

test('session check: anonymous gets a quiet 200, logged-in users get their data', async () => {
  const anon = await new Client().get('/api/session'); assert.equal(anon.s, 200); assert.equal(anon.d.authenticated, false);
  const u = await newRetailer(), r = await u.c.get('/api/session'); assert.equal(r.s, 200); assert.equal(r.d.authenticated, true); assert.equal(r.d.me.mobile, u.mobile);
});

test('OTP switched off: people register directly, still log in, alerts still sent, reset still uses OTP', async () => {
  const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'seva-noOTP-')), P2 = PORT + 500; let o2 = '';
  const p2 = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: P2, DATA_DIR: D2, ADMIN_PASSWORD: ADMIN_PW, SMS_PROVIDER: 'console', REQUIRE_OTP: 'false', RESET_METHOD: 'otp', RATE_LIMIT_SCALE: '100', TRUST_PROXY: 'true' } });
  p2.stdout.on('data', d => { o2 += d; });
  try {
    for (let i = 0; i < 80 && !o2.includes('running at'); i++) await sleep(100);
    assert.match(o2, /OTP required: false/);
    const call = async (m, u, b, ck) => { const r = await fetch(`http://127.0.0.1:${P2}${u}`, { method: m, headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); return { s: r.status, d: await r.json().catch(() => ({})), ck: sc && sc.split(';')[0] }; };
    assert.equal((await call('GET', '/api/config')).d.requireOtp, false);
    const reg = await call('POST', '/api/register', { name: 'Direct Person', mobile: '9822200011', email: 'direct@example.com', state: 'Goa', password: 'Secret123' });   // no code at all
    assert.equal(reg.s, 200, JSON.stringify(reg.d));
    assert.ok(!o2.includes('[SMS otp]'), 'no OTP SMS was sent at registration');
    const login = await call('POST', '/api/login', { id: '9822200011', password: 'Secret123' }); assert.equal(login.s, 200);
    assert.equal((await call('POST', '/api/register', { name: 'Direct Person', mobile: '9822200011', email: 'other@example.com', state: 'Goa', password: 'Secret123' })).s, 409);   // still unique
    const adm = await call('POST', '/api/login', { id: 'sachinah98@gmail.com', password: ADMIN_PW }), me = (await (await fetch(`http://127.0.0.1:${P2}/api/state`, { headers: { Cookie: login.ck } })).json()).me;
    assert.equal(me.verified, false);
    assert.equal((await call('POST', `/api/admin/users/${me.id}/funds`, { amount: 500, note: 'test funds' }, adm.ck)).s, 200);
    await call('POST', '/api/applications', { cat: 'Print', svc: 'Aadhaar Print', name: 'Customer', mobile: '9123456780' }, login.ck);
    for (let i = 0; i < 20 && !/\[SMS notify\]/.test(o2); i++) await sleep(50);
    assert.match(o2, /\[SMS notify\] to 9822200011: .*Application SSS-100001/);                       // alert reached the unverified number
    await call('POST', '/api/forgot/start', { id: '9822200011' }); for (let i = 0; i < 20 && !o2.includes('[SMS otp]'); i++) await sleep(50);
    const code = (o2.match(/OTP is (\d{6})/) || [])[1];
    assert.equal((await call('POST', '/api/forgot/reset', { id: '9822200011', code: '000000', password: 'Another123' })).s, 400);
    assert.equal((await call('POST', '/api/forgot/reset', { id: '9822200011', code, password: 'Another123' })).s, 200);                       // password reset still needs the OTP
  } finally { p2.kill(); await new Promise(r => setTimeout(r, 200)); fs.rmSync(D2, { recursive: true, force: true }); }
});
