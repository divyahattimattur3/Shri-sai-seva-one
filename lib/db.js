'use strict';
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mobile TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  state TEXT, username TEXT UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'retailer',
  wallet INTEGER NOT NULL DEFAULT 0 CHECK(wallet >= 0), earn INTEGER NOT NULL DEFAULT 0 CHECK(earn >= 0),
  code TEXT UNIQUE, ref_by TEXT, mobile_verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
  status TEXT NOT NULL, utr TEXT UNIQUE, created_at INTEGER NOT NULL, submitted_at INTEGER, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS tx(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, wallet TEXT NOT NULL, amount INTEGER NOT NULL,
  descr TEXT NOT NULL, ref INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY, owner TEXT NOT NULL, cat TEXT, svc TEXT, fee INTEGER, comm INTEGER,
  cname TEXT, cmobile TEXT, note TEXT, status TEXT NOT NULL, comm_paid INTEGER NOT NULL DEFAULT 0,
  refunded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, msg TEXT NOT NULL,
  created_at INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agents(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, name TEXT NOT NULL, mobile TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, uid TEXT NOT NULL, topic TEXT, msg TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sms_log(id INTEGER PRIMARY KEY AUTOINCREMENT, to_mobile TEXT, type TEXT, text TEXT, status TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reset_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, detail TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS i_tx_uid ON tx(uid);
CREATE INDEX IF NOT EXISTS i_apps_owner ON apps(owner);
CREATE INDEX IF NOT EXISTS i_pay_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS i_notif_uid ON notifs(uid);
CREATE INDEX IF NOT EXISTS i_sess_exp ON sessions(expires_at);
`;

function open(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'seva.db');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  raw.exec(SCHEMA);
  for (const [t, c, def] of [['users', 'disabled', 'INTEGER NOT NULL DEFAULT 0'], ['users', 'ref_paid', 'INTEGER NOT NULL DEFAULT 0'], ['users', 'must_change', 'INTEGER NOT NULL DEFAULT 0']]) // upgrade older databases
    if (!raw.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) raw.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  const q = sql => raw.prepare(sql);
  return {
    raw, file,
    get: (sql, ...p) => q(sql).get(...p),
    all: (sql, ...p) => q(sql).all(...p),
    run: (sql, ...p) => q(sql).run(...p),
    /** Run fn atomically. Any throw rolls everything back. */
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = fn(); raw.exec('COMMIT'); return r; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch {} throw e; }
    }
  };
}
module.exports = { open };
