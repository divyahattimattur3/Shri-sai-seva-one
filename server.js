'use strict';
/**
 * Shri Sai Service Seva One — website + backend (Node 22.13+, zero npm dependencies).
 * SQLite database, scrypt-hashed passwords, HttpOnly session cookies, server-side wallets/fees/approvals, SMS OTP.
 */
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`This site needs Node.js 22.13 or newer (you have ${process.versions.node}).\nInstall Node.js 24 LTS from https://nodejs.org and run again.`);
  process.exit(1);
}
require('./lib/env');
const http = require('http'), fs = require('fs'), path = require('path');
const E = process.env;
const { open } = require('./lib/db'), auth = require('./lib/auth'), sms = require('./lib/sms'), SV = require('./lib/services');

const PORT = Number(E.PORT) || 3000;
const BIND_HOST = E.BIND_HOST || '0.0.0.0';
const DATA_DIR = E.DATA_DIR || path.join(__dirname, 'data');
const isTest = process.env.NODE_ENV === 'test' || (E.DATA_DIR && /seva-/.test(E.DATA_DIR));
const ADMIN_EMAIL = (E.ADMIN_EMAIL || 'sachinah98@gmail.com').toLowerCase();
const ADMIN_MOBILE = E.ADMIN_MOBILE || '8123860840';
const UPI_ID = E.UPI_ID || '8123860840@axl';
const MIN_RECHARGE = Number(E.MIN_RECHARGE) || 300, MAX_RECHARGE = Number(E.MAX_RECHARGE) || 50000;
const RESET_METHOD = E.RESET_METHOD || (isTest ? 'admin' : 'direct');   // forgot-password: 'direct' (set without verification), 'otp' (SMS OTP) or 'admin'
const REQUIRE_OTP = E.REQUIRE_OTP === 'true';                       // SMS OTP when someone registers (off by default)
const ALERT_UNVERIFIED = E.ALERT_UNVERIFIED ? E.ALERT_UNVERIFIED === 'true' : !REQUIRE_OTP; // send SMS alerts even if the number was never OTP-verified
const TRUST_PROXY = E.TRUST_PROXY !== undefined ? E.TRUST_PROXY === 'true' : true;
const HOUR = 3600e3, DAY = 24 * HOUR;
const STATES = ['Andhra Pradesh','Assam','Bihar','Chhattisgarh','Delhi','Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Odisha','Punjab','Rajasthan','Tamil Nadu','Telangana','Uttar Pradesh','Uttarakhand','West Bengal'];
const TOPICS = ['Payment issue', 'Application delay', 'Technical problem', 'Other'];
const STATUSES = ['Received', 'In process', 'Completed', 'Rejected'];
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;

const db = open(DATA_DIR);

/* ---------------- helpers ---------------- */
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const bad = (m, code) => new HttpError(400, m, code);
const now = () => Date.now();
const fmt = t => (t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : null);
const okMobile = m => /^[6-9]\d{9}$/.test(String(m));
const okEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e)) && String(e).length <= 100;
function str(v, minLen, maxLen, label) {
  const s = String(v ?? '').trim();
  if (s.length < minLen || s.length > maxLen) throw bad(`${label} must be ${minLen}–${maxLen} characters.`);
  if (/[<>\u0000-\u001f]/.test(s)) throw bad(`${label} contains characters that are not allowed.`);
  return s;
}
/** Person names: letters, spaces, dots, hyphens, apostrophes only (also keeps markup out of the database). */
function person(v, label, minLen = 2) {
  const s = str(v, minLen, 60, label);
  if (!NAME_RE.test(s)) throw bad(`${label} may contain only letters, spaces, dots, hyphens and apostrophes.`);
  return s;
}
const nextId = (table, prefix, start) => prefix + (start + db.get(`SELECT COUNT(*) c FROM ${table}`).c);
const setting = k => (db.get('SELECT value FROM settings WHERE key=?', k) || {}).value;
const putSetting = (k, v) => db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
const audit = (actor, action, detail) => db.run('INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)', actor, action, detail, now());
const addNotif = (uid, msg) => db.run('INSERT INTO notifs(uid,msg,created_at) VALUES(?,?,?)', uid, msg, now());
const addTx = (uid, wallet, amount, descr, ref) => db.run('INSERT INTO tx(uid,wallet,amount,descr,ref,created_at) VALUES(?,?,?,?,?,?)', uid, wallet, amount, descr, ref ? 1 : 0, now());
const col = w => (w === 'main' ? 'wallet' : 'earn');
const credit = (uid, w, amt) => db.run(`UPDATE users SET ${col(w)}=${col(w)}+? WHERE id=?`, amt, uid);
const debit = (uid, w, amt) => db.run(`UPDATE users SET ${col(w)}=${col(w)}-? WHERE id=? AND ${col(w)}>=?`, amt, uid, amt).changes === 1;
const inr = n => 'Rs ' + n;
const smsUser = (uid, type, text) => { const u = db.get('SELECT * FROM users WHERE id=?', uid); if (u) sms.notify(db, u, type, text, ALERT_UNVERIFIED).catch(() => {}); };

