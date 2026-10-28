# Security review — Shri Sai Service Seva One (Build 7)

> **Honest scope:** this is a *self-review* by the developer (the AI that wrote the code), not an independent audit.
> It finds real problems and the fixes are tested, but a reviewer who did not write the code will see things the author
> cannot. **Get an independent penetration test before the site handles large amounts of money.**

## Method
Read every route and every database query; traced who can call what; attacked the server with automated tests
(wrong users, forged amounts, parallel requests, hostile input, cross-site requests); planted hostile text directly in
the database to check the pages never run it. 16 server tests + a 36-step two-browser run.

## Problems found and fixed in this build
| # | Problem | Fix |
|---|---|---|
| 1 | Anyone could **lock the admin (or any user) out** by sending wrong passwords for that account. | Lock-out is per account **and** per IP; the real owner on another IP can still log in. Generous global cap per account. |
| 2 | A user could choose a username equal to **someone else's mobile or e-mail**, confusing login lookup. | Usernames must start with a letter and cannot look like numbers/e-mails; lookup order is fixed (mobile → e-mail → username). |
| 3 | **Free-money loophole:** referral bonus (₹10, spendable) was paid at sign-up, so fake accounts could farm it. | Bonus is paid once, only after the referred retailer's **first approved recharge**. |
| 4 | Names, notes and messages could contain **markup** (`<…>`). The page escapes output, but nothing stopped it being stored. | Rejected at input (names: letters only). Output is still escaped — verified by planting hostile data in the database. |
| 5 | Admin could add funds with **no reason**. | Reason required (3–100 chars); written to the audit log and the retailer's statement. |
| 6 | No way to **suspend** a retailer. | Disable/Enable (with reason): signs them out at once, blocks login, audited. Wallet kept. |
| 7 | Unlimited sessions per account; no HSTS; slow-client attacks; server revealed its SMS provider publicly. | Max 10 sessions per account, HSTS over HTTPS, request/header timeouts, `Permissions-Policy`, provider name only shown to admin. |
| 8 | First-run admin password file stayed on disk. | Deleted automatically when the admin changes the password. |
| 9 | Demo SMS mode prints OTPs in the server window — dangerous on a public server. | Startup warning when used on a non-local address. |
| 10 | Admin sign-ins, failures, exports weren't recorded. | All recorded in the audit log. CSV exports neutralise spreadsheet formulas (`=`, `+`, `-`, `@`). |

## Already in place (verified by tests)
Passwords hashed with scrypt · HttpOnly + SameSite cookies, Secure over HTTPS · sessions stored hashed · JSON-only API,
cross-site POSTs blocked · every route checks login/role/ownership · prices, fees, commissions and balances decided
only by the server · every money step is one database transaction (no overspend or double credit even with parallel
requests) · amounts must be whole-rupee numbers · all SQL parameterised · OTPs hashed, 5-minute expiry, 5 tries ·
no password hashes ever sent to a browser or exported · Aadhaar digits are checked but **not stored** · source,
database and `.env` are not downloadable · zero third-party packages (nothing to be compromised through npm).

## Remaining risks (not fixed — know them)
1. **Manual payment checks.** Wallet credit depends on the admin comparing each UTR with the bank statement. A rushed
   approval = money lost. An automatic gateway removes this risk.
2. **Admin account is the crown jewel and has no 2-factor login.** Use a long unique password; consider adding TOTP.
3. **`script-src 'unsafe-inline'`** is needed because the pages use inline event handlers. Protection against script
   injection therefore rests on output escaping (tested) rather than on the browser's CSP.
4. **SMS cost/abuse.** OTP sending is limited per number, per IP and per day, but an attacker could still use up the
   daily SMS cap. Add a CAPTCHA if this happens.
5. **In-memory counters** (OTPs, rate limits) reset on restart and don't work across several server copies.
6. **Data at rest is not encrypted.** `data/seva.db` and backups hold names, mobiles, e-mails and password hashes.
   Protect the computer/server (disk encryption, access control) and your backup copies.
7. **Node's built-in SQLite is still flagged "experimental"** by Node.js. Keep Node updated; keep backups.
8. **Privacy law & payments rules.** You store customers' names/mobiles — India's DPDP Act and your bank/NPCI rules about
   collecting business payments into a personal-name UPI account may apply. Ask a professional; this is not legal advice.

9. **Registration without OTP (current default).** Anyone can register with any mobile number, including one that isn't theirs:
   the real owner then can't register it (number squatting) and may receive that account's SMS alerts (max 10 per number
   per day). Turn on `REQUIRE_OTP=true` once your SMS provider works.
10. **Password reset depends on the admin's judgement (current default, `RESET_METHOD=admin`).** A caller who convinces
   you they are a retailer gets that retailer's wallet. **Always call back on the number registered in the system —
   never on a number the caller gives you — and never read a password out to someone you cannot identify.** Every
   request and issue is in the audit log. Switch to `RESET_METHOD=otp` once SMS works (OTP proves control of the
   registered number, which is stronger than a phone call).
11. **Profile changes need the current password, not an OTP.** Someone who already knows the password could change the
   mobile/email recovery details. Sessions on other devices are signed out when the password changes.

## Before real money — checklist
- [ ] Serve over **HTTPS** (Caddy / Nginx / Cloudflare Tunnel), set `TRUST_PROXY=true`, `BIND_HOST` as in README
- [ ] Change the admin password; delete `FIRST-RUN-ADMIN-PASSWORD.txt` if it still exists
- [ ] Real SMS provider (not `console`); decide on `REQUIRE_OTP` / `RESET_METHOD=otp` (risks 9–10)
- [ ] Train whoever uses the admin login: **call back before issuing a temporary password**
- [ ] Daily `backup.bat` copied off the machine; **test a restore once**
- [ ] Check **Audit log** weekly; export Reports monthly
- [ ] Independent penetration test
