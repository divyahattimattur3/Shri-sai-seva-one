'use strict';
// Saves a consistent copy of the database to data/backups/ (keeps the newest 30). Safe to run while the site is running.
require('../lib/env');
const path = require('path'), fs = require('fs');
const { open } = require('../lib/db');
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = open(dir), dest = path.join(dir, 'backups');
fs.mkdirSync(dest, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14), file = path.join(dest, `seva-${stamp}.db`);
db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log('Backup saved: ' + file);
const all = fs.readdirSync(dest).filter(f => /^seva-\d+\.db$/.test(f)).sort();
while (all.length > 30) fs.unlinkSync(path.join(dest, all.shift()));
