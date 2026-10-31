# MigWeb

The CresRx web front on Cloudflare Workers, moving off Apps Script one screen
at a time. Google Sheets is still the system of record; Apps Script keeps a
copy of the workbook in Supabase current every minute (`Supabase_Mirror.gs` in
the [MIGRATION](https://github.com/Crescentiahealthtech/MIGRATION) repo).

| Path          | What                                                        |
|---------------|-------------------------------------------------------------|
| `/`           | **the whole app**, its page made by the Edge Function from the app's own files (Apps Script's when it cannot) and served from here (no Google frame) |
| `/rpc`        | every server call the app makes: to Apps Script, **except the reads moved here, answered from Supabase** (sign-in calls, Daily Ledger, booking slots, Patients, Command Center; the Finance Hub, IP Notes and the OP consultation through the Edge Function; the tables below) |
| `/ledger/`    | a stand-alone read-only ledger with Google sign-in          |
| `/api/ledger` | its data: `GET ?date=yyyy-MM-dd&doctor=DOC001`              |
| `/api/health` | is the Worker up; can it reach Supabase; is the app address set |

## The app's Daily Ledger, out of Apps Script

The app looks and works exactly as before: same sign-in (password +
authenticator), same screens, same buttons. The difference is where the Daily
Ledger's data comes from (`src/app.js`):

1. The screen asks for the day's ledger (`fetchDailyLedgerScoped`).
2. The Worker looks the session up in Supabase (`session_get`: Apps Script
   stores each session there when it signs someone in, under a hash of the
   token, and removes it at sign-out; a session not there is asked of Apps
   Script once, `getEdgeIdentity`, which stores it), then reads the day from
   Supabase and builds the ledger itself (`src/ledger.js`, the Apps Script
   function line for line).
3. Status changes, deletions, scans, bookings, time changes and patient edits
   still go to Apps Script, which writes the sheet and then copies the change
   to Supabase **before answering** (the Worker asks for this: "flush"), so
   the ledger the screen reloads shows it.
4. If anything is off (Supabase reads switched off with
   `RUN_SB_04b_readsOff`, the minute sync stopped — it leaves a heartbeat
   each minute —, Supabase down, an unknown session, a person's Users row
   changed since their session was stored), Apps Script answers instead, as
   before. The answer then carries `X-CresRx-Why`, which the badge shows.

Under the table the screen says which one answered:
"Loaded in 300 ms from Cloudflare + Supabase" or "… from Apps Script".
`EDGE_OFF` on the Worker sends calls back to Apps Script: a function name
(`getAllPatients`), a comma-separated list, `writes` (every save made in
Supabase), `runner`, or `all`. (`EDGE_LEDGER = off` still works for the ledger.)

### The migration badge (temporary)

Every page of the app carries a small badge, bottom-right, added by the Worker
(`public/migration/status.js`): which server answered the last call, how long
it took, and for the Command Center how old its stored copy is. Click it for
the recent calls and the list of what has moved (`/api/migration`). It also
retries, once, a screen bundle, the consent notice or the build check whose
connection dropped. Remove it by deleting that file and the line in `shell()`
(`src/app.js`), or switch it off with `MIGRATION_BADGE=off`.

**CPU.** The free plan allows 10 ms of CPU per request, and a request that
goes over takes the others in its instance down with it ("Failed to fetch" in
the browser). Calls passed to Apps Script, and their answers, therefore go
through unread; only answers the Worker builds itself are parsed.

### The moved reads (the plan: MIGRATION `docs/supabase/PLAN_OFF_APPS_SCRIPT.md`)

| Apps Script function | Port | Permission | Audited |
|---|---|---|---|
| `fetchDailyLedgerScoped` | `src/ledger.js` | doctor scope | — |
| `getAllPatients`, `getMasterPatientDirectory` | `src/patients.js` | `patient.read` | yes, the register read |
| `getPatientDemographics` | `src/patients.js` | `patient.read` | — |
| `buildLongitudinalTimeline` (outpatients; a patient with an admission goes to Apps Script) | `src/patients.js` | `emr.read` | yes, the patient read |
| `getDashboardData` (every load, Refresh included) | `src/snapshots.js`: the answer Apps Script last stored in Supabase, refreshed in the background when over a minute old (15 s on opening or Refresh); a copy from an earlier day goes to Apps Script | `dashboard.read` (money cards: `accounts.read`) | — |
| `getUserProfile` | `src/signin.js` | any session; a patient only their own | — |
| `crescGetMyPermissions`, `crescTouchSession` | `src/signin.js`, from the stored session | a live session | — |
| `getDoctorPickerContext`, `getDoctorSlotsForDate`, `getDoctorSchedule` | `src/signin.js` | doctor scope | — |
| `crescGetBundle`, `getAppBuild`, `getDPDPNotice`, `getClinicProfile` | made by the Edge Function from its own .gs and .html files (see "Nothing every page asks comes from Apps Script" below); for a page Apps Script made, the copy it stored in Supabase | none, as in Apps Script | — |

An audited read is recorded in Supabase (`edge_log_read`) before the answer
goes back, and reaches the `Audit_Log` sheet with the next minute's sync; if
it cannot be recorded, Apps Script answers instead.

Checked against Apps Script on the demo year by the MIGRATION repo's
`tools/sbmirror.js`: 99 cases (admin, reception, every doctor, refusals) for
both this path and `/ledger/`, identical; a status change, a booking and a
deletion through the Worker show on its ledger at once.

**Changes made directly in the spreadsheet** (typing in the sheet) reach the
copy with the next minute's sync, not at once.

### Day 3: the Finance Hub, IP Notes and the OP consultation, by the app's own code

These 37 reads are not ported here. The Worker sends them (`src/runner.js`,
`RUNNER`), as the page sent them, to the Supabase Edge Function
`cresrx-reads` (MIGRATION repo, `supabase/functions/cresrx-reads`), which
runs **the app's own Apps Script code, unchanged**, on the Supabase copy: the
spreadsheet it reads is the copy, the clock is the clinic's, the session is
the one Apps Script stored. It runs in the database's region
(`SUPABASE_REGION`, `wrangler.jsonc`) with 2 s of CPU per call, which the
Worker's 10 ms could never give these functions.

| Screen | Functions |
|---|---|
| Finance Hub | `getAccountsDashboard` (Master Ledger), `getFinanceDashboard`, `getReceivables`, `getAllDrawerStates`, `getShiftState`, `getPayables`, `getExpenseRegister`, `getTaxSummary`, `getAuditModules`, `getAuditLog`, `getInsuranceClaims`, `getInsurers`, `getPackages`, `getOpenAdmissions`, `getRunningTab`, `getIpVisits`, `getPharmacyLedger` |
| IP Notes | `getActiveIPAdmissionsForNotes`, `getIPNotesBundle`, `getIPTimeline`, `getIPNotePermissions`, `getClinicalContext`, `getIPLabResults`, `getIPCareTeamPanel`, `getIPTeamRoles`, `getIPNotesLabCatalog` |
| OP consultation | `getComposerContext`, `getPatientAllergies`, `getLastVisitRecall`, `listConsultTemplates`, `getAssistForDiagnosis`, `getOPDOrderableTests`, `fetchOPDrugMaster`, `fetchUniversalDrugs`, `fetchPharmacyMasterForIP`, `checkRxSafety`, `mcCardEligibility` |

Anything the Edge Function cannot answer exactly (a read that writes, a
Google-only service, a tab or setting not copied, a session it does not know)
comes back as a reason, and Apps Script answers as before; the badge shows
"(app code)" for its answers and the reason otherwise. `EDGE_OFF=runner` sends
all of them back to Apps Script; a function's own name sends that one back.

**Saves made in Supabase (Phase W).** Bookings, check-ins, appointment status
and time, patients' profiles and allergies, the OP consultation (with its
referrals, templates and bundles) and Hospital Billing's bills, payments,
cancellations and payment modes (`WRITER` in `src/runner.js`, 26 saves) go to
the Edge Function too. It runs the app's own save on the copy and commits all
its writes in one go, and the Worker then asks Apps Script to write them into
the Sheet (`drainSoon`). Every call the Worker passes to Apps Script while a
save is still waiting carries `"drain": true`, so Apps Script writes it in
first. A save sent with a call id whose answer is lost is closed in the log by
that id (`recover`): either it was made and the log's answer is given, or it
can no longer be made and Apps Script makes it. A save the Edge Function cannot
make exactly (a row deleted, a password set) is refused with nothing written,
and Apps Script makes it, copied as before. `EDGE_OFF=writes` sends every save
back to Apps Script; the badge says "saved in Supabase" for the others. The
proof that each leaves the Sheet as Apps Script would is the MIGRATION repo's
`tools/edgewrites.js`.

