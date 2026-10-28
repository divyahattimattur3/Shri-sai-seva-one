# Shri Sai Service Seva One — website with database backend

**Run:** double-click `start.bat`, then open http://localhost:5100 (needs Node.js 22.13 or newer; 24 LTS recommended).
No `npm install` is needed — there are no dependencies.

## First start
* The server creates the database (`data/seva.db`) and the **admin account**
  (`sachinah98@gmail.com` / `8123860840`). A **random admin password is printed in the server window** and saved in
  `data/FIRST-RUN-ADMIN-PASSWORD.txt`. Log in, open **Change Password**, then delete that file.
* Forgot it later? Double-click `reset-admin.bat`.

## What lives on the server now
Accounts, wallets, payments, applications, commissions, notifications, tickets and the SMS log are stored in the SQLite
database — not in the browser. Several people on different phones/computers can use the same site at once.
* Passwords are hashed (scrypt). Sessions use HttpOnly cookies. Logins, OTPs and registrations are rate-limited.
* **Prices, commissions and wallet balances are decided only by the server.** All money steps are atomic: a request
  can never overspend a wallet or be credited twice (tested with parallel requests).
* Admin actions (payment approvals, funds, status changes) are recorded in the `audit` table.

## Admin screens
**Dashboard · Applications · Retailers** (add funds with a reason, **Disable/Enable** an account) · **Transactions · Payments**
(approve/reject UTRs) · **Password requests** · **Support & Announcement · Reports** (date range, totals, daily chart, top services/retailers,
CSV downloads for Excel) · **Audit log** (who did what, searchable, exportable) · **SMS Gateway**. Read `SECURITY.md`.

## Wallet recharge (still manual)
Retailer pays your UPI QR → enters the 12-digit UTR → you check your bank/UPI statement → **Admin › Payments › Approve**.
Nothing is credited until you approve. (An automatic gateway such as Razorpay/Cashfree can be added later.)

## Registration, forgot password, profile — no OTP needed
* **Registering:** people sign up directly, no OTP (`REQUIRE_OTP=false`, the default).
* **Forgot password:** the retailer enters their mobile/email and presses *Send request to admin*. You see it under
  **Admin › Password requests**. **Call them back on their registered number to make sure it is really them**, press
  *Set temporary password*, and tell it to them (phone/WhatsApp). It is shown once; they must pick a new password at
  their next login. (The admin account itself is reset with `reset-admin.bat`.)
* **Profile:** changing name, state or username needs nothing extra. Changing **mobile, email or password** asks for the
  *current password* (no OTP).
* Want SMS codes instead? Set `RESET_METHOD=otp` and/or `REQUIRE_OTP=true` in `.env` (needs a working SMS provider).

## SMS
Default `SMS_PROVIDER=console` prints SMS (including OTPs) in the server window. For real SMS double-click
`setup-sms.bat` (Fast2SMS) — it saves your key to `.env` and sends one test message.

## Backups  (do this regularly!)
Double-click `backup.bat` — saves a copy to `data/backups/`. Copy that folder somewhere safe (USB / cloud).
To restore: stop the site, replace `data/seva.db` with a backup copy, start again.

## Putting it on the internet
1. Run it on a server/VPS with `BIND_HOST=0.0.0.0` **behind HTTPS** (Caddy, Nginx or a Cloudflare Tunnel) and set
   `TRUST_PROXY=true`. Without HTTPS, passwords travel unencrypted.
2. Change the admin password. Use a real SMS provider (needed for forgot-password OTPs); consider `REQUIRE_OTP=true` so new accounts confirm their mobile.
3. Keep Node.js updated, back up daily.

## Tests
`node --test test/api.test.js` — 16 integration tests (security, money, reports, flows) against a temporary database.

## Known limits
* One server process (OTP codes and rate-limit counters live in memory and reset on restart).
* No automatic payment gateway yet; admin approves UTRs by hand.
* Only self-reviewed, **not independently audited** — see `SECURITY.md` before handling large amounts of money.