/* ---------------- first-run admin ---------------- */
async function bootstrapAdmin() {
  if (db.get("SELECT 1 x FROM users WHERE role='admin'")) return;
  let pw = E.ADMIN_PASSWORD, generated = false;
  if (pw) { const p = auth.passwordProblem(pw); if (p) { console.error('ADMIN_PASSWORD in .env is not acceptable: ' + p); process.exit(1); } }
  else { pw = auth.randomPassword(); generated = true; }
  db.run('INSERT INTO users(id,name,mobile,email,pass_hash,role,mobile_verified,code,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'admin', 'Administrator', ADMIN_MOBILE, ADMIN_EMAIL, await auth.hashPassword(pw), 'admin', 1, 'ADMIN', now());
  if (generated) {
    const f = path.join(DATA_DIR, 'FIRST-RUN-ADMIN-PASSWORD.txt');
    fs.writeFileSync(f, `Admin login for the website\nEmail:    ${ADMIN_EMAIL}\nMobile:   ${ADMIN_MOBILE}\nPassword: ${pw}\n\nLog in, then change this password (Change Password in the left menu) and delete this file.\n`);
    console.log(`\n==============================================\n FIRST RUN – admin account created\n  Email:    ${ADMIN_EMAIL}\n  Password: ${pw}\n  (also saved in ${f})\n  Change it after your first login.\n==============================================\n`);
  }
}

/* ---------------- sessions ---------------- */
const secureReq = req => !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
function setCookie(res, req, val, maxMs) {
  const isSec = secureReq(req);
  const sameSite = isTest ? 'SameSite=Lax' : (isSec ? 'SameSite=None; Partitioned' : 'SameSite=Lax');
  const secPart = isSec ? '; Secure' : '';
  const maxPart = maxMs !== null && maxMs !== undefined ? `; Max-Age=${Math.floor(maxMs / 1000)}` : '';
  res.setHeader('Set-Cookie', `sid=${val}; Path=/; HttpOnly; ${sameSite}${secPart}${maxPart}`);
}
function createSession(req, res, userId, remember) {
  const t = auth.newToken(), ttl = remember ? 30 * DAY : 12 * HOUR;
  db.run('DELETE FROM sessions WHERE user_id=? AND token NOT IN (SELECT token FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 9)', userId, userId); // max 10 devices
  db.run('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)', auth.tokenHash(t), userId, now(), now() + ttl);
  setCookie(res, req, t, remember ? ttl : null);
}
const sessionToken = req => auth.parseCookies(req.headers.cookie).sid;
function getUser(req) {
  const t = sessionToken(req); if (!t) return null;
  const h = auth.tokenHash(t), s = db.get('SELECT user_id, expires_at FROM sessions WHERE token=?', h);
  if (!s) return null;
  if (s.expires_at < now()) { db.run('DELETE FROM sessions WHERE token=?', h); return null; }
  const u = db.get('SELECT * FROM users WHERE id=?', s.user_id);
  return u && !u.disabled ? u : null;
}
setInterval(() => { try { db.run('DELETE FROM sessions WHERE expires_at<?', now()); } catch {} }, HOUR).unref();
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

/* ---------------- state sent to the page ---------------- */
const sUser = u => ({ id: u.id, name: u.name, mobile: u.mobile, email: u.email, state: u.state || '', username: u.username || '', wallet: u.wallet, earn: u.earn, code: u.code || '', role: u.role, verified: !!u.mobile_verified, disabled: !!u.disabled, mustChange: !!u.must_change });
const sApp = a => ({ id: a.id, cat: a.cat, svc: a.svc, fee: a.fee, comm: a.comm, owner: a.owner, name: a.cname, mobile: a.cmobile, note: a.note || '', status: a.status, date: fmt(a.created_at) });
const sTx = t => ({ id: 'TX' + (1000 + t.id), uid: t.uid, w: t.wallet, amt: t.amount, desc: t.descr, ref: !!t.ref, date: fmt(t.created_at) });
const sPay = p => ({ id: p.id, uid: p.user_id, amt: p.amount, status: p.status, utr: p.utr || '', date: fmt(p.created_at), sub: fmt(p.submitted_at) });
const sTk = t => ({ id: t.id, uid: t.uid, sub: t.topic, msg: t.msg, status: t.status, date: fmt(t.created_at) });
const sSms = s => ({ id: 'SMS' + (1000 + s.id), to: s.to_mobile, type: s.type, text: s.text, status: s.status, date: fmt(s.created_at) });
const LAST = (table, order, n, where = '', ...p) => db.all(`SELECT * FROM (SELECT * FROM ${table} ${where} ORDER BY ${order} DESC LIMIT ${n}) ORDER BY ${order}`, ...p);

function stateFor(u) {
  const admin = u.role === 'admin', me = sUser(u);
  let users, apps, tx, pays, tix, smsRows = [], auditRows = [], resetRows = [];
  if (admin) {
    users = db.all("SELECT * FROM users WHERE role='retailer' ORDER BY created_at").map(sUser);
    apps = LAST('apps', 'created_at', 2000); tx = LAST('tx', 'id', 3000); pays = LAST('payments', 'created_at', 1000);
    tix = LAST('tickets', 'created_at', 500); smsRows = LAST('sms_log', 'id', 100);
    auditRows = db.all('SELECT a.id, a.actor, a.action, a.detail, a.created_at, u.name FROM audit a LEFT JOIN users u ON u.id = a.actor ORDER BY a.id DESC LIMIT 300');
    me.smsProvider = sms.PROVIDER;
    resetRows = db.all("SELECT r.id, r.user_id, r.created_at, u.name, u.mobile, u.email FROM reset_requests r JOIN users u ON u.id = r.user_id WHERE r.status='Open' ORDER BY r.id");
  } else {
    me.n = db.all('SELECT msg, created_at, is_read FROM notifs WHERE uid=? ORDER BY id DESC LIMIT 30', u.id).map(n => ({ m: n.msg, t: fmt(n.created_at), r: n.is_read }));
    me.agents = db.all('SELECT id, name, mobile FROM agents WHERE uid=? ORDER BY id', u.id).map(a => ({ id: a.id, n: a.name, m: a.mobile }));
    me.refs = db.get('SELECT COUNT(*) c FROM users WHERE ref_by=?', u.id).c;
    users = [me];
    apps = LAST('apps', 'created_at', 500, 'WHERE owner=?', u.id); tx = LAST('tx', 'id', 1000, 'WHERE uid=?', u.id);
    pays = LAST('payments', 'created_at', 300, 'WHERE user_id=?', u.id); tix = LAST('tickets', 'created_at', 200, 'WHERE uid=?', u.id);
  }
  return { me, users, apps: apps.map(sApp), tx: tx.map(sTx), payments: pays.map(sPay), tickets: tix.map(sTk), sms: smsRows.map(sSms), resets: resetRows.map(r => ({ id: r.id, uid: r.user_id, name: r.name, mobile: r.mobile, email: r.email, date: fmt(r.created_at) })), audit: auditRows.map(a => ({ id: a.id, actor: a.name || a.actor, action: a.action, detail: a.detail || '', date: fmt(a.created_at) })), announcement: setting('announcement') || '' };
}

/* ---------------- routes ---------------- */
const routes = [];
const route = (method, p, opt, h) => routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), opt, h });
const retailerOnly = u => { if (u.role !== 'retailer') throw new HttpError(403, 'This action is for retailer accounts.'); };
const LOGIN_WINDOW = 15 * 60e3;

