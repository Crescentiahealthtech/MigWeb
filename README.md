# MigWeb

The CresRx web front on Cloudflare Workers, moving off Apps Script one screen
at a time. Google Sheets is still the system of record; Apps Script keeps a
copy of the workbook in Supabase current every minute (`Supabase_Mirror.gs` in
the [MIGRATION](https://github.com/Crescentiahealthtech/MIGRATION) repo), and
the screens here read that copy directly — no Apps Script in the path.

| Path          | What                                                        |
|---------------|-------------------------------------------------------------|
| `/`           | the existing app (the Apps Script web app in a frame)       |
| `/ledger/`    | **Appointment Ledger**, read-only, from Supabase            |
| `/api/ledger` | its data: `GET ?date=yyyy-MM-dd&doctor=DOC001`              |
| `/api/health` | is the Worker up, can it reach Supabase                     |

## Two repositories, two ways of deploying

- **MIGRATION** holds the Apps Script (`.gs`, `.html`). It goes to Google with
  `clasp push` or the Apps Script editor, as before. Nothing in it goes to
  Cloudflare.
- **MigWeb** (this repo) is only what Cloudflare serves: `public/` (pages) and
  `src/` (the Worker). It never holds `.gs` files.

A screen moves by being rebuilt here; its Apps Script version stays until the
new one has been used for a while, then is retired in MIGRATION.

## What the Appointment Ledger does

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

## Deploy (first time)

### 1. Secrets on the Worker

Cloudflare dashboard → **Workers & Pages** → **migweb** → **Settings** →
**Variables and Secrets** → **Add**:

| Name                  | Type   | Value                                                                 |
|-----------------------|--------|-----------------------------------------------------------------------|
| `SUPABASE_SECRET_KEY` | Secret | the same `sb_secret_…` key Apps Script uses (Supabase → Project Settings → API Keys) |
| `ALLOWED_EMAILS`      | Secret | the Google accounts allowed in, comma-separated, e.g. `you@gmail.com, frontdesk@gmail.com` |

Each email must also be the **Email Address** of an Active row on the Users
sheet. Never put the secret key in a file in this repo.

(`SUPABASE_URL` and `FIREBASE_PROJECT_ID` are in `wrangler.jsonc`;
`keep_vars` stops a deploy from wiping what you set in the dashboard.)

### 2. Let Firebase accept the Worker's address

Firebase console → project **cresrxdemo** → **Authentication** →
**Settings** → **Authorized domains** → **Add domain**:
`migweb.<your-subdomain>.workers.dev` (shown on the Worker's overview page),
and any custom domain you attach later. Without it, sign-in says the
address is not authorised.

### 3. Deploy

Either

- **From GitHub (recommended):** Workers & Pages → migweb → Settings →
  **Build** → connect `Crescentiahealthtech/MigWeb`, production branch
  `main`, deploy command `npx wrangler deploy`. Merging to `main` deploys;
  other branches get preview URLs if "non-production branch builds" is on.
- **From a computer:** `npm install`, `npx wrangler login`,
  `npx wrangler deploy`.

### 4. Check

- `https://migweb.<subdomain>.workers.dev/api/health` →
  `{"ok":true,"supabase":"ok",…}`
- `https://migweb.<subdomain>.workers.dev/ledger/` → sign in → today's
  ledger. The footer shows the load time and when the copy was last updated.

## Local development

```
npm install
printf 'SUPABASE_SECRET_KEY=sb_secret_...\nALLOWED_EMAILS=you@gmail.com\n' > .dev.vars   # git-ignored
npx wrangler dev          # http://localhost:8787/ledger/ (add localhost to Firebase authorized domains)
npm test
```

## Files

- `src/worker.js` — routes, sign-in check, the Supabase call
- `src/auth.js` — Firebase ID token verification (Google's public keys)
- `src/ledger.js` — the ledger, a line-for-line port of the Apps Script one
- `public/ledger/index.html` — the page
- `public/vendor/firebase-10.7.1/` — Firebase sign-in SDK, served from here
- `test/` — offline checks (`npm test`)
