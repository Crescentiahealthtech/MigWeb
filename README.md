# MigWeb

The CresRx web front on Cloudflare Workers, moving off Apps Script one screen
at a time. Google Sheets is still the system of record; Apps Script keeps a
copy of the workbook in Supabase current every minute (`Supabase_Mirror.gs` in
the [MIGRATION](https://github.com/Crescentiahealthtech/MIGRATION) repo).

| Path          | What                                                        |
|---------------|-------------------------------------------------------------|
| `/`           | **the whole app**, its page fetched from Apps Script and served from here (no Google frame) |
| `/rpc`        | every server call the app makes: to Apps Script, **except the Daily Ledger's, answered here from Supabase** |
| `/ledger/`    | a stand-alone read-only ledger with Google sign-in          |
| `/api/ledger` | its data: `GET ?date=yyyy-MM-dd&doctor=DOC001`              |
| `/api/health` | is the Worker up; can it reach Supabase; is the app address set |

## The app's Daily Ledger, out of Apps Script

The app looks and works exactly as before: same sign-in (password +
authenticator), same screens, same buttons. The difference is where the Daily
Ledger's data comes from (`src/app.js`):

1. The screen asks for the day's ledger (`fetchDailyLedgerScoped`).
2. The Worker asks Apps Script once who the session is (`getEdgeIdentity`;
   remembered for 2 minutes), then reads the day from Supabase and builds the
   ledger itself (`src/ledger.js`, the Apps Script function line for line).
3. Status changes, deletions, scans, bookings, time changes and patient edits
   still go to Apps Script, which writes the sheet and then copies the change
   to Supabase **before answering** (the Worker asks for this: "flush"), so
   the ledger the screen reloads shows it.
4. If anything is off (Supabase reads switched off with
   `RUN_SB_04b_readsOff`, the minute sync stopped, Supabase down, an unknown
   session), Apps Script answers instead, as before.

Under the table the screen says which one answered:
"Loaded in 300 ms from Cloudflare + Supabase" or "… from Apps Script".
`EDGE_LEDGER = off` on the Worker sends the ledger to Apps Script again.

Checked against Apps Script on the demo year by the MIGRATION repo's
`tools/sbmirror.js`: 99 cases (admin, reception, every doctor, refusals) for
both this path and `/ledger/`, identical; a status change, a booking and a
deletion through the Worker show on its ledger at once.

**Changes made directly in the spreadsheet** (typing in the sheet) reach the
copy with the next minute's sync, not at once.

## Two repositories, two ways of deploying

- **MIGRATION** holds the Apps Script (`.gs`, `.html`). It goes to Google with
  `clasp push` or the Apps Script editor, as before. Nothing in it goes to
  Cloudflare.
- **MigWeb** (this repo) is only what Cloudflare serves: `public/` (pages) and
  `src/` (the Worker). It never holds `.gs` files.

A screen moves by being rebuilt here; its Apps Script version stays until the
new one has been used for a while, then is retired in MIGRATION.

## The stand-alone /ledger/ page

1. You sign in with Google (Firebase project `cresrxdemo`, the same one the
   Apps Script app uses).
2. The page sends the Google ID token to `/api/ledger`. The Worker checks it
   against Google's keys (signature, project, expiry, verified email), then
   that the email is on `ALLOWED_EMAILS`, then finds your row in the Users
   sheet by **Email Address** (Active only) for your username and role.
3. One request to Supabase (`mirror_query`) fetches Users, Doctors, that day's
   appointments and their patients; the Worker builds exactly what
   `fetchDailyLedgerScoped` returns, with the same scope rules (a doctor sees
   their own patients unless Can_View_All / chief owner / duty MO;
   reception, nurses, admin see all).

The answer is checked against Apps Script's: the MIGRATION repo's
`tools/sbmirror.js` runs both over 60 days of the demo year for admin,
reception, every doctor, and refused cases (99 cases, 900 appointments,
identical). `npm test` here runs the offline checks.

**Pilot limit:** the Apps Script app also asks for an authenticator code
(MFA). This page does not yet, which is why only the emails in
`ALLOWED_EMAILS` get in. Keep it to the demo workbook until MFA is added.

## Deploy

### 1. Settings on the Worker

Cloudflare → **Workers & Pages** → **migweb** → **Settings** →
**Variables and Secrets** → **Add**:

| Name                  | Type   | Value                                                                 |
|-----------------------|--------|-----------------------------------------------------------------------|
| `APP_EXEC_URL`        | Secret | the Apps Script deployment's address, `https://script.google.com/macros/s/…/exec` — the same one the Worker behind your clinic address uses (its Variables and Secrets), or Apps Script → Deploy → Manage deployments |
| `SUPABASE_SECRET_KEY` | Secret | the same `sb_secret_…` key Apps Script uses (Supabase → Project Settings → API Keys) |
| `ALLOWED_EMAILS`      | Secret | for `/ledger/` only: Google accounts allowed in, comma-separated       |

Never put these in a file in this repo. (`SUPABASE_URL` and
`FIREBASE_PROJECT_ID` are in `wrangler.jsonc`; `keep_vars` stops a deploy
from wiping what you set in the dashboard.)

### 2. Apps Script

Deploy the MIGRATION branch's code to the **same** deployment
(Deploy → Manage deployments → edit → New version): it adds
`getEdgeIdentity`, the "flush" in `doPost` and the "Loaded … from" line.
Deployment access must be "Anyone" (it already is if your clinic address
serves the app without Google's frame). Supabase reads on (`RUN_SB_04_readsOn`)
and the minute sync running (`RUN_SB_03_startAutoSync`).

### 3. Deploy the Worker, then try it

Merge to `main` (with the Git build connected) or `npx wrangler deploy`. Then:

- `https://migweb.<subdomain>.workers.dev/api/health` →
  `"supabase":"ok"`, `"app":"set"`
- `https://migweb.<subdomain>.workers.dev/` → the app; sign in as usual →
  Appointments → Daily Ledger. Under the table: "… from Cloudflare + Supabase".

### 4. Your clinic address

When you are happy with it, move `migration.crescentiahealthtech.com` to
this Worker: remove it from the Worker that serves it now (that Worker →
Settings → Domains & Routes), then migweb → Settings → Domains & Routes →
Add → Custom domain. Going back is the same in reverse.

Firebase (Google sign-in on `/ledger/`, and in the app if it offers Google
sign-in): Authentication → Settings → Authorized domains must list each
address you use.

## Local development

```
npm install
printf 'SUPABASE_SECRET_KEY=sb_secret_...\nALLOWED_EMAILS=you@gmail.com\n' > .dev.vars   # git-ignored
npx wrangler dev          # http://localhost:8787/ledger/ (add localhost to Firebase authorized domains)
npm test
```

## Files

- `src/worker.js` — routes; `/ledger/`'s sign-in check and its Supabase call
- `src/app.js` — the app from this address: page, `/rpc`, the Daily Ledger from Supabase
- `src/auth.js` — Firebase ID token verification (Google's public keys)
- `src/ledger.js` — the ledger, a line-for-line port of the Apps Script one
- `public/ledger/index.html` — the page
- `public/vendor/firebase-10.7.1/` — Firebase sign-in SDK, served from here
- `test/` — offline checks (`npm test`)
