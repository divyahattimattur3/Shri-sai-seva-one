'use strict';
const crypto = require('crypto');
const E = process.env;
const PROVIDER = (E.SMS_PROVIDER || 'console').toLowerCase();
const BRAND = E.SMS_BRAND || 'Shri Sai Seva One';
const DAILY_CAP = Number(E.SMS_DAILY_CAP) || 300;
const FAST2SMS_URL = E.FAST2SMS_URL || 'https://www.fast2sms.com/dev/bulkV2';
const HOUR = 3600e3, OTP_TTL = 5 * 60e3;
const SALT = crypto.randomBytes(16).toString('hex');

/* ---- tiny in-memory rate limiter ---- */
const hits = new Map();
const SCALE = Number(E.RATE_LIMIT_SCALE) || 1; // >1 relaxes per-IP limits (tests / shared office networks)
function limited(key, max, win) {
  if (/^(oi|rg|li|fi|fr):/.test(key)) max *= SCALE;
  const now = Date.now(), l = (hits.get(key) || []).filter(t => now - t < win);
  if (l.length >= max) { hits.set(key, l); return true; }
  l.push(now); hits.set(key, l); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of hits) if (!l.some(t => now - t < 24 * HOUR)) hits.delete(k); }, HOUR).unref();
let day = { d: '', n: 0 };
function capReached() { const d = new Date().toISOString().slice(0, 10); if (day.d !== d) day = { d, n: 0 }; return day.n >= DAILY_CAP; }

/* ---- providers ---- */
const providers = {
  async console({ to, text, kind }) { console.log(`\n[SMS ${kind}] to ${to}: ${text}\n`); return true; },
  async fast2sms({ to, text, kind, otp }) {
    const b = { numbers: to };
    if (kind === 'otp') {
      const r = (E.FAST2SMS_OTP_ROUTE || 'otp').toLowerCase();
      if (r === 'otp') Object.assign(b, { route: 'otp', variables_values: otp });
      else if (r === 'dlt') Object.assign(b, { route: 'dlt', sender_id: E.FAST2SMS_SENDER_ID, message: E.FAST2SMS_OTP_TEMPLATE_ID, variables_values: otp });
      else Object.assign(b, { route: 'q', message: text, flash: 0 });
    } else if ((E.FAST2SMS_NOTIFY_ROUTE || 'q').toLowerCase() === 'dlt') {
      Object.assign(b, { route: 'dlt', sender_id: E.FAST2SMS_SENDER_ID, message: E.FAST2SMS_NOTIFY_TEMPLATE_ID, variables_values: text.replace(/\|/g, ' ') });
    } else Object.assign(b, { route: 'q', message: text, flash: 0 });
    const r = await fetch(FAST2SMS_URL, { method: 'POST', headers: { authorization: E.FAST2SMS_API_KEY || '', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const j = await r.json().catch(() => ({}));
    const ok = r.ok && j.return === true;
    if (!ok) console.error('[Fast2SMS] rejected:', r.status, JSON.stringify(j));
    return ok;
  },
  async twilio({ to, text }) {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${E.TWILIO_SID}/Messages.json`, { method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${E.TWILIO_SID}:${E.TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: '+91' + to, From: E.TWILIO_FROM, Body: text }) });
    return r.ok;
  }
};
if (!providers[PROVIDER]) { console.error('Unknown SMS_PROVIDER: ' + PROVIDER); process.exit(1); }
if (PROVIDER === 'fast2sms' && !E.FAST2SMS_API_KEY) console.warn('WARNING: SMS_PROVIDER=fast2sms but FAST2SMS_API_KEY is empty in .env');
async function deliver(msg) { day.n++; try { return await providers[PROVIDER](msg); } catch (e) { console.error('[SMS] provider error:', e.message); return false; } }

/* ---- OTPs (kept only on the server, hashed) ---- */
const otps = new Map();
const hash = (m, c) => crypto.createHash('sha256').update(SALT + m + c).digest('hex');
async function sendOtp(mobile, ip) {
  const cur = otps.get(mobile);
  if (cur && Date.now() - cur.sentAt < 60e3) return { ok: false, status: 429, error: 'Please wait a minute before requesting another OTP.' };
  if (limited('om:' + mobile, 3, HOUR) || limited('oi:' + ip, 10, HOUR)) return { ok: false, status: 429, error: 'Too many OTP requests. Try again later.' };
  if (capReached()) return { ok: false, status: 503, error: 'Daily SMS limit reached.' };
  const otp = String(crypto.randomInt(100000, 1000000));
  otps.set(mobile, { hash: hash(mobile, otp), exp: Date.now() + OTP_TTL, tries: 0, sentAt: Date.now() });
  const sent = await deliver({ to: mobile, kind: 'otp', otp, text: `Your ${BRAND} OTP is ${otp}. Valid for 5 minutes. Do not share it with anyone.` });
  if (!sent) { otps.delete(mobile); return { ok: false, status: 502, error: 'Could not send the SMS. Please try again.' }; }
  return { ok: true };
}
/** Consumes the OTP on success. */
function checkOtp(mobile, code) {
  const o = otps.get(mobile); code = String(code || '');
  if (!o || Date.now() > o.exp) { otps.delete(mobile); return { ok: false, error: 'OTP expired. Request a new one.' }; }
  if (++o.tries > 5) { otps.delete(mobile); return { ok: false, error: 'Too many attempts. Request a new OTP.' }; }
  if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(Buffer.from(hash(mobile, code)), Buffer.from(o.hash))) return { ok: false, error: 'Incorrect OTP.' };
  otps.delete(mobile); return { ok: true };
}

/** Alert SMS to a user; logged in sms_log. Never throws. */
async function notify(db, user, type, text, force) {
  const id = db.run('INSERT INTO sms_log(to_mobile,type,text,status,created_at) VALUES(?,?,?,?,?)', user.mobile, type, text, 'Sending…', Date.now()).lastInsertRowid;
  const set = s => { try { db.run('UPDATE sms_log SET status=? WHERE id=?', s, id); } catch {} };
  if (!user.mobile_verified && !force) return set('Skipped – number not OTP-verified');
  if (limited('nm:' + user.mobile, 10, 24 * HOUR)) return set('Skipped – daily limit for this number');
  if (capReached()) return set('Skipped – daily SMS cap');
  const ok = await deliver({ to: user.mobile, kind: 'notify', text });
  set(PROVIDER === 'console' ? 'Demo – printed in server window' : ok ? 'Sent' : 'Failed');
}
module.exports = { PROVIDER, sendOtp, checkOtp, notify, limited };