route('GET', '/api/health', {}, () => ({ ok: true }));
route('GET', '/api/config', {}, () => ({
  services: SV, upiId: UPI_ID, minRecharge: MIN_RECHARGE, maxRecharge: MAX_RECHARGE, requireOtp: REQUIRE_OTP, resetMethod: RESET_METHOD, smsDemo: sms.PROVIDER === 'console',
  announcement: setting('announcement') || '', contact: { email: ADMIN_EMAIL, mobile: ADMIN_MOBILE }, states: STATES
}));

route('POST', '/api/otp/send', {}, async ({ body, user, ip }) => {
  const mobile = String(body.mobile || ''), purpose = String(body.purpose || '');
  if (!okMobile(mobile)) throw bad('Enter a valid 10-digit mobile number.');
  if (purpose === 'register') { if (db.get('SELECT 1 x FROM users WHERE mobile=?', mobile)) throw new HttpError(409, 'This mobile number is already registered.'); }
  else throw bad('Invalid request.');
  const r = await sms.sendOtp(mobile, ip);
  if (!r.ok) throw new HttpError(r.status, r.error);
  return { ok: true };
});

route('POST', '/api/register', {}, async ({ body, ip }) => {
  if (sms.limited('rg:' + ip, 20, HOUR)) throw new HttpError(429, 'Too many attempts. Try again later.');
  const name = person(body.name, 'Name', 3), mobile = String(body.mobile || ''), email = String(body.email || '').trim().toLowerCase();
  if (!okMobile(mobile)) throw bad('Enter a valid 10-digit mobile number.');
  if (!okEmail(email)) throw bad('Enter a valid email address.');
  if (!STATES.includes(body.state)) throw bad('Select your state.');
  const pp = auth.passwordProblem(body.password); if (pp) throw bad(pp);
  if (mobile === ADMIN_MOBILE || email === ADMIN_EMAIL) throw new HttpError(409, 'Mobile or email is already registered.');
  const refCode = String(body.referral || '').trim().toUpperCase();
  const referrer = refCode ? db.get("SELECT * FROM users WHERE code=? AND role='retailer'", refCode) : null;
  if (refCode && !referrer) throw bad('Invalid referral code.');
  if (db.get('SELECT 1 x FROM users WHERE mobile=? OR email=?', mobile, email)) throw new HttpError(409, 'Mobile or email is already registered.');
  if (REQUIRE_OTP) { const o = sms.checkOtp(mobile, body.code); if (!o.ok) throw bad(o.error); }
  const hash = await auth.hashPassword(body.password);
  db.tx(() => {
    if (db.get('SELECT 1 x FROM users WHERE mobile=? OR email=?', mobile, email)) throw new HttpError(409, 'Mobile or email is already registered.');
    const id = 'U' + require('crypto').randomBytes(5).toString('hex'), code = 'SSS' + (1001 + db.get("SELECT COUNT(*) c FROM users WHERE role='retailer'").c);
    db.run('INSERT INTO users(id,name,mobile,email,state,pass_hash,role,code,ref_by,mobile_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id, name, mobile, email, body.state, hash, 'retailer', code, referrer ? referrer.id : null, REQUIRE_OTP ? 1 : 0, now());
    if (referrer) addNotif(referrer.id, `${name} registered with your code. You earn ₹10 when they make their first wallet recharge.`);
  });
  return { ok: true };
});

route('POST', '/api/login', {}, async ({ req, res, body, ip }) => {
  const id = String(body.id || '').trim().toLowerCase(), pw = String(body.password || '');
  if (!id || !pw || id.length > 100 || pw.length > 200) throw bad('Please fill out both fields.');
  if (sms.limited('li:' + ip, 40, LOGIN_WINDOW) || sms.limited('lu:' + id + '|' + ip, 8, LOGIN_WINDOW) || sms.limited('lg:' + id, 60, LOGIN_WINDOW)) throw new HttpError(429, 'Too many login attempts. Please wait 15 minutes.');
  const u = db.get('SELECT * FROM users WHERE mobile=?', id) || db.get('SELECT * FROM users WHERE email=?', id) || db.get('SELECT * FROM users WHERE username=?', id);
  const ok = await auth.verifyPassword(pw, u ? u.pass_hash : auth.DUMMY_HASH);
  if (!u || !ok) { if (u && u.role === 'admin') audit('admin', 'login_failed', ip); throw new HttpError(401, 'Invalid credentials. Please try again.'); }
  if (u.disabled) throw new HttpError(403, 'This account has been disabled. Please contact support.');
  createSession(req, res, u.id, !!body.remember);
  if (u.role === 'admin') audit(u.id, 'login', ip);
  return { ok: true, role: u.role };
});

route('POST', '/api/logout', {}, ({ req, res }) => {
  const t = sessionToken(req); if (t) db.run('DELETE FROM sessions WHERE token=?', auth.tokenHash(t));
  setCookie(res, req, '', 0); return { ok: true };
});

route('POST', '/api/forgot/start', {}, async ({ body, ip }) => {
  const id = String(body.id || '').trim().toLowerCase();
  if (!id || id.length > 100) throw bad('Enter your registered email or mobile number.');
  if (sms.limited('fi:' + ip, 20, HOUR)) throw new HttpError(429, 'Too many requests. Try again later.');
  const u = db.get('SELECT * FROM users WHERE mobile=? OR email=? OR username=?', id, id, id);
  if (RESET_METHOD === 'direct') {
    if (!u) throw bad('No account found with this email or mobile number.');
    return { ok: true, method: 'direct' };
  }
  if (RESET_METHOD === 'otp') { if (u) await sms.sendOtp(u.mobile, ip); return { ok: true, method: 'otp' }; }   // same answer whether or not the account exists
  // admin-assisted: record a request for the administrator (retailers only; the admin account uses reset-admin.bat)
  if (u && u.role === 'retailer' && !sms.limited('fu:' + u.id, 3, HOUR) && !db.get("SELECT 1 x FROM reset_requests WHERE user_id=? AND status='Open'", u.id)) {
    db.run('INSERT INTO reset_requests(user_id,status,created_at) VALUES(?,?,?)', u.id, 'Open', now()); audit(u.id, 'password_reset_requested', '');
  }
  return { ok: true, method: 'admin' };
});

route('POST', '/api/forgot/reset', {}, async ({ body, ip }) => {
  if (RESET_METHOD === 'admin') throw new HttpError(404, 'Not available.');
  if (sms.limited('fr:' + ip, 40, HOUR)) throw new HttpError(429, 'Too many attempts. Try again later.');
  const id = String(body.id || '').trim().toLowerCase();
  if (!id || id.length > 100) throw bad('Enter your registered email or mobile number.');
  const u = db.get('SELECT * FROM users WHERE mobile=? OR email=? OR username=?', id, id, id);
  if (!u) throw bad('No account found with this email or mobile number.');
  const pp = auth.passwordProblem(body.password); if (pp) throw bad(pp);
  if (RESET_METHOD === 'otp') {
    const o = u ? sms.checkOtp(u.mobile, body.code) : { ok: false, error: 'Incorrect or expired OTP.' };
    if (!o.ok) throw bad(o.error);
  }
  const hash = await auth.hashPassword(body.password);
  db.tx(() => {
    db.run('UPDATE users SET pass_hash=?, must_change=0 WHERE id=?', hash, u.id);
    db.run('DELETE FROM sessions WHERE user_id=?', u.id);
    db.run("UPDATE reset_requests SET status='Done', resolved_at=? WHERE user_id=? AND status='Open'", now(), u.id);
    audit(u.id, 'password_reset', 'without verification');
  });
  if (u.role === 'admin') {
    try { fs.unlinkSync(path.join(DATA_DIR, 'FIRST-RUN-ADMIN-PASSWORD.txt')); } catch {}
  }
  return { ok: true, message: 'Password reset successfully.' };
});

route('GET', '/api/state', { auth: 'user' }, ({ user }) => stateFor(user));
route('GET', '/api/session', {}, ({ user }) => (user ? { authenticated: true, ...stateFor(user) } : { authenticated: false })); // lets the page ask "am I logged in?" without a 401

route('POST', '/api/profile', { auth: 'user' }, async ({ req, body, user }) => {
  if (user.role === 'admin') throw new HttpError(403, 'The administrator profile cannot be changed here.');
  const name = person(body.name, 'Name', 3), email = String(body.email || '').trim().toLowerCase(), mobile = String(body.mobile || user.mobile);
  const username = String(body.username || '').trim(), state = body.state;
  if (!okEmail(email)) throw bad('Enter a valid email.');
  if (!okMobile(mobile)) throw bad('Enter a valid 10-digit mobile number.');
  if (!STATES.includes(state)) throw bad('Select your state.');
  if (username && !/^[A-Za-z][A-Za-z0-9_.]{2,29}$/.test(username)) throw bad('Username: 3–30 characters, start with a letter; letters, numbers, dot or underscore only.');
  const sensitive = mobile !== user.mobile || email !== user.email || !!body.password;
  if (sensitive && !(await auth.verifyPassword(String(body.current || ''), user.pass_hash))) throw bad('Enter your current password to change your mobile number, email or password.');
  const verified = mobile !== user.mobile ? 0 : user.mobile_verified;
  let hash = null; if (body.password) { const pp = auth.passwordProblem(body.password); if (pp) throw bad(pp); hash = await auth.hashPassword(body.password); }
  db.tx(() => {
    if (db.get('SELECT 1 x FROM users WHERE id<>? AND (mobile=? OR email=? OR (username IS NOT NULL AND username=?))', user.id, mobile, email, username || null)) throw new HttpError(409, 'Mobile, email or username already in use.');
    db.run('UPDATE users SET name=?,email=?,mobile=?,state=?,username=?,mobile_verified=?,pass_hash=COALESCE(?,pass_hash) WHERE id=?', name, email, mobile, state, username || null, verified, hash, user.id);
    if (hash) db.run('DELETE FROM sessions WHERE user_id=? AND token<>?', user.id, auth.tokenHash(sessionToken(req)));
  });
  return { ok: true };
});

route('POST', '/api/password/change', { auth: 'user' }, async ({ req, body, user }) => {
  if (!(await auth.verifyPassword(String(body.current || ''), user.pass_hash))) throw bad('Current password is incorrect.');
  if (String(body.password) === String(body.current)) throw bad('Choose a different password from your current one.');
  const pp = auth.passwordProblem(body.password); if (pp) throw bad(pp);
  const hash = await auth.hashPassword(body.password), keep = auth.tokenHash(sessionToken(req));
  db.tx(() => { db.run('UPDATE users SET pass_hash=?, must_change=0 WHERE id=?', hash, user.id); db.run('DELETE FROM sessions WHERE user_id=? AND token<>?', user.id, keep); audit(user.id, 'password_change', ''); });
  if (user.role === 'admin') { try { fs.unlinkSync(path.join(DATA_DIR, 'FIRST-RUN-ADMIN-PASSWORD.txt')); } catch {} }
  return { ok: true };
});

/* ---- wallet recharge (manual UPI + UTR + admin approval) ---- */
route('POST', '/api/payments', { auth: 'user' }, ({ body, user }) => {
  retailerOnly(user);
  const amount = body.amount;
  if (!Number.isInteger(amount) || amount < MIN_RECHARGE || amount > MAX_RECHARGE) throw bad(`Enter a whole-rupee amount between ₹${MIN_RECHARGE} and ₹${MAX_RECHARGE}.`);
  if (db.get("SELECT COUNT(*) c FROM payments WHERE user_id=? AND status='Pending'", user.id).c >= 5) throw new HttpError(429, 'You have too many unfinished payments. Complete or cancel them first.');
  return db.tx(() => { const id = nextId('payments', 'PAY', 1001); db.run('INSERT INTO payments(id,user_id,amount,status,created_at) VALUES(?,?,?,?,?)', id, user.id, amount, 'Pending', now()); return { id }; });
});
const myPayment = (id, user) => { const p = db.get('SELECT * FROM payments WHERE id=? AND user_id=?', id, user.id); if (!p) throw new HttpError(404, 'Payment not found.'); return p; };
route('POST', '/api/payments/:id/utr', { auth: 'user' }, ({ params, body, user }) => {
  retailerOnly(user);
  const utr = String(body.utr || '').trim();
  if (!/^\d{12}$/.test(utr)) throw bad('Enter the 12-digit UTR from your payment app.');
  db.tx(() => {
    const p = myPayment(params.id, user);
    if (p.status !== 'Pending') throw bad('This payment can no longer be changed.');
    if (db.get('SELECT 1 x FROM payments WHERE utr=?', utr)) throw bad('This UTR was already submitted.');
    db.run("UPDATE payments SET status='Verifying', utr=?, submitted_at=? WHERE id=?", utr, now(), p.id);
    addNotif(user.id, `Payment ${p.id} of ₹${p.amount} submitted. Your wallet will be credited after verification.`);
  });
  return { ok: true };
});
route('POST', '/api/payments/:id/cancel', { auth: 'user' }, ({ params, user }) => {
  retailerOnly(user);
  db.tx(() => { const p = myPayment(params.id, user); if (p.status === 'Pending') db.run("UPDATE payments SET status='Cancelled', decided_at=? WHERE id=?", now(), p.id); });
  return { ok: true };
});
route('POST', '/api/admin/payments/:id/decide', { auth: 'admin' }, ({ params, body, user }) => {
  const approve = body.approve === true;
  const p = db.tx(() => {
    const p = db.get('SELECT * FROM payments WHERE id=?', params.id);
    if (!p) throw new HttpError(404, 'Payment not found.');
    if (p.status !== 'Verifying') throw bad('Only payments awaiting verification can be decided.');
    if (approve) {
      credit(p.user_id, 'main', p.amount); addTx(p.user_id, 'main', p.amount, `Wallet recharge via UPI (${p.id}, UTR ${p.utr})`);
      addNotif(p.user_id, `₹${p.amount} added to your wallet.`);
      const ru = db.get('SELECT name, ref_by, ref_paid FROM users WHERE id=?', p.user_id);
      if (ru && ru.ref_by && !ru.ref_paid && db.get("SELECT 1 x FROM users WHERE id=? AND role='retailer' AND disabled=0", ru.ref_by)) {
        credit(ru.ref_by, 'earn', 10); addTx(ru.ref_by, 'earn', 10, 'Referral bonus – ' + ru.name, true);
        addNotif(ru.ref_by, `${ru.name} made their first recharge. ₹10 added to your Earnings wallet.`);
        db.run('UPDATE users SET ref_paid=1 WHERE id=?', p.user_id);
      }
    } else addNotif(p.user_id, `Payment ${p.id} could not be verified. Please contact support.`);
    db.run('UPDATE payments SET status=?, decided_at=? WHERE id=?', approve ? 'Success' : 'Rejected', now(), p.id);
    audit(user.id, approve ? 'payment_approved' : 'payment_rejected', `${p.id} ${p.user_id} ${p.amount} UTR ${p.utr}`);
    return p;
  });
  smsUser(p.user_id, 'PAY', approve ? `Shri Sai Seva One: ${inr(p.amount)} added to your wallet. Ref ${p.utr}.` : `Shri Sai Seva One: Payment ${p.id} could not be verified. Contact support ${ADMIN_MOBILE}.`);
  return { ok: true };
});
route('POST', '/api/admin/users/:id/funds', { auth: 'admin' }, ({ params, body, user }) => {
  const amount = body.amount;
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) throw bad('Enter a whole-rupee amount between ₹1 and ₹1,00,000.');
  const note = str(body.note, 3, 100, 'Reason');
  db.tx(() => {
    const u = db.get("SELECT * FROM users WHERE id=? AND role='retailer'", params.id); if (!u) throw new HttpError(404, 'Retailer not found.');
    credit(u.id, 'main', amount); addTx(u.id, 'main', amount, 'Funds added by admin: ' + note); addNotif(u.id, `₹${amount} added to your wallet by admin.`);
    audit(user.id, 'funds_added', `${u.id} ${u.name} ₹${amount} – ${note}`);
  });
  return { ok: true };
});
route('POST', '/api/wallet/move', { auth: 'user' }, ({ user }) => {
  retailerOnly(user);
  return db.tx(() => {
    const u = db.get('SELECT earn FROM users WHERE id=?', user.id), e = u.earn;
    if (!(e > 0)) throw bad('No earnings to move yet.');
    if (!debit(user.id, 'earn', e)) throw bad('No earnings to move yet.');
    credit(user.id, 'main', e); addTx(user.id, 'earn', -e, 'Moved to main wallet'); addTx(user.id, 'main', e, 'From earnings wallet');
    return { moved: e };
  });
});

