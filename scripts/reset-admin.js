'use strict';
// Forgot the admin password?  node scripts/reset-admin.js   (prints a new random password; or pass your own as an argument)
require('../lib/env');
const path = require('path');
const { open } = require('../lib/db'), auth = require('../lib/auth');
(async () => {
  const db = open(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const admin = db.get("SELECT id, email FROM users WHERE role='admin'");
  if (!admin) { console.log('No admin account yet. Start the site once (start.bat) and it will be created.'); return; }
  const pw = process.argv[2] || auth.randomPassword(), p = auth.passwordProblem(pw);
  if (p) { console.log(p); process.exitCode = 1; return; }
  db.run('UPDATE users SET pass_hash=? WHERE id=?', await auth.hashPassword(pw), admin.id);
  db.run('DELETE FROM sessions WHERE user_id=?', admin.id);
  console.log(`\nAdmin password reset.\n  Email:    ${admin.email}\n  Password: ${pw}\n\nLog in and change it from "Change Password".\n`);
})();