**Fresh after a change.** Every write of those screens copies what it changed
before answering (`FLUSH_AFTER`; with `watch` when it edits older rows in
place). Writes on screens not moved yet that change what these screens show —
pharmacy, lab and hospital bills, the ward's case sheet and discharge summary —
are copied just after their answer, on a call of their own, so nobody waits
for it (`FLUSH_SOON`). Everything else arrives with the minute's sync.

## Nothing every page asks comes from Apps Script

The page itself, the screen bundles (`crescGetBundle`), the build check
(`getAppBuild`), the consent notice (`getDPDPNotice`) and the letterhead
(`getClinicProfile`) are made by the Edge Function from the same commit's
.gs and .html files (`runner.js` `PUBLIC`, `viaShell`): the app's own
`cresc_shellHtml_`, `crescGetBundle` and the rest, run with no session.
Before, they were copies Apps Script left in Supabase, so the first opening
of each screen after a new build went to Apps Script (up to 39 s), and every
copy was re-read from Apps Script every few minutes.

- **The page** (`shell()`): from the Edge Function (`{fn: "__shell"}`), kept
  at the edge as before, with where it came from and its build
  (`X-Shell-From`, `X-Shell-Build`). Apps Script's `?shell=1` when the Edge
  Function cannot make it, or with `EDGE_OFF=shell`.