/* ---- applications ---- */
route('POST', '/api/applications', { auth: 'user' }, ({ body, user }) => {
  retailerOnly(user);
  const s = SV.find(x => x[0] === body.cat && x[1] === body.svc);
  if (!s) throw bad('Unknown service.');
  const cname = person(body.name, 'Customer name'), cmobile = String(body.mobile || ''), aadhaar = String(body.aadhaar || '').trim(), note = String(body.note || '').trim().slice(0, 120);
  if (/[<>\u0000-\u001f]/.test(note)) throw bad('Remarks contain characters that are not allowed.');
  if (!okMobile(cmobile)) throw bad('Enter a valid 10-digit customer mobile number.');
  if (aadhaar && !/^\d{4}$/.test(aadhaar)) throw bad('Aadhaar digits must be exactly 4 numbers.');
  const fee = s[2], comm = Math.round(fee * 0.1);
  const id = db.tx(() => {
    if (!debit(user.id, 'main', fee)) throw new HttpError(402, 'Insufficient wallet balance.', 'LOW_BALANCE');
    const id = nextId('apps', 'SSS-', 100001);
    db.run('INSERT INTO apps(id,owner,cat,svc,fee,comm,cname,cmobile,note,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, user.id, s[0], s[1], fee, comm, cname, cmobile, note, 'Received', now());
    addTx(user.id, 'main', -fee, `Applied: ${s[1]} (${id})`); addNotif(user.id, `Application ${id} submitted for ${s[1]}.`);
    return id;
  });
  smsUser(user.id, 'APP', `Shri Sai Seva One: Application ${id} for ${s[1]} received. Fee ${inr(fee)} debited.`);
  return { id };
});
route('POST', '/api/admin/applications/:id/status', { auth: 'admin' }, ({ params, body, user }) => {
  const to = body.status;
  if (!STATUSES.includes(to)) throw bad('Invalid status.');
  const a = db.tx(() => {
    const a = db.get('SELECT * FROM apps WHERE id=?', params.id); if (!a) throw new HttpError(404, 'Application not found.');
    if (a.status === 'Completed' || a.status === 'Rejected') throw bad('This application is already closed.');
    if (to === a.status) return null;
    if (to === 'Received') throw bad('An application cannot go back to Received.');
    if (to === 'Completed' && !a.comm_paid) {
      credit(a.owner, 'earn', a.comm); addTx(a.owner, 'earn', a.comm, `Commission – ${a.id}`); addNotif(a.owner, `${a.id} completed. ₹${a.comm} commission added.`);
      db.run('UPDATE apps SET comm_paid=1 WHERE id=?', a.id);
    } else if (to === 'Rejected' && !a.refunded) {
      credit(a.owner, 'main', a.fee); addTx(a.owner, 'main', a.fee, `Refund – ${a.id}`); addNotif(a.owner, `${a.id} was rejected. ₹${a.fee} refunded.`);
      db.run('UPDATE apps SET refunded=1 WHERE id=?', a.id);
    } else addNotif(a.owner, `${a.id} is now ${to}.`);
    db.run('UPDATE apps SET status=? WHERE id=?', to, a.id);
    audit(user.id, 'application_status', `${a.id} ${a.status}->${to}`);
    return a;
  });
  if (a) smsUser(a.owner, 'STATUS', `Shri Sai Seva One: Application ${a.id} is now ${to}.`);
  return { ok: true };
});

/* ---- agents, tickets, notifications, announcement, SMS test ---- */
route('POST', '/api/agents', { auth: 'user' }, ({ body, user }) => {
  retailerOnly(user);
  const name = person(body.name, 'Agent name'), mobile = String(body.mobile || '');
  if (!okMobile(mobile)) throw bad('Enter a valid 10-digit mobile number.');
  if (db.get('SELECT COUNT(*) c FROM agents WHERE uid=?', user.id).c >= 20) throw bad('You can add up to 20 agents.');
  db.run('INSERT INTO agents(uid,name,mobile) VALUES(?,?,?)', user.id, name, mobile); return { ok: true };
});
route('POST', '/api/agents/delete', { auth: 'user' }, ({ body, user }) => { db.run('DELETE FROM agents WHERE id=? AND uid=?', Number(body.id) || 0, user.id); return { ok: true }; });
route('POST', '/api/tickets', { auth: 'user' }, ({ body, user }) => {
  retailerOnly(user);
  if (!TOPICS.includes(body.topic)) throw bad('Choose a topic.');
  const msg = str(body.msg, 5, 300, 'Message');
  if (db.get("SELECT COUNT(*) c FROM tickets WHERE uid=? AND status='Open'", user.id).c >= 10) throw new HttpError(429, 'You already have many open tickets. Please wait for a reply.');
  db.tx(() => db.run('INSERT INTO tickets(id,uid,topic,msg,status,created_at) VALUES(?,?,?,?,?,?)', nextId('tickets', 'TK', 1001), user.id, body.topic, msg, 'Open', now()));
  return { ok: true };
});
route('POST', '/api/admin/tickets/:id/resolve', { auth: 'admin' }, ({ params, user }) => {
  db.tx(() => {
    const t = db.get('SELECT * FROM tickets WHERE id=?', params.id); if (!t) throw new HttpError(404, 'Ticket not found.');
    if (t.status === 'Open') { db.run("UPDATE tickets SET status='Resolved' WHERE id=?", t.id); addNotif(t.uid, `Support ticket ${t.id} has been resolved.`); audit(user.id, 'ticket_resolved', t.id); }
  });
  return { ok: true };
});
route('POST', '/api/notifications/read', { auth: 'user' }, ({ user }) => { db.run('UPDATE notifs SET is_read=1 WHERE uid=?', user.id); return { ok: true }; });
route('POST', '/api/admin/announcement', { auth: 'admin' }, ({ body, user }) => {
  const t = String(body.text || '').trim(); if (t.length < 1 || t.length > 200) throw bad('Announcement must be 1–200 characters.');
  putSetting('announcement', t); audit(user.id, 'announcement', t.slice(0, 60)); return { ok: true };
});
route('POST', '/api/admin/sms/test', { auth: 'admin' }, async ({ body }) => {
  if (!okMobile(body.mobile)) throw bad('Enter a valid 10-digit mobile number.');
  await sms.notify(db, { mobile: String(body.mobile), mobile_verified: 1 }, 'TEST', 'Shri Sai Seva One: test message. Your SMS gateway is working.', true);
  return { ok: true };
});

/* ---- admin: password reset requests (admin-assisted reset, no SMS needed) ---- */
route('POST', '/api/admin/resets/:id/issue', { auth: 'admin' }, async ({ params, user }) => {
  const pw = auth.randomPassword(), hash = await auth.hashPassword(pw);
  const who = db.tx(() => {
    const q = db.get('SELECT * FROM reset_requests WHERE id=?', params.id);
    if (!q) throw new HttpError(404, 'Request not found.');
    if (q.status !== 'Open') throw bad('This request is already closed.');
    const u = db.get("SELECT * FROM users WHERE id=? AND role='retailer'", q.user_id);
    if (!u) throw new HttpError(404, 'Retailer not found.');
    db.run('UPDATE users SET pass_hash=?, must_change=1 WHERE id=?', hash, u.id); db.run('DELETE FROM sessions WHERE user_id=?', u.id);
    db.run("UPDATE reset_requests SET status='Done', resolved_at=?, resolved_by=? WHERE id=?", now(), user.id, q.id);
    audit(user.id, 'password_reset_issued', `${u.id} ${u.name}`);
    return { name: u.name, mobile: u.mobile };
  });
  return { ok: true, password: pw, ...who };            // shown to the admin once; the retailer must replace it at first login
});
route('POST', '/api/admin/resets/:id/dismiss', { auth: 'admin' }, ({ params, user }) => {
  db.tx(() => {
    const q = db.get('SELECT * FROM reset_requests WHERE id=?', params.id);
    if (!q) throw new HttpError(404, 'Request not found.');
    if (q.status === 'Open') { db.run("UPDATE reset_requests SET status='Dismissed', resolved_at=?, resolved_by=? WHERE id=?", now(), user.id, q.id); audit(user.id, 'password_reset_dismissed', q.user_id); }
  });
  return { ok: true };
});

/* ---- admin: disable/enable retailers, reports, CSV exports ---- */
route('POST', '/api/admin/users/:id/status', { auth: 'admin' }, ({ params, body, user }) => {
  const disabled = body.disabled === true ? 1 : 0, reason = body.reason ? str(body.reason, 3, 100, 'Reason') : '';
  if (disabled && !reason) throw bad('Please enter a reason.');
  db.tx(() => {
    const u = db.get("SELECT * FROM users WHERE id=? AND role='retailer'", params.id);
    if (!u) throw new HttpError(404, 'Retailer not found.');
    db.run('UPDATE users SET disabled=? WHERE id=?', disabled, u.id);
    if (disabled) db.run('DELETE FROM sessions WHERE user_id=?', u.id);
    audit(user.id, disabled ? 'user_disabled' : 'user_enabled', `${u.id} ${u.name}${reason ? ' – ' + reason : ''}`);
  });
  return { ok: true };
});

function dateRange(url) {
  const IST = 5.5 * HOUR, today = new Date(Date.now() + IST).toISOString().slice(0, 10), def = new Date(Date.now() + IST - 29 * DAY).toISOString().slice(0, 10);
  const from = url.searchParams.get('from') || def, to = url.searchParams.get('to') || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw bad('Invalid date.');
  const t0 = Date.parse(from + 'T00:00:00+05:30'), t1 = Date.parse(to + 'T23:59:59.999+05:30');
  if (!(t0 <= t1) || t1 - t0 > 366 * DAY) throw bad('Choose a valid date range of up to 366 days.');
  return { from, to, t0, t1 };
}
route('GET', '/api/admin/reports', { auth: 'admin' }, ({ url }) => {
  const { from, to, t0, t1 } = dateRange(url), one = (sql, ...p) => db.get(sql, ...p);
  const rech = one("SELECT COALESCE(SUM(amount),0) a, COUNT(*) c FROM payments WHERE status='Success' AND decided_at BETWEEN ? AND ?", t0, t1);
  const byStatus = {}; let revenue = 0, refunds = 0;
  for (const r of db.all('SELECT status, COUNT(*) c, COALESCE(SUM(fee),0) fee FROM apps WHERE created_at BETWEEN ? AND ? GROUP BY status', t0, t1)) { byStatus[r.status] = r.c; if (r.status === 'Rejected') refunds += r.fee; else revenue += r.fee; }
  const comm = one("SELECT COALESCE(SUM(amount),0) a FROM tx WHERE wallet='earn' AND descr LIKE 'Commission%' AND created_at BETWEEN ? AND ?", t0, t1).a;
  const refBonus = one('SELECT COALESCE(SUM(amount),0) a FROM tx WHERE ref=1 AND created_at BETWEEN ? AND ?', t0, t1).a;
  const day = c => `strftime('%Y-%m-%d', ${c}/1000 + 19800, 'unixepoch')`;
  const dr = Object.fromEntries(db.all(`SELECT ${day('decided_at')} d, SUM(amount) a FROM payments WHERE status='Success' AND decided_at BETWEEN ? AND ? GROUP BY d`, t0, t1).map(r => [r.d, r.a]));
  const dv = Object.fromEntries(db.all(`SELECT ${day('created_at')} d, SUM(fee) a FROM apps WHERE status<>'Rejected' AND created_at BETWEEN ? AND ? GROUP BY d`, t0, t1).map(r => [r.d, r.a]));
  const daily = []; for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += DAY) { const d = new Date(t).toISOString().slice(0, 10); daily.push({ d, recharge: dr[d] || 0, revenue: dv[d] || 0 }); }
  const lb = one("SELECT COALESCE(SUM(wallet),0) w, COALESCE(SUM(earn),0) e, COUNT(*) n, COALESCE(SUM(disabled),0) dis FROM users WHERE role='retailer'");
  return {
    from, to, recharges: { amount: rech.a, count: rech.c }, revenue, refunds, commission: comm, referralBonus: refBonus,
    newRetailers: one("SELECT COUNT(*) c FROM users WHERE role='retailer' AND created_at BETWEEN ? AND ?", t0, t1).c,
    appsByStatus: byStatus, appsTotal: Object.values(byStatus).reduce((a, b) => a + b, 0),
    topServices: db.all("SELECT svc name, COUNT(*) count, SUM(fee) fee FROM apps WHERE status<>'Rejected' AND created_at BETWEEN ? AND ? GROUP BY svc ORDER BY fee DESC, count DESC LIMIT 10", t0, t1),
    topRetailers: db.all("SELECT u.name, COUNT(*) count, SUM(a.fee) fee FROM apps a JOIN users u ON u.id = a.owner WHERE a.status<>'Rejected' AND a.created_at BETWEEN ? AND ? GROUP BY a.owner ORDER BY fee DESC LIMIT 10", t0, t1),
    daily, liabilities: { wallets: lb.w, earnings: lb.e, retailers: lb.n, disabled: lb.dis },
    waiting: { payments: one("SELECT COUNT(*) c FROM payments WHERE status='Verifying'").c, applications: one("SELECT COUNT(*) c FROM apps WHERE status IN ('Received','In process')").c, tickets: one("SELECT COUNT(*) c FROM tickets WHERE status='Open'").c }
  };
});
const csvCell = v => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }; // also blocks spreadsheet formula injection
const csv = (cols, rows) => '\uFEFF' + [cols.map(c => c[0]).join(','), ...rows.map(r => cols.map(c => csvCell(typeof c[1] === 'function' ? c[1](r) : r[c[1]])).join(','))].join('\r\n') + '\r\n';
route('GET', '/api/admin/export/:kind', { auth: 'admin' }, ({ params, url, user }) => {
  const kind = params.kind.replace(/\.csv$/, ''), { from, to, t0, t1 } = dateRange(url), names = {};
  const nm = id => names[id] ?? (names[id] = (db.get('SELECT name FROM users WHERE id=?', id) || {}).name || id);
  let cols, rows;
  if (kind === 'applications') { rows = db.all('SELECT * FROM apps WHERE created_at BETWEEN ? AND ? ORDER BY created_at', t0, t1); cols = [['Application ID', 'id'], ['Date', r => fmt(r.created_at)], ['Retailer', r => nm(r.owner)], ['Category', 'cat'], ['Service', 'svc'], ['Fee (INR)', 'fee'], ['Commission (INR)', 'comm'], ['Customer', 'cname'], ['Customer mobile', 'cmobile'], ['Status', 'status'], ['Remarks', 'note']]; }
  else if (kind === 'payments') { rows = db.all('SELECT * FROM payments WHERE created_at BETWEEN ? AND ? ORDER BY created_at', t0, t1); cols = [['Payment ID', 'id'], ['Date', r => fmt(r.created_at)], ['Retailer', r => nm(r.user_id)], ['Amount (INR)', 'amount'], ['Status', 'status'], ['UTR', 'utr'], ['UTR submitted', r => fmt(r.submitted_at)], ['Decided', r => fmt(r.decided_at)]]; }
  else if (kind === 'transactions') { rows = db.all('SELECT * FROM tx WHERE created_at BETWEEN ? AND ? ORDER BY id', t0, t1); cols = [['Tx ID', r => 'TX' + (1000 + r.id)], ['Date', r => fmt(r.created_at)], ['Retailer', r => nm(r.uid)], ['Wallet', 'wallet'], ['Amount (INR)', 'amount'], ['Description', 'descr']]; }
  else if (kind === 'retailers') { rows = db.all("SELECT * FROM users WHERE role='retailer' ORDER BY created_at"); cols = [['Name', 'name'], ['Mobile', 'mobile'], ['Email', 'email'], ['State', 'state'], ['Main wallet (INR)', 'wallet'], ['Earnings wallet (INR)', 'earn'], ['Disabled', r => (r.disabled ? 'Yes' : 'No')], ['Joined', r => fmt(r.created_at)]]; }
  else if (kind === 'audit') { rows = db.all('SELECT * FROM audit ORDER BY id DESC LIMIT 5000'); cols = [['Date', r => fmt(r.created_at)], ['Who', r => (r.actor === 'admin' ? 'Administrator' : nm(r.actor))], ['Action', 'action'], ['Details', 'detail']]; }
  else throw new HttpError(404, 'Unknown export.');
  audit(user.id, 'export', `${kind} ${from}..${to}`);
  return { __raw: { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="seva-${kind}-${from}_to_${to}.csv"`, 'Cache-Control': 'no-store' }, body: csv(cols, rows) } };
});

/* ---------------- HTTP plumbing ---------------- */
const SECURITY = isTest ? {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
} : {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors *; base-uri 'none'; form-action 'self'"
};
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 16384) { no(new HttpError(413, 'Request too large')); req.destroy(); } });
  req.on('end', () => { try { const o = JSON.parse(b || '{}'); ok(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); } catch { no(bad('Bad request')); } });
  req.on('error', no);
});
const sameOrigin = req => {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const orig = new URL(o).host;
    const reqHost = req.headers['x-forwarded-host'] || req.headers.host;
    return orig === reqHost || orig === req.headers.host;
  } catch { return false; }
};

async function handleApi(req, res, p) {
  const url = new URL(req.url, 'http://x');
  let match = null, pathHit = false;
  for (const r of routes) { const m = r.re.exec(p); if (m) { pathHit = true; if (r.method === req.method) { match = { r, params: { ...m.groups } }; break; } } }
  if (!match) return json(res, pathHit ? 405 : 404, { error: pathHit ? 'Method not allowed' : 'Not found' });
  const { r, params } = match;
  let body = {};
  if (req.method === 'POST') {
    if (!sameOrigin(req)) throw new HttpError(403, 'Cross-site request blocked.');
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON required.');
    body = await readBody(req);
  }
  const user = getUser(req);
  if (r.opt.auth && !user) throw new HttpError(401, 'Please login.');
  if (user && user.must_change && !['/api/state', '/api/session', '/api/config', '/api/password/change', '/api/logout', '/api/health'].includes(p)) throw new HttpError(403, 'Please set a new password first.', 'MUST_CHANGE');
  if (r.opt.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admin only.');
  const out = await r.h({ req, res, body, user, params, url, ip: clientIp(req) });
  if (out && out.__raw) { res.writeHead(out.__raw.status, { ...out.__raw.headers, ...SECURITY }); return res.end(out.__raw.body); }
  return json(res, 200, out);
}

const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
  let rel; try { rel = decodeURIComponent(p === '/' ? '/index.html' : p); } catch { return json(res, 404, { error: 'Not found' }); }
  const file = path.normalize(path.join(PUB, rel)), ext = path.extname(file).toLowerCase();
  if (!file.startsWith(PUB + path.sep) || !MIME[ext] || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=86400', ...SECURITY });
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (secureReq(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    if (p.startsWith('/api/')) await handleApi(req, res, p); else serveStatic(req, res, p);
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, code: e.code });
    console.error('[error]', e); if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 60;
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));

async function start() {
  await bootstrapAdmin();
  if (REQUIRE_OTP && sms.PROVIDER === 'console' && !/^(127\.0\.0\.1|localhost|::1)$/.test(BIND_HOST)) console.warn('WARNING: SMS_PROVIDER=console prints OTP codes in this window. Do not use it on a public server – set a real SMS provider.');
  return new Promise(ok => server.listen(PORT, BIND_HOST, () => {
    console.log(`Shri Sai Seva One running at http://localhost:${server.address().port}  (SMS provider: ${sms.PROVIDER}, OTP required: ${REQUIRE_OTP})`);
    ok(server);
  }));
}
module.exports = { server, start, db };
if (require.main === module) start().catch(e => { console.error(e); process.exit(1); });