- **A bundle**: the Edge Function's, when the page asking is of its build
  (`X-CresRx-Shell-Build` against the `cresrx_build` cookie); a page Apps
  Script made gets the copy stored for its build, as before.
- **The build check**: the Edge Function's while the page served here is the
  one it made, so an open page is never told of a build it would not get.
- `EDGE_OFF=runner` (or a function's name) brings back the stored copies and
  Apps Script.

What still goes to Apps Script, and why (51 calls: e-mail, PDFs and Drive;
passwords and authenticator secrets; the Sessions tab; the audit viewer; three
settings saves; Apps Script's own cache and triggers; the label printer's key;
workbook setup; two reads of registers the minute sync does not keep):
MIGRATION `docs/supabase/PLAN_OFF_APPS_SCRIPT.md` §5m, with the 6 reads and 8
saves moved in the same round.

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
| `SUPABASE_SECRET_KEY` | Secret | the same `sb_secret_…` key Apps Script uses (Supabase → Project Settings → API Keys); the Edge Function `cresrx-reads` accepts calls carrying it |
| `ALLOWED_EMAILS`      | Secret | for `/ledger/` only: Google accounts allowed in, comma-separated       |

Never put these in a file in this repo. (`SUPABASE_URL`, `SUPABASE_REGION`
and `FIREBASE_PROJECT_ID` are in `wrangler.jsonc`; `keep_vars` stops a deploy
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
- `src/patients.js` — the patient register, demographics, timeline
- `src/signin.js` — permissions, the doctor picker, a patient's profile, booking slots and weekly hours
- `src/snapshots.js` — stored answers (Command Center), and switched-off cards taken out
- `src/runner.js` — the reads and saves the Edge Function makes with the app's own code (Day 3, Phase W), and what every page asks with no session (the page, bundles, build check, notice, letterhead)
- `public/ledger/index.html` — the page
- `public/vendor/firebase-10.7.1/` — Firebase sign-in SDK, served from here
- `test/` — offline checks (`npm test`)

## Lab results from TN HMIS (`extension/`, `/api/lab/import`)

A Chrome/Edge extension copies the lab report a signed-in user is looking at
in TN HMIS into Supabase (`lab_results`, `lab_orders`). It only acts when the
user clicks; it never browses HMIS by itself.

1. **Once, in Supabase → SQL Editor:** run `sql/lab_results.sql` (safe to
   run again; it adds what a newer version needs).
1. **Patients sheet:** a column headed **HMIS ID** holding each patient's TN
   HMIS PIN (555…). A report is saved only to the one patient with its PIN;
   it is never matched by name.
2. **Once, the key:** `npx wrangler secret put LAB_IMPORT_KEY` (any random
   string of 16+ characters). Without it `/api/lab/import` answers 401.
3. **Each PC:** `chrome://extensions` (or `edge://extensions`) → Developer
   mode → *Load unpacked* → the `extension/` folder. In its Options, enter
   the web app's address, the key and the user's name.
4. **Use:** open the report (the HMIS page or its PDF) → click the extension →
   *Read this report* → check the table → *Save to CresRx*. A PDF already
   downloaded can be chosen in the popup instead.

**Phones (and PCs without the extension): `/lab/`.** Open
`<web app address>/lab/`, enter the lab key and your name once (Settings),
then *Choose lab report PDF* → check → *Save to CresRx*. On Android, after
adding the app to the home screen and opening `/lab/` once, a PDF can be sent
straight from WhatsApp/Files with *Share → DEMO CLINIC* (`share_target` in
`public/manifest.webmanifest`, received by `public/lab/sw.js`).

The PDF's text is read in the browser (`extension/pdftext.js`, pdf.js 4.10.38
in `extension/vendor/`); the Worker parses it (`src/labparse.js`) and stores
one row per test, keyed by Order No + panel + test, so saving a report again
updates it rather than duplicating it. Abnormal (`*`) values are flagged and
rejected tests go to `lab_orders`.
