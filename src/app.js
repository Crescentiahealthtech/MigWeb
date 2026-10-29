// ============================================================================
// The whole CresRx app from this address, with the Daily Ledger read from
// Supabase instead of Apps Script.
// ----------------------------------------------------------------------------
// The page and every server call work as they do on the clinic's address
// today (the demo-web Worker, docs/cloudflare/demo-web-worker.js in the
// MIGRATION repo, with Web_Proxy.gs):
//
//   GET  /       the app's page, fetched from the Apps Script deployment
//                (…/exec?shell=1, server to server) and served as this
//                address's own page.
//   POST /rpc    every server call the page makes ({fn, args}), passed to
//                the deployment's doPost and the answer back.
//   GET  /?privacy, ?rights, ?doc=…, ?verifyDS=…, ?viewReport=…
//                the patient pages, Google's page in a frame as before.
//
// The difference: the reads people wait on are answered here, from the
// Supabase copy of the workbook, without Apps Script (the EDGE table below):
// the Daily Ledger, the patient register and records, the Command Center,
// and the calls every screen makes at sign-in (permissions, the doctor
// picker, screen bundles, the build check, the consent notice). Anything
// else, and any doubt, goes to Apps Script exactly as before:
//
//   * who is asking: the app's own session token, looked up in Supabase
//     (mirror.sessions), where Apps Script records each session when it signs
//     someone in and whenever it checks one, and removes it at sign-out. A
//     session not there is asked of Apps Script (getEdgeIdentity), which
//     records it. Switching an account off, or editing it, takes effect at
//     once (its Users row no longer matches the one the session was stored
//     with);
//   * whether the copy may be used: only while Apps Script's every-minute
//     sync keeps leaving its heartbeat (RUN_SB_04b_readsOff stops it);
//   * the answers: ports of the Apps Script functions, line for line,
//     compared with them on the demo year by the MIGRATION repo's
//     tools/sbmirror.js;
//   * fresh after a change: a call that writes goes to Apps Script with
//     "flush" (Web_Proxy.gs), which copies the sheets it changed to Supabase
//     before answering, so the screen's reload shows it. Changes made in the
//     sheet by hand reach the copy with the next sync (a minute);
//   * saves made in Supabase (Phase W, src/runner.js WRITER): the Edge
//     Function makes them on the copy, and Apps Script writes them into the
//     Sheet straight after. Any call passed to Apps Script while one is
//     still waiting carries "drain", so Apps Script writes it in first.
//
// When the Worker leaves a call it could answer to Apps Script, the answer
// says why (X-CresRx-Why; the migration badge shows it).
//
// Settings: APP_EXEC_URL (the deployment's …/exec address; the same one the
// clinic's address uses), SUPABASE_URL, SUPABASE_SECRET_KEY. EDGE_OFF names
// calls to leave to Apps Script ("all" for every one, "writes" for every
// save made in Supabase).
// ============================================================================

import { sessionLedgerQueries, buildLedger, doctorsFrom, resolveScope, dayKey, istDay } from './ledger.js';
import { splitSnapshot, redact, hiddenFor } from './snapshots.js';
import { registerQuery, allPatients, masterDirectory, demographicsQuery, demographics, timelineQuery, timeline,
         patientKey } from './patients.js';
import { Unsure, myPermissions, touchSession, pickerQuery, doctorPicker, profileQuery, userProfile,
         slotsDay, slotsQuery, doctorSlots, scheduleQuery, doctorSchedule } from './signin.js';
import { RUNNER, WRITER, PUBLIC, viaRunner, viaSaver, savesWaiting, warmRunner, viaShell } from './runner.js';

// The page is kept at the edge for a week and served from there at once; one
// older than SHELL_FRESH_SECONDS is fetched again in the background, so the
// next visitor has the new one (the app's own build check offers a reload
// when a newer build is deployed). Before, it was kept 20 s, and the first
// visitor after that waited for Apps Script to build it (about 5 s).
const SHELL_FRESH_SECONDS = 20;
const SHELL_KEEP_SECONDS = 7 * 24 * 3600;
const IDENTITY_MEMO_MS = 15 * 1000;            // a session looked up in Supabase, remembered by this instance
const IDENTITY_REFRESH_MS = 10 * 60 * 1000;    // stored longer ago than this: Apps Script re-checks it, in the background
const MAX_RPC_BYTES = 20 * 1024 * 1024;
const PASS_THROUGH = /^(privacy|rights|doc|k|verifyDS|viewReport)$/;
const EXEC_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

/**
 * Calls after which some sheets are copied to Supabase before the answer
 * comes back (doPost's "flush", Web_Proxy.gs), so the screens answered from
 * the copy show the change at once. Each lists the sheets it can change.
 */
const APPT = ['Appointments', 'Patients'];
const LEDGER = 'Finance_Master_Ledger', AUDIT = 'Audit_Event_Ledger';
export const FLUSH_AFTER = {
  updateAppointmentStatus: APPT, setAppointmentTime: APPT, barcodeUpdateAppointment: APPT, submitNewAppointment: APPT,
  bookAppointmentScoped: APPT, portalBookAppointment: APPT, portalCancelAppointment: APPT,
  // Every row the save edits in place is marked (OP_Database_Engine.gs), so
  // only those and the new rows are copied: the doctor waits for this.
  saveOPEncounterScoped: { sheets: ['Appointments', 'OP_Encounters', 'Clinical_Templates'], window: 0 },
  createOPReferral: ['Appointments', 'Patients', 'OP_Referrals'], respondToOPReferral: ['Appointments', 'OP_Encounters', 'OP_Referrals'],
  registerPatient: ['Patients'], updatePatientProfile: ['Patients'], saveUserProfile: ['Patients'],
  savePatientAllergies: ['Patients'],
  // The bed map and ward are answered from the copy (Day 4b): the beds too.
  saveNewAdmissionLedger: { sheets: ['IP_Admissions', 'Patients', 'Master_Beds'], watch: true },
  processBedTransfer: { sheets: ['IP_Admissions', 'Master_Beds'], watch: true },
  processPatientDischarge: { sheets: ['IP_Admissions', 'Master_Beds'], watch: true },
  // Doctors' hours and leave: the booking slots are read from the copy.
  saveDoctorSchedule: ['Doctor_Schedules'], addScheduleException: ['Doctor_Schedule_Exceptions'],
  deleteScheduleException: ['Doctor_Schedule_Exceptions'], setDoctorDayBlocks: ['Doctor_Schedule_Exceptions'],
  // Accounts: a changed Users row ends the stored sessions it was stored with.
  crescSaveUserAccess: ['Users'], crescSetAccountActive: ['Users'], crescAdminResetPassword: ['Users'],
  crescChangePassword: ['Users'], crescCreateStaffAccount: ['Users', 'Doctors'],
  // Finance Hub (its screens are answered from the copy: src/runner.js).
  // Every money write also leaves an entry in Audit_Event_Ledger (the audit
  // tab). `watch`: the write edits rows in place, maybe weeks old, so the
  // sheets' watched columns are compared too (Supabase_Mirror.gs SB_CFG.WATCH).
  recordLedgerEntry: [LEDGER, AUDIT], recordBankTransfer: [LEDGER, AUDIT],
  moveShiftCashOut: { sheets: [LEDGER, 'Shift_Registers', AUDIT], watch: true },
  openShift: ['Shift_Registers', LEDGER, AUDIT], closeShift: { sheets: ['Shift_Registers', LEDGER, AUDIT], watch: true },
  lockFinancialPeriod: { sheets: [LEDGER, AUDIT], watch: true },
  recordPayable: ['Accounts_Payable', LEDGER, AUDIT], payPayable: { sheets: ['Accounts_Payable', LEDGER, AUDIT], watch: true },
  createManualClaim: ['Insurance_Claims_Ledger', AUDIT], updateClaim: { sheets: ['Insurance_Claims_Ledger', AUDIT], watch: true },
  settleClaim: { sheets: ['Insurance_Claims_Ledger', 'IP_Settlements', LEDGER, AUDIT], watch: true },
  // The claim tracker: a claim's stage, documents and reminders are edited in place.
  moveClaimStage: { sheets: ['Insurance_Claims_Ledger', AUDIT], watch: true },
  tickClaimDocument: { sheets: ['Insurance_Claims_Ledger', AUDIT], watch: true },
  chaseClaim: { sheets: ['Insurance_Claims_Ledger', AUDIT], watch: true },
  saveInsurerContact: { sheets: ['Insurers_Master', AUDIT], watch: true }, saveClaimSla: { sheets: ['Claim_Stage_Timers', AUDIT], watch: true },
  addIpCharge: ['IP_Charges', AUDIT], addIpCharges: ['IP_Charges', AUDIT], billChargeToIp: ['IP_Charges', AUDIT],
  editIpCharge: { sheets: ['IP_Charges', AUDIT], watch: true }, voidIpCharge: { sheets: ['IP_Charges', AUDIT], watch: true },
  markIpChargePaidAtCounter: { sheets: ['IP_Charges', AUDIT], watch: true },
  collectIpAdvance: ['IP_Advances', LEDGER, AUDIT],
  addIpVisit: ['IP_Visits'], saveDischargeDraft: { sheets: ['IP_Discharge_Drafts'], watch: true },
  // A bill settled weeks after it was raised is edited in place.
  settleReceivableBill: { sheets: ['Pharmacy_Invoices', 'LAB_BILLING', 'Hospital_Invoices', 'LAB_SETTLEMENTS', LEDGER, AUDIT], watch: true },
  settleDischarge: { sheets: ['IP_Charges', 'IP_Advances', 'IP_Settlements', LEDGER, 'Hospital_Invoices', 'IP_Admissions',
                              'IP_Discharge_Drafts', 'Insurance_Claims_Ledger', AUDIT], watch: true },
  // IP Notes: notes, ward medicines, the care team, the diagnosis.
  saveIPNote: ['IP_Timeline_DB', 'IP_Pharmacy_Queue'], updateIPMedAction: { sheets: ['IP_Pharmacy_Queue'], watch: true },
  addIPCrossConsult: ['IP_Care_Team'], removeIPCrossConsult: { sheets: ['IP_Care_Team'], watch: true },
  addIPCareTeamMember: ['IP_Care_Team'], removeIPCareTeamMember: { sheets: ['IP_Care_Team'], watch: true },
  updateIPDiagnosis: { sheets: ['IP_Admissions', 'IP_CaseSheets_DB'], watch: true },
  // OP consultation: templates, bundles, phrases, examination defaults.
  saveConsultTemplate: ['OP_Consult_Templates'], applyConsultTemplate: ['OP_Consult_Templates'],
  deleteConsultTemplate: ['OP_Consult_Templates'], saveRxBundle: ['Rx_Bundles'], noteRxBundleUsed: ['Rx_Bundles'],
  deleteRxBundle: ['Rx_Bundles'], deletePhraseTemplate: ['Clinical_Templates'], promotePhraseToClinic: ['Clinical_Templates'],
  saveExamDefaults: ['Doctor_Exam_Defaults'],
  // Hospital Billing (its lists and the billing ledger are answered from the
  // copy from Day 4): a bill saved, paid, cancelled or its mode changed is on
  // the ledger the screen reloads. A bill also closes the tests it billed
  // (Investigation_Orders, the "orders to bill" list) and posts an
  // inpatient's lines to the running bill (IP_Charges).
  hb_saveInvoice: { sheets: ['Hospital_Invoices', 'Hospital_Invoice_Items', 'Investigation_Orders', 'IP_Charges', LEDGER, AUDIT], watch: true },
  hb_recordPayment: { sheets: ['Hospital_Invoices', 'IP_Settlements', LEDGER, AUDIT], watch: true },
  hb_cancelInvoice: { sheets: ['Hospital_Invoices', 'Investigation_Orders', LEDGER, AUDIT], watch: true },
  hb_changePaymentMode: { sheets: ['Hospital_Invoices', 'IP_Advances', LEDGER, AUDIT], watch: true },
  hb_dismissOrder: { sheets: ['Investigation_Orders'], watch: true },
  // Pharmacy (its screens are answered from the copy from Day 5). A sale
  // takes stock off batches in place and marks the rows it changed
  // (Pharmacy.gs, sbTouch_), so only those and the bill's new rows are
  // copied: the stock list reloaded after a bill must not offer what was
  // just sold, and the pharmacist waits for nothing more. Writes that do not
  // mark their rows compare the shelf's watched columns down the tab (watch).
  processPharmacyBill: { sheets: ['Pharmacy_Invoices', 'Pharmacy_Invoice_Items', 'Pharmacy_Inventory', 'IP_Charges', LEDGER, AUDIT], window: 0 },
  processPharmacyReturn: { sheets: ['Pharmacy_Invoices', 'Pharmacy_Invoice_Items', 'Pharmacy_Returns', 'Pharmacy_Return_Items',
                                    'Pharmacy_Inventory', 'Pharmacy_Disposal_Log', 'IP_Charges', LEDGER, AUDIT], watch: true },
  settleCreditBill: { sheets: ['Pharmacy_Invoices', 'IP_Charges', LEDGER, AUDIT], watch: true },
  changePharmacyPayMode: { sheets: ['Pharmacy_Invoices', LEDGER, AUDIT], watch: true },
  savePharmacyPurchase: { sheets: ['Pharmacy_Purchases', 'Pharmacy_Purchase_Items', 'Accounts_Payable', 'Pharmacy_Inventory',
                                   'Pharmacy_Master', LEDGER, AUDIT], watch: true },
  cancelPharmacyPurchase: { sheets: ['Pharmacy_Purchases', 'Pharmacy_Purchase_Items', 'Accounts_Payable', 'Pharmacy_Inventory',
                                     'Pharmacy_Master', LEDGER, AUDIT], watch: true },
  createSupplierReturn: { sheets: ['Supplier_Returns', 'Supplier_Return_Items', 'Pharmacy_Inventory', 'Pharmacy_Master', LEDGER, AUDIT], watch: true },
  savePharmacyInventory: { sheets: ['Pharmacy_Inventory', 'Pharmacy_Master'], watch: true },
  updatePharmacyStock: { sheets: ['Pharmacy_Inventory', 'Pharmacy_Master', AUDIT], watch: true },
  deletePharmacyBatch: { sheets: ['Pharmacy_Inventory'], watch: true },
  discardPharmacyStock: { sheets: ['Pharmacy_Inventory', 'Pharmacy_Disposal_Log', 'Pharmacy_Master', LEDGER, AUDIT], watch: true },
  applyPackSizes: { sheets: ['Pharmacy_Inventory', 'Pharmacy_Master'], watch: true },
  applyScheduleClassification: { sheets: ['Pharmacy_Inventory'], watch: true },
  // The reorder (Pharmacy_Reorder.gs): each save marks the one row it writes
  // (a medicine's level, a supplier, the defaults, an order).
  saveReorderSetting: { sheets: ['Pharmacy_Reorder_Settings'], window: 0 }, saveSupplierReorderSetting: { sheets: ['Pharmacy_Reorder_Settings'], window: 0 },
  saveReorderConfig: { sheets: ['Pharmacy_Reorder_Settings'], window: 0 },
  createPurchaseOrderDraft: { sheets: ['Pharmacy_Purchase_Orders'], window: 0 }, setPurchaseOrderStatus: { sheets: ['Pharmacy_Purchase_Orders'], window: 0 },
  // The ward (Day 4b): an admission, a bed's status.
  updateBedStatusInDB: { sheets: ['Master_Beds', 'IP_Admissions'], watch: true },
  // IP charts (Day 4b).
  saveIPDiabeticEntry: ['IP_Diabetic_Chart'], voidIPDiabeticEntry: { sheets: ['IP_Diabetic_Chart'], watch: true },
  saveOTRecord: { sheets: ['IP_OT_Records'], watch: true },
  saveMLCRecord: { sheets: ['MLC_Register', 'IP_Admissions'], watch: true },
  // Mother & child, visiting consultants (Day 4b).
  mcOpenAntenatal: ['ANC_Register'], mcCloseAntenatal: { sheets: ['ANC_Register'], watch: true }, mcRecordAntenatalVisit: ['ANC_Visits', 'ANC_Register'],
  mcRecordImmunisation: ['Immunisation_Given'], mcMarkDoseNotGiven: ['Immunisation_Given'],
  mcRecordScan: ['ANC_Scans'], mcVoidScan: { sheets: ['ANC_Scans'], watch: true }, mcRedateToScan: ['ANC_Register'],
  mcRecordChecklist: ['ANC_Checklist'], mcVoidChecklist: { sheets: ['ANC_Checklist'], watch: true }, mcSetPicme: ['ANC_Register'],
  mcRecordGrowth: ['Growth_Measurements'], mcVoidGrowth: { sheets: ['Growth_Measurements'], watch: true }, mcRecordMilestones: ['Milestone_Records'],
  mcRecordUipUpToAge: ['Immunisation_Given'],
  declareVisitingConsultant: ['Visiting_Sessions', 'Doctors'], endVisitingConsultant: { sheets: ['Visiting_Sessions'], watch: true },
  // The lab (Day 6: its queues, bills and records are answered from the
  // copy). A request, a sample collected, received or rejected, results
  // entered and verified, a bill made, cancelled or settled.
  createLabRequest: ['LAB_ORDERS'],
  advanceOrderStatus: { sheets: ['LAB_ORDERS'], watch: true },
  collectLabSample: { sheets: ['LAB_ORDERS', 'LAB_SAMPLES', 'LAB_TAT_LOG'], watch: true },
  receiveLabSample: { sheets: ['LAB_ORDERS', 'LAB_SAMPLES'], watch: true },
  receiveLabSampleByBarcode: { sheets: ['LAB_ORDERS', 'LAB_SAMPLES'], watch: true },
  rejectLabSample: { sheets: ['LAB_ORDERS', 'LAB_SAMPLES'], watch: true },
  collectAndBillLabSample: { sheets: ['LAB_BILLING', 'LAB_ORDERS', 'LAB_SAMPLES', 'LAB_TAT_LOG', 'IP_Charges', LEDGER, AUDIT], watch: true },
  generateLabBill: { sheets: ['LAB_BILLING', 'LAB_ORDERS', 'IP_Charges', LEDGER, AUDIT], watch: true },
  labCancelBill: { sheets: ['LAB_BILLING', 'LAB_ORDERS', 'IP_Charges', LEDGER, AUDIT], watch: true },
  labCancelPendingOrder: { sheets: ['LAB_BILLING', 'LAB_ORDERS'], watch: true },
  settleLabBillBalance: { sheets: ['LAB_BILLING', LEDGER, AUDIT], watch: true },
  saveLabResultsDraft: { sheets: ['LAB_RESULTS', 'LAB_ORDERS'], watch: true },
  // A critical value logged (LAB_CRITICAL_COMMS) goes with them: the lab's list of values to acknowledge reads it.
  submitLabResults: { sheets: ['LAB_RESULTS', 'LAB_ORDERS', 'LAB_CRITICAL_COMMS'], watch: true },
  verifyLabResults: { sheets: ['LAB_RESULTS', 'LAB_ORDERS', 'LAB_TAT_LOG', 'LAB_CRITICAL_COMMS'], watch: true },
  // An acknowledgement edits rows in place anywhere in the (short) log: its last 600 rows re-checked,
  // or the list the lab reloads from the copy still shows the values just acknowledged.
  labAcknowledgeCritical: { sheets: ['LAB_CRITICAL_COMMS', 'LAB_RESULTS'], window: 600 },
  // The catalogue is short and edited anywhere in it: all of it re-checked.
  saveCatalogEntry: { sheets: ['LAB_TEST_CATALOG'], window: 600 },
  savePanelWithParameters: { sheets: ['LAB_TEST_CATALOG'], window: 600 },
  setCatalogActive: { sheets: ['LAB_TEST_CATALOG'], window: 600 },
  // Reports from outside labs (IP Notes' investigations, lab results).
  saveExternalLabResult: ['External_Lab_Results', 'Investigation_Orders', 'LAB_ORDERS'],
  voidExternalLabResult: { sheets: ['External_Lab_Results', 'Investigation_Orders', 'LAB_ORDERS'], watch: true },
  // The IP case sheet and the discharge summary desk.
  saveIPCasesheet: { sheets: ['IP_CaseSheets_DB', 'IP_Timeline_DB', 'IP_Pharmacy_Queue', 'Clinical_Templates', 'IP_Admissions'], watch: true },
  amendIPCasesheet: { sheets: ['IP_CaseSheets_DB', 'IP_Timeline_DB', 'IP_Pharmacy_Queue'], watch: true },
  ds_initiateDischarge: { sheets: ['DS_Summaries', 'DS_Snapshots', 'DS_Working', 'DS_Workflow_Log', 'IP_Admissions'], watch: true },
  ds_saveWorking: { sheets: ['DS_Summaries', 'DS_Working', 'DS_Workflow_Log'], watch: true },
  ds_regenerate: { sheets: ['DS_Summaries', 'DS_Snapshots', 'DS_Working', 'DS_Workflow_Log'], watch: true },
  ds_submit: { sheets: ['DS_Summaries', 'DS_Snapshots', 'DS_Working', 'DS_Workflow_Log'], watch: true },
  ds_return: { sheets: ['DS_Summaries', 'DS_Workflow_Log'], watch: true },
  ds_sign: { sheets: ['DS_Summaries', 'DS_Snapshots', 'DS_Working', 'DS_Workflow_Log', 'IP_Admissions', 'IP_Timeline_DB'], watch: true },
  ds_startAmendment: { sheets: ['DS_Summaries', 'DS_Working', 'DS_Workflow_Log'], watch: true },
  ds_discardAmendment: { sheets: ['DS_Summaries', 'DS_Working', 'DS_Workflow_Log'], watch: true },
  ds_cancel: { sheets: ['DS_Summaries', 'DS_Workflow_Log', 'IP_Admissions'], watch: true },
  // Consent and nominees (the patient portal and the privacy console).
  recordConsent: { sheets: ['Consent_Register', 'Patients'], watch: true }, withdrawConsent: { sheets: ['Consent_Register'], watch: true },
  recordNomination: ['Nomination_Register'], revokeNomination: { sheets: ['Nomination_Register'], watch: true },
  // The privacy console (group K): data requests, breaches, consent asked as a
  // document is sent or backfilled; a reminder marked sent.
  raiseDPDPRequest: ['DPDP_Requests'], dpdpVerifyRequester: { sheets: ['DPDP_Requests'], watch: true },
  closeDPDPRequest: { sheets: ['DPDP_Requests'], watch: true }, dpdpRaiseBreach: ['Breach_Register'],
  dpdpAssessBreach: { sheets: ['Breach_Register'], watch: true }, recordDispatchConsent: { sheets: ['Consent_Register', 'Patients'], watch: true },
  dpdpBackfillConsent: { sheets: ['Consent_Register', 'Patients'], watch: true }, markReminderSent: ['Reminder_Log'],
  // A backup taken from Operations (Drive: Apps Script's): its line in the log, for the Backups tab's reload.
  runBackupNow: ['Backup_Log'],
  // the new screens' saves
  audRequest: ['Audio_Requests'],
  audSave: { sheets: ['Audiograms', 'Audio_Requests'], watch: true },
  audVoid: { sheets: ['Audiograms', 'Audio_Requests'], watch: true },
  // the new screens' saves
  ivfSaveCouple: { sheets: ['IVF_Couples'], watch: true },
  ivfSaveCycle: { sheets: ['IVF_Cycles'], watch: true },
  ivfAddScan: ['IVF_Scans'],
  ivfVoidScan: { sheets: ['IVF_Scans'], watch: true },
  saveConsent: { sheets: ['Consent_Records'], watch: true }, markConsent: { sheets: ['Consent_Records'], watch: true },
  saveConsentWording: { sheets: ['Consent_Text', 'Consent_Approvals'], watch: true },
  ivfSaveCryo: { sheets: ['IVF_Cryo'], watch: true }
};

/**
 * Writes made on screens not moved yet (pharmacy, lab and hospital billing,
 * the ward's case sheet and discharge summary) that change what the screens
 * answered from the copy show — a counter's cash drawer, the bills owed, an
 * inpatient's running bill and notes. Their sheets are copied straight after
 * the answer has gone back (in the background: the person does not wait for
 * it), so the drawer or the bill opened next shows them; the every-minute
 * sync would get there within a minute anyway.
 */
export const FLUSH_SOON = {
  // None left since Day 6: every screen whose sheets a write changes is
  // answered from the copy, so every such write copies before it answers
  // (FLUSH_AFTER). Kept for a write that may wait a moment.
};

export const execUrl = (env) => String((env && (env.APP_EXEC_URL || env.APP_EXEC_URL_DEFAULT)) || '').trim();
export const hasApp = (env) => EXEC_RE.test(execUrl(env));

// ---------------------------------------------------------------------------
// /rpc
// ---------------------------------------------------------------------------

export async function rpc(request, env, ctx, supabase) {
  if (request.method !== 'POST') return json({ ok: false, e: 'Method not allowed.' }, 405);
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ ok: false, e: 'Not allowed from another site.' }, 403);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_RPC_BYTES) return json({ ok: false, e: 'That request is too large.' }, 413);
  // THE CPU BUDGET. On Cloudflare's free plan a request may use 10 ms of
  // CPU, and one that goes over takes down every request running in the
  // same isolate with it (the browser sees "Failed to fetch"). So a call
  // passed to Apps Script is never decoded or parsed here: its bytes go
  // through as they came, and so does the answer. Only the function's name
  // is read, from the first bytes of the body ({"fn":"…","args":…}, as the
  // page's stand-in for google.script.run sends it).
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_RPC_BYTES) return json({ ok: false, e: 'That request is too large.' }, 413);
  const fn = fnOf(bytes);

  let why = '';
  if (EDGE[fn] && edgeOn(env, fn)) {
    try {
      const call = JSON.parse(new TextDecoder().decode(bytes));   // small: a name and a few ids
      const args = Array.isArray(call && call.args) ? call.args : [];
      const v = await EDGE[fn](args, env, ctx, supabase, request);
      if (v instanceof Response) return v;
      if (v === NULL) return json({ ok: true, v: null }, 200, { 'X-CresRx-Source': 'supabase' });
      if (v) return json({ ok: true, v }, 200, { 'X-CresRx-Source': 'supabase' });
      why = 'not answered here';
    } catch (e) {
      // The reason goes to the browser: never an error's own text (it can quote data).
      why = e instanceof Unsure ? e.message : 'an error here (see the Worker\'s log)';
      if (!(e instanceof Unsure)) console.error('edge ' + fn + ' fell back to Apps Script:', e && e.message);
    }
  } else if (EDGE[fn]) {
    why = 'switched off (EDGE_OFF)';
  }
  // A save the Edge Function makes (Phase W): written to Supabase, then
  // into the Sheet by Apps Script straight after (drainSoon). Refused, with
  // nothing written: Apps Script makes it, as before.
  if (WRITER.has(fn)) {
    if (edgeOn(env, fn) && edgeOn(env, 'writes') && edgeOn(env, 'runner')) {
      const r = await viaSaver(env, bytes, crypto.randomUUID());
      if (r instanceof Response) {
        later(ctx, 'drain after ' + fn, drainSoon(env));
        return new Response(r.body, { status: 200, headers: secure({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'X-CresRx-Source': 'supabase', 'X-CresRx-Via': 'saved in Supabase', 'X-CresRx-Runs': r.headers.get('X-CresRx-Runs') || '',
          'X-CresRx-Ms': r.headers.get('X-CresRx-Ms') || '', 'X-CresRx-Load-Ms': r.headers.get('X-CresRx-Load-Ms') || '',
          'X-CresRx-Reused': r.headers.get('X-CresRx-Reused') || '', 'X-CresRx-Wrote': r.headers.get('X-CresRx-Wrote') || '' }) });
      }
      if (r && 'answer' in r) {
        // Made, its answer lost on the way: the log's copy of it.
        later(ctx, 'drain after ' + fn, drainSoon(env));
        return json({ ok: true, v: r.answer === undefined ? null : r.answer }, 200, { 'X-CresRx-Source': 'supabase', 'X-CresRx-Via': 'saved in Supabase (answer from its log)' });
      }
      if (r && r.unsure) {
        // Never made twice: the person is told to look first.
        return json({ ok: false, e: 'The save could not be confirmed. Please check whether it was saved before saving again.' }, 200,
                    { 'X-CresRx-Why': 'the save could not be confirmed' });
      }
      why = r.why;
    } else why = 'switched off (EDGE_OFF)';
  }
  // The app's own code on the copy: a read only it serves, or one the
  // Worker's port leaves (an admitted patient's timeline).
  if (RUNNER.has(fn) && (!EDGE[fn] || (why && why !== 'switched off (EDGE_OFF)'))) {
    if (edgeOn(env, fn) && edgeOn(env, 'runner')) {
      const r = await viaRunner(env, bytes);
      if (r instanceof Response) {
        const at = r.headers.get('X-CresRx-Refresh');
        if (at !== null) refreshSoon(bytes, Number(at), env, ctx);
        return new Response(r.body, { status: 200, headers: secure({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'X-CresRx-Source': 'supabase', 'X-CresRx-Via': 'app code on Supabase', 'X-CresRx-Runs': r.headers.get('X-CresRx-Runs') || '',
          // Where the time went inside the Edge Function (the badge shows it).
          'X-CresRx-Ms': r.headers.get('X-CresRx-Ms') || '', 'X-CresRx-Load-Ms': r.headers.get('X-CresRx-Load-Ms') || '',
          'X-CresRx-Reused': r.headers.get('X-CresRx-Reused') || '' }) });
      }
      why = r.why;
    } else why = 'switched off (EDGE_OFF)';
  }
  if (fn === 'crescLogSignOut') await forget(bytes);
  let out = FLUSH_AFTER[fn] ? withFlush(bytes, FLUSH_AFTER[fn]) : bytes;
  // Saves made in Supabase not in the Sheet yet: Apps Script writes them in
  // first (doPost "drain"), so this call sees them as if made there.
  if (await savesWaiting(env)) out = withDrain(out);
  const answer = await forward(env, out, why);
  if (FLUSH_SOON[fn] && ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(flushSoon(env, FLUSH_SOON[fn]));
  return answer;
}

/**
 * Asks Apps Script to copy these sheets now (FLUSH_SOON), on a call of its
 * own after the write's answer has gone back: the build check, which needs no
 * session and changes nothing, carrying the flush.
 */
const FLUSH_CARRIER = new TextEncoder().encode('{"fn":"getAppBuild","args":[]}');
async function flushSoon(env, spec) {
  try {
    const r = await fetch(execUrl(env), { method: 'POST', body: withFlush(FLUSH_CARRIER, spec), headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
    if (r.body) await r.body.cancel();
  } catch (e) { /* the every-minute sync copies it */ }
}

/**
 * Asks Apps Script to write the saves made in Supabase into the Sheet now
 * (doPost "drain", sbDrainEdgeWrites_), on a call of its own after the
 * save's answer has gone: the build check, carrying the drain.
 */
const DRAIN_CARRIER = new TextEncoder().encode('{"fn":"getAppBuild","args":[],"drain":true}');
async function drainSoon(env) {
  try {
    const r = await fetch(execUrl(env), { method: 'POST', body: DRAIN_CARRIER, headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
    if (r.body) await r.body.cancel();
  } catch (e) { /* the every-minute tick writes them */ }
}

/** The same body with "drain": true added before its closing brace, without parsing it. */
export function withDrain(bytes) {
  let end = bytes.length - 1;
  while (end >= 0 && bytes[end] !== 0x7d) end--;
  if (end < 0) return bytes;
  const tail = new TextEncoder().encode(',"drain":true}');
  const out = new Uint8Array(end + tail.length);
  out.set(bytes.subarray(0, end), 0);
  out.set(tail, end);
  return out;
}

/** The answer "null" from the Worker itself (an EDGE handler's null means "ask Apps Script"). */
const NULL = Object.freeze({ null: true });

/** The function's name from the start of the body, or ''. */
export function fnOf(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 160));
  const m = /^\s*\{\s*"fn"\s*:\s*"([A-Za-z$_][\w$]{0,80})"/.exec(head);
  return m ? m[1] : '';
}

/**
 * The same body with "flush": [...] added before its closing brace, without
 * parsing it. `spec` is the sheets, or {sheets, window, watch}
 * (Supabase_Mirror.gs sbFlush_).
 */
export function withFlush(bytes, spec) {
  let end = bytes.length - 1;
  while (end >= 0 && bytes[end] !== 0x7d) end--;                 // the last '}'
  if (end < 0) return bytes;
  const sheets = Array.isArray(spec) ? spec : spec.sheets;
  const opts = Array.isArray(spec) ? null : { window: spec.window, watch: spec.watch === true };
  const tail = new TextEncoder().encode(',"flush":' + JSON.stringify(sheets) + (opts ? ',"flushOpts":' + JSON.stringify(opts) : '') + '}');
  const out = new Uint8Array(end + tail.length);
  out.set(bytes.subarray(0, end), 0);
  out.set(tail, end);
  return out;
}

/** The call to the deployment's doPost, its answer back unchanged and unread. */
async function forward(env, body, why) {
  const extra = why ? { 'X-CresRx-Why': String(why).replace(/[^\x20-\x7e]/g, '').slice(0, 160) } : {};
  let res;
  // Apps Script answers a POST with a redirect to the result; fetch follows
  // it (as a GET, which is what Google expects).
  const call = () => fetch(execUrl(env), { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
  // Google's sign-in page itself (not any page of Google's: its error pages
  // carry a sign-in link too).
  const SIGN_IN = /ServiceLogin|accounts\.google\.com\/(?:v3\/)?signin|<title>[^<]*sign in/i;
  let early = null;
  try {
    res = await call();
    // Just after a new version is deployed Google can answer for a moment
    // with its sign-in page instead of running the script: the call was not
    // made, so it is tried once more a second later. (Any other page is not
    // retried: a save may have run.)
    if (!/json/i.test(res.headers.get('Content-Type') || '')) {
      early = await res.text();
      if (!/^\s*\{/.test(early) && SIGN_IN.test(early)) {
        await new Promise((r) => setTimeout(r, 1000));
        res = await call();
        early = null;
      }
    }
  } catch (e) {
    return json({ ok: false, e: 'The app server could not be reached. Please try again.' }, 502);
  }
  // doPost answers JSON (ContentService); anything else is Google's own
  // page (a sign-in, an error) and is read only to say which.
  if (/json/i.test(res.headers.get('Content-Type') || '')) {
    return new Response(res.body, { status: 200, headers: secure(Object.assign({ 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-CresRx-Source': 'apps-script' }, extra)) });
  }
  const out = early !== null ? early : await res.text();
  if (/^\s*\{/.test(out)) {
    return new Response(out, { status: 200, headers: secure(Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-CresRx-Source': 'apps-script' }, extra)) });
  }
  return json({ ok: false, e: SIGN_IN.test(out)
    ? 'The app server asks for a Google sign-in: set the deployment\'s access to "Anyone" and deploy again.'
    : 'The app server gave no answer (deploy the latest version of the app). Status ' + res.status + '.' }, 502);
}

/** One server call to Apps Script from here, its value or null. */
async function appsScript(env, fn, args) {
  const res = await fetch(execUrl(env), { method: 'POST', body: JSON.stringify({ fn, args }),
                                          headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
  const t = await res.text();
  if (!/^\s*\{/.test(t)) return null;
  const o = JSON.parse(t);
  return o && o.ok ? o.v : null;
}

/**
 * One server call to Apps Script whose answer is not wanted here: a refresh
 * that leaves its result in Supabase. Its reply is not read (a screen bundle
 * is hundreds of kilobytes: parsing it would spend the CPU allowance).
 */
async function appsScriptQuietly(env, fn, args) {
  const res = await fetch(execUrl(env), { method: 'POST', body: JSON.stringify({ fn, args }),
                                          headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
  try { if (res.body) await res.body.cancel(); } catch (e) { /* nothing to read */ }
}

/** Runs after the answer has gone, for as long as Cloudflare allows. */
function later(ctx, what, promise) {
  const p = promise.catch((e) => console.error(what + ':', e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

// Plain values only: one request may not wait on another's I/O in Workers.
const MEMO = new Map();         // hash -> {id, until}: this instance's copy, for IDENTITY_MEMO_MS
const REFRESHED = new Map();    // hash -> when this instance last asked Apps Script to re-check it

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const tokenHash = (token) => sha256('cresrx-session:' + token);

/** getEdgeIdentity's answer, as the Worker keeps it. */
function normal(v) {
  return { username: String(v.username || ''), role: String(v.role || '').toLowerCase(), doctorId: String(v.doctorId || ''),
           dutyMoIds: Array.isArray(v.dutyMoIds) ? v.dutyMoIds.map(String) : [], edge: v.edge === true,
           permissions: Array.isArray(v.permissions) ? v.permissions.map(String) : [],
           actor: v.actor && typeof v.actor === 'object' ? v.actor : null,
           uiHidden: v.uiHidden && typeof v.uiHidden === 'object' ? v.uiHidden : {},
           // Added with the sessions kept in Supabase; an older Apps Script
           // leaves them out, and the screens that need them go to it.
           uiHiddenAll: Array.isArray(v.uiHiddenAll) ? v.uiHiddenAll.map(String) : undefined,
           displayName: v.displayName === undefined ? undefined : String(v.displayName || ''),
           tenants: Array.isArray(v.tenants) ? v.tenants.map(String) : undefined,
           monthFirst: v.monthFirst === true,
           ...('visiting' in v ? { visiting: v.visiting && typeof v.visiting === 'object' ? v.visiting : null } : {}) };
}

/**
 * The session's identity, or null. From Supabase (mirror.sessions, stored by
 * Apps Script under a hash of the token) when it is there; when it was stored
 * more than IDENTITY_REFRESH_MS ago, Apps Script re-checks it in the
 * background, which keeps both sides' "last seen" moving. Not there (signed
 * in before this version, or the account changed since): Apps Script is
 * asked (getEdgeIdentity), and stores it for next time.
 */
export async function identity(token, env, ctx, supabase) {
  token = String(token || '');
  if (!token || token.length > 200) return null;
  const h = await tokenHash(token);
  const now = Date.now();
  const m = MEMO.get(h);
  if (m && m.until > now) return m.id;
  let id = null;
  if (supabase) {
    try {
      const row = await supabase('session_get', { hash: h });
      if (row && row.identity && typeof row.identity === 'object') {
        id = normal(row.identity);
        if (Number(row.age) > IDENTITY_REFRESH_MS && !((REFRESHED.get(h) || 0) > now - 60000)) {
          REFRESHED.set(h, now);
          later(ctx, 'session refresh', appsScriptQuietly(env, 'getEdgeIdentity', [token]));
        }
      }
    } catch (e) { console.error('session_get:', e && e.message); }
  }
  if (!id) {
    const v = await appsScript(env, 'getEdgeIdentity', [token]);
    if (!v || !v.success) return null;
    id = normal(v);
  }
  if (MEMO.size > 500) MEMO.clear();
  if (REFRESHED.size > 500) REFRESHED.clear();
  MEMO.set(h, { id, until: Date.now() + IDENTITY_MEMO_MS });
  return id;
}

/**
 * The Edge Function answered from a session stored over IDENTITY_REFRESH_MS
 * ago: Apps Script re-checks it after the answer has gone, as identity() has
 * it do for the calls answered here. `at`: which argument is the token.
 */
function refreshSoon(bytes, at, env, ctx) {
  let token = '';
  try { token = String((JSON.parse(new TextDecoder().decode(bytes)).args || [])[at] || ''); } catch (e) { return; }
  if (!token || token.length > 200) return;
  later(ctx, 'session refresh', (async () => {
    const h = await tokenHash(token), now = Date.now();
    if ((REFRESHED.get(h) || 0) > now - 60000) return;
    if (REFRESHED.size > 500) REFRESHED.clear();
    REFRESHED.set(h, now);
    await appsScriptQuietly(env, 'getEdgeIdentity', [token]);
  })());
}

/** The caller of a call the Worker answers, or Unsure (Apps Script answers). */
async function caller(token, env, ctx, supabase) {
  const who = await identity(token, env, ctx, supabase);
  if (!who) throw new Unsure('session not known here');
  if (!who.edge) throw new Unsure('Supabase reads are off');
  return who;
}

/** Sign-out: this instance forgets the session at once (Apps Script removes it from Supabase). */
async function forget(bytes) {
  try {
    const call = JSON.parse(new TextDecoder().decode(bytes));
    const token = String((call && call.args && call.args[0]) || '');
    if (token) MEMO.delete(await tokenHash(token));
  } catch (e) { /* nothing remembered */ }
}

// ---------------------------------------------------------------------------
// The Daily Ledger from Supabase
// ---------------------------------------------------------------------------

/**
 * fetchDailyLedgerScoped(dateStr, doctorId, sessionToken) answered from the
 * copy, or null for Apps Script to answer: a date not in yyyy-MM-dd, a
 * session it does not know, the copy switched off, a sheet not in the copy.
 */
export async function edgeLedger(args, env, ctx, supabase) {
  const t0 = Date.now();
  const [dateStr, doctorId, token] = args;
  const date = dayKey(dateStr);
  if (!date) return null;
  const who = await caller(token, env, ctx, supabase);
  const res = await supabase('mirror_query', { queries: sessionLedgerQueries(date) });
  const [doctorsRes, appointments, patients] = (res && res.results) || [];
  if (!doctorsRes || !doctorsRes.found || !appointments || !appointments.found || !patients || !patients.found) return null;
  const doctors = doctorsFrom(doctorsRes, who.dutyMoIds.map((x) => x.toUpperCase()));
  const scope = resolveScope({ username: who.username, role: who.role, doctorId: who.doctorId }, doctors, doctorId == null ? '' : String(doctorId));
  const out = buildLedger({ appointments, patients, doctors, scope, dateKey: date });
  out.edge = { ms: Date.now() - t0, syncedAt: appointments.synced_at || null };
  return out;
}

// ---------------------------------------------------------------------------
// Patients from Supabase (src/patients.js)
// ---------------------------------------------------------------------------

/**
 * One of Apps Script's patient reads answered from the copy, or null for
 * Apps Script to answer. The order is the original's: who is asking and
 * whether they may (crescRequire_: the permission must be among the
 * session's), the answer, then the audit entry (dpdpLogRead_) — written to
 * Supabase before the answer goes back, and if it cannot be written, Apps
 * Script answers (and audits) instead.
 */
async function patientRead(token, permission, env, ctx, supabase, queries, port, audit) {
  const who = await caller(token, env, ctx, supabase);
  if (!who.actor || !who.permissions.includes(permission)) throw new Unsure('no ' + permission + ': Apps Script refuses');
  const res = await supabase('mirror_query', { queries });
  const v = port((res && res.results) || []);
  if (v === null || v === undefined) return null;
  if (audit) {
    await supabase('edge_log_read', { actor: who.actor, what: audit.what, entityId: audit.id, details: { endpoint: audit.endpoint } });
  }
  return v;
}

// ---------------------------------------------------------------------------
// Ready-made answers kept in Supabase (src/snapshots.js): the Command Center,
// screen bundles, the build check, the consent notice
// ---------------------------------------------------------------------------

const DASH_FRESH_MS = 60 * 1000;          // older than this: Apps Script computes a new one, in the background
const DASH_FRESH_ASKED_MS = 15 * 1000;    // …or this, when the screen was opened or Refresh pressed
const BUNDLE_FRESH_MS = 3 * 60 * 1000;    // a screen bundle is re-read from Apps Script after this
const BUILD_FRESH_MS = 5 * 60 * 1000;
const NOTICE_FRESH_MS = 10 * 60 * 1000;
const CLINIC_FRESH_MS = 10 * 60 * 1000;

/**
 * A stored answer, `make(dataText, age)` turning it into the reply; or null
 * when there is none. Older than `freshMs`: served all the same, and Apps
 * Script asked — by one caller, whoever claims it first — to store a new one
 * (`refresh`), after the answer has gone.
 */
async function stored(key, freshMs, refresh, ctx, supabase, make, refuse) {
  const snap = splitSnapshot(await supabase('snapshot_get', { key }, true));
  if (!snap) return null;
  const no = refuse && refuse(snap);
  if (no) throw new Unsure(no);
  const age = Math.max(0, Date.now() - snap.made);
  if (age > freshMs) {
    later(ctx, 'refresh ' + key, supabase('snapshot_claim', { key, ms: freshMs }).then((mine) => {
      if (mine === true) return refresh();
    }));
  }
  return raw(make(snap.dataText, age, snap), { 'X-CresRx-Source': 'supabase', 'X-CresRx-Age': String(Math.round(age / 1000)) });
}
const plain = (dataText) => '{"ok":true,"v":' + dataText + '}';
const notYet = () => { throw new Unsure('not stored yet'); };

/**
 * getDashboardData(role, bust, sessionToken) — Admin_Dashboard_Logic.gs.
 * Every load, Refresh included, is answered at once from the answer Apps
 * Script last left in Supabase, and a new one is computed in the background
 * when that is over a minute old (15 s when the screen was just opened or
 * Refresh pressed). The answer says how old it is (`age`, seconds), and the
 * screen looks again once the new one should be ready. Same permission
 * (dashboard.read), same split of who sees money (accounts.read), same cards
 * taken out per person (crescUiRedact_). Only a copy from an earlier day is
 * left to Apps Script: "today" must mean today.
 */
async function dashboard([role, bust, token], env, ctx, supabase) {
  const who = await caller(token, env, ctx, supabase);
  if (!who.permissions.includes('dashboard.read')) throw new Unsure('no dashboard.read: Apps Script refuses');
  const key = 'dash:' + (who.permissions.includes('accounts.read') ? 'FIN' : 'CLIN');
  const freshMs = bust === true ? DASH_FRESH_ASKED_MS : DASH_FRESH_MS;
  const out = await stored(key, freshMs, () => appsScriptQuietly(env, 'getDashboardData', [role, true, token]), ctx, supabase,
    (dataText, age) => {
      const tail = ',"message":"snapshot","age":' + Math.round(age / 1000) + '}}';
      if (hiddenFor(who.uiHidden, 'dash.').length) {
        const data = redact(JSON.parse(dataText), who.uiHidden, 'dash.');
        return '{"ok":true,"v":{"success":true,"data":' + JSON.stringify(data) + tail;
      }
      // Nobody's cards to take out: the stored text goes on as it is.
      return '{"ok":true,"v":{"success":true,"data":' + dataText + tail;
    },
    (snap) => (istDay(snap.made) !== istDay(Date.now()) ? 'the stored copy is from an earlier day' : ''));
  if (!out) throw new Unsure('no stored copy yet');
  return out;
}

/** An answer already in the shape the page expects ({ok, v}), sent as it is. */
function raw(text, headers) {
  return new Response(text, { status: 200, headers: secure(Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers)) });
}

/** The build of the page asking (the cookie shell() sets), or ''. */
function pageBuild(request) {
  const m = /(?:^|;\s*)cresrx_build=([0-9a-f]{6,32})(?:;|$)/.exec((request && request.headers.get('Cookie')) || '');
  return m ? m[1] : '';
}

/**
 * One of the calls every page makes with no session (runner.js PUBLIC),
 * answered by the Edge Function from its own .gs and .html files: no Apps
 * Script, and nothing stored to go stale. `fits(res)`: whether its answer
 * suits this page (its build). null when it cannot answer, or it does not
 * fit: the stored copy, then Apps Script, as before.
 */
async function fromEdge(env, fn, args, fits) {
  if (!PUBLIC.has(fn) || !edgeOn(env, fn) || !edgeOn(env, 'runner')) return null;
  const r = await viaRunner(env, new TextEncoder().encode(JSON.stringify({ fn, args })));
  if (!(r instanceof Response)) return null;
  if (fits && !fits(r)) {
    try { if (r.body) await r.body.cancel(); } catch (e) { /* nothing to read */ }
    return null;
  }
  return new Response(r.body, { status: 200, headers: secure({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-CresRx-Source': 'supabase', 'X-CresRx-Via': 'app code on Supabase', 'X-CresRx-Ms': r.headers.get('X-CresRx-Ms') || '' }) });
}

/**
 * crescGetBundle(name) — Module_Loader.gs. A screen's markup, the same for
 * everyone on one deployment: made by the Edge Function from the same .html
 * files its page was made from (when the page's build is the Edge Function's
 * build — every page this Worker serves from it). A page Apps Script made
 * (another build): the copy kept in Supabase per build of the page and per
 * bundle, re-read from Apps Script every few minutes while in use; the first
 * person on such a build gets it from Apps Script, which stores it.
 */
async function bundle([name], env, ctx, supabase, request) {
  const n = String(name || '').trim();
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(n)) throw new Unsure('an unusual bundle name');
  // The screen opening will read these tabs next: the Edge Function loads them now.
  if (edgeOn(env, 'runner')) later(ctx, 'warm ' + n, warmRunner(env, n));
  const mine = pageBuild(request);
  const made = await fromEdge(env, 'crescGetBundle', [n], (r) => !mine || r.headers.get('X-CresRx-Shell-Build') === mine);
  if (made) return made;
  // The page's build (its cookie), else the build deployed now (the build
  // check Apps Script stores): a page open in a tab longer than its cookie
  // lives still gets its screens from here. Apps Script serves the deployed
  // build's markup whatever build the page is, so it is the same answer.
  const build = mine || await deployedBuild(supabase);
  if (!build) throw new Unsure('the page\'s build is not known');
  const hit = await stored('bundle:' + build + ':' + n, BUNDLE_FRESH_MS,
    () => appsScriptQuietly(env, 'crescGetBundle', [n, build]), ctx, supabase, plain);
  if (hit) return hit;
  return forward(env, new TextEncoder().encode(JSON.stringify({ fn: 'crescGetBundle', args: [n, build] })), 'not stored yet');
}

/**
 * The page this Worker serves now, as its cache holds it: where it was made
 * ('edge' or 'apps-script') and its build; null when this place has none.
 */
async function servedShell(request) {
  try {
    const hit = await caches.default.match(new Request(new URL(request.url).origin + '/__shell__', { method: 'GET' }));
    if (!hit) return null;
    const out = { from: hit.headers.get('X-Shell-From') || 'apps-script', build: hit.headers.get('X-Shell-Build') || '' };
    try { if (hit.body) await hit.body.cancel(); } catch (e) { /* not read */ }
    return out;
  } catch (e) { return null; }
}

/** The build deployed now, as Apps Script last stored it (getAppBuild), or ''. */
async function deployedBuild(supabase) {
  try {
    const snap = splitSnapshot(await supabase('snapshot_get', { key: 'build' }, true));
    const m = snap && /"build"\s*:\s*"([0-9a-f]{6,32})"/.exec(snap.dataText);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

/** The calls the Worker answers itself, by the name the page calls them. */
export const EDGE = {
  fetchDailyLedgerScoped: edgeLedger,
  getDashboardData: dashboard,
  // getAllPatients(sessionToken) — CodeMV.gs
  getAllPatients: ([token], env, ctx, sb) => patientRead(token, 'patient.read', env, ctx, sb, registerQuery(),
    ([r]) => allPatients(r), { what: 'PatientRegister', id: 'ALL', endpoint: 'getAllPatients' }),
  // getMasterPatientDirectory(sessionToken) — EMR_MasterTimeline_Logic.gs
  getMasterPatientDirectory: ([token], env, ctx, sb) => patientRead(token, 'patient.read', env, ctx, sb, registerQuery(),
    ([r]) => masterDirectory(r), { what: 'PatientRegister', id: 'ALL', endpoint: 'getMasterPatientDirectory' }),
  // getPatientDemographics(patientId, sessionToken) — Appointment.gs
  getPatientDemographics: ([patientId, token], env, ctx, sb) => patientRead(token, 'patient.read', env, ctx, sb,
    demographicsQuery(patientKey(patientId)), ([r]) => demographics(r, patientId), null),
  // buildLongitudinalTimeline(patientId, sessionToken) — EMR_MasterTimeline_Logic.gs
  buildLongitudinalTimeline: ([patientId, token], env, ctx, sb) => patientRead(token, 'emr.read', env, ctx, sb,
    timelineQuery(patientKey(patientId)), (rs) => timeline(rs, patientId),
    { what: 'Patient', id: String(patientId || ''), endpoint: 'buildLongitudinalTimeline' }),
  // getUserProfile(patientId, sessionToken) — CodeMV.gs: any signed-in staff; a patient only themselves
  getUserProfile: async ([patientId, token], env, ctx, sb) => {
    const who = await caller(token, env, ctx, sb);
    const want = patientKey(patientId);
    if (!want) return NULL;
    const res = await sb('mirror_query', { queries: profileQuery(want) });
    const v = userProfile(who, want, (res && res.results) || []);
    return v === null ? NULL : v;
  },

  // Signing in, and what every screen asks first.
  // crescGetMyPermissions(token) — RBAC.gs
  crescGetMyPermissions: async ([token], env, ctx, sb) => myPermissions(await caller(token, env, ctx, sb)),
  // crescTouchSession(token) — Doctor_Session_Store.gs ("stay signed in")
  crescTouchSession: async ([token], env, ctx, sb) => touchSession(await caller(token, env, ctx, sb)),
  // getDoctorPickerContext(token) — Doctor_Core.gs
  getDoctorPickerContext: async ([token], env, ctx, sb) => {
    const who = await caller(token, env, ctx, sb);
    const res = await sb('mirror_query', { queries: pickerQuery() });
    return doctorPicker(who, (res && res.results) || []);
  },
  // crescGetBundle(name) — Module_Loader.gs
  crescGetBundle: bundle,
  // getClinicProfile() — Clinic_Profile.gs (no session: the letterhead printed
  // on every bill), made by the Edge Function from the settings copy; else
  // the copy Apps Script leaves, re-read every 10 minutes.
  getClinicProfile: async (args, env, ctx, sb) => (await fromEdge(env, 'getClinicProfile', [])) ||
    (await stored('clinic', CLINIC_FRESH_MS, () => appsScriptQuietly(env, 'getClinicProfile', []), ctx, sb, plain)) || notYet(),
  // getAppBuild() — App_Version.gs (no session: the build every visitor is
  // sent). The Edge Function's, while the page this Worker serves is the one
  // it made (or one of the same build); else the copy Apps Script leaves.
  getAppBuild: async (args, env, ctx, sb, request) => {
    const page = await servedShell(request);
    const made = await fromEdge(env, 'getAppBuild', [], (r) => !page || page.from === 'edge' ||
      page.build === r.headers.get('X-CresRx-Shell-Build'));
    return made || (await stored('build', BUILD_FRESH_MS, () => appsScriptQuietly(env, 'getAppBuild', []), ctx, sb, plain)) || notYet();
  },
  // getDPDPNotice() — DPDP_Compliance.gs (no session: the notice every patient
  // is shown), made by the Edge Function; else the copy Apps Script leaves.
  getDPDPNotice: async (args, env, ctx, sb) => (await fromEdge(env, 'getDPDPNotice', [])) ||
    (await stored('dpdp:notice', NOTICE_FRESH_MS, () => appsScriptQuietly(env, 'getDPDPNotice', []), ctx, sb, plain)) || notYet(),

  // Booking: a doctor's slots for a day, and weekly hours — Doctor_Schedule_Engine.gs
  getDoctorSlotsForDate: async ([doctorId, dateStr, token], env, ctx, sb) => {
    const who = await caller(token, env, ctx, sb);
    const day = slotsDay(dateStr);
    if (!day) throw new Unsure('no date');
    const res = await sb('mirror_query', { queries: slotsQuery(day) });
    return doctorSlots(who, doctorId, day, (res && res.results) || []);
  },
  getDoctorSchedule: async ([doctorId, token], env, ctx, sb) => {
    const who = await caller(token, env, ctx, sb);
    const res = await sb('mirror_query', { queries: scheduleQuery() });
    return doctorSchedule(who, doctorId, (res && res.results) || []);
  }
};

/**
 * Whether the Worker answers this call itself. EDGE_OFF (a setting) names
 * calls to leave to Apps Script, comma-separated, or "all"; EDGE_LEDGER=off
 * still works for the ledger.
 */
function edgeOn(env, fn) {
  if (!env.SUPABASE_SECRET_KEY) return false;
  const off = String(env.EDGE_OFF || '').split(/[\s,]+/).filter(Boolean);
  if (off.includes('all') || off.includes(fn)) return false;
  if (fn === 'fetchDailyLedgerScoped' && String(env.EDGE_LEDGER || '').toLowerCase() === 'off') return false;
  return true;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export async function shell(request, env, ctx) {
  const url = new URL(request.url);
  const exec = execUrl(env);

  // Patient-facing pages: as before, Google's page in a frame.
  const keep = new URLSearchParams();
  let special = false;
  for (const [k, v] of url.searchParams) {
    if (PASS_THROUGH.test(k)) { keep.append(k, v); if (k !== 'k') special = true; }
  }
  if (special) {
    return page('<iframe src="' + attr(exec + '?' + keep.toString()) + '" title="DEMO CLINIC" ' +
                'allow="camera; clipboard-write; fullscreen" allowfullscreen></iframe>', 200);
  }

  // ?v=<build> is the app's own "a newer version is available -> Reload":
  // never answered from the edge, so it cannot get the old copy back.
  const fresh = url.searchParams.has('v');
  const cache = caches.default;
  const key = new Request(url.origin + '/__shell__', { method: 'GET' });
  // The page made by the Edge Function from its own files (the same commit
  // as its reads, saves and screen bundles); Apps Script's (?shell=1) when it
  // cannot, or with EDGE_OFF=shell.
  const keepShell = async (t, from) => {
    const b = /window\.CRESC_BUILD\s*=\s*'([0-9a-f]{6,32})'/.exec(t);
    await cache.put(key, new Response(t, { headers: { 'Cache-Control': 'public, max-age=' + SHELL_KEEP_SECONDS,
                                                      'X-Shell-At': String(Date.now()), 'X-Shell-From': from, 'X-Shell-Build': b ? b[1] : '' } }));
    return t;
  };
  const load = async () => {
    if (edgeOn(env, 'shell') && edgeOn(env, 'runner')) {
      const made = await viaShell(env);
      if (made && /<html/i.test(made.html) && made.html.indexOf("window.CRESC_BUILD = '" + made.build + "'") !== -1) return keepShell(made.html, 'edge');
    }
    try {
      const r = await fetch(exec + '?shell=1', { redirect: 'follow' });
      const t = await r.text();
      if (r.ok && /<html/i.test(t) && /CRESC_BUILD/.test(t)) return keepShell(t, 'apps-script');
    } catch (e) { /* fall back below */ }
    return '';
  };
  let html = '';
  if (!fresh) {
    const hit = await cache.match(key);
    if (hit) {
      html = await hit.text();
      const at = Number(hit.headers.get('X-Shell-At') || 0);
      if (!at || Date.now() - at > SHELL_FRESH_SECONDS * 1000) ctx.waitUntil(load());
    }
  }
  if (!html) html = await load();
  if (!html) {
    // The deployment is not ready for it (older code, or access not
    // "Anyone"): the app in Google's frame, as before, rather than nothing.
    return page('<iframe src="' + attr(exec + '?t=' + Date.now()) + '" title="DEMO CLINIC" ' +
                'allow="camera; clipboard-write; fullscreen" allowfullscreen></iframe>', 200);
  }
  // TEMPORARY, while screens move off Apps Script: the status badge
  // (public/migration/status.js). Remove this line and that file when done.
  if (String(env.MIGRATION_BADGE || '').toLowerCase() !== 'off') {
    const tag = '<script src="/migration/status.js"></script>';
    const at = /<head[^>]*>/i.test(html) ? /<head[^>]*>/i : /<html[^>]*>/i;
    html = at.test(html) ? html.replace(at, (h) => h + tag) : tag + html;
  }
  const res = text(html, 200, 'text/html; charset=utf-8', 'no-store, no-cache, must-revalidate, max-age=0');
  // The build of this page (Apps Script stamps it in), so the screen bundles
  // it asks for next are the ones of the same build (crescGetBundle above).
  const b = /window\.CRESC_BUILD\s*=\s*'([0-9a-f]{6,32})'/.exec(html);
  if (b) res.headers.append('Set-Cookie', 'cresrx_build=' + b[1] + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000');
  return res;
}

/**
 * What has moved off Apps Script and what has not, for the status badge
 * (GET /api/migration). TEMPORARY, like the badge.
 */
export const MIGRATION_SCREENS = [
  { label: 'Sign-in: permissions, "stay signed in", the doctor picker', fns: ['crescGetMyPermissions', 'crescTouchSession', 'getDoctorPickerContext'], day: 'Day 2' },
  { label: 'Every screen: its bundle, the build check, the page itself (made by the Edge Function from the app\'s own files)', fns: ['crescGetBundle', 'getAppBuild'], day: 'Day 2, 6c' },
  { label: 'Appointments · Daily Ledger', fns: ['fetchDailyLedgerScoped'], day: 'Day 0' },
  { label: 'Appointments · booking: slots, weekly hours, patient details', fns: ['getDoctorSlotsForDate', 'getDoctorSchedule', 'getPatientDemographics'], day: 'Day 2' },
  { label: 'Patients · search list and profile', fns: ['getAllPatients', 'getUserProfile'], day: 'Day 1–2' },
  { label: 'Patients · registration consent notice', fns: ['getDPDPNotice'], day: 'Day 2' },
  { label: 'EMR · patient directory', fns: ['getMasterPatientDirectory'], day: 'Day 1' },
  { label: 'EMR · clinical timeline (outpatients; admitted patients still Apps Script)', fns: ['buildLongitudinalTimeline'], day: 'Day 1' },
  { label: 'Command Center (every load, Refresh included)', fns: ['getDashboardData'], day: 'Day 2' },
  { label: 'Finance Hub: Master Ledger, dashboard, receivables, drawers, payables, expenses, GST, audit, insurance, IP charges and discharge (the app\'s own code on Supabase)',
    fns: ['getAccountsDashboard', 'getFinanceDashboard', 'getReceivables', 'getAllDrawerStates', 'getShiftState', 'getPayables',
          'getExpenseRegister', 'getTaxSummary', 'getAuditLog', 'getInsuranceClaims', 'getOpenAdmissions', 'getRunningTab', 'getMasterLedger'], day: 'Day 3' },
  { label: 'Operations: the day summary (its sign-in figures from Apps Script) and the backups\' log and schedule (the app\'s own code on Supabase); taking a backup and emailing the summary stay with Apps Script',
    fns: ['getDaySummary', 'getBackupStatus'], day: 'Day 6c' },
  { label: 'IP Notes: patient list, opening a patient, timeline, care team, investigations, printed notes', fns: ['getActiveIPAdmissionsForNotes', 'getIPNotesBundle', 'getIPTimeline', 'getIPLabResults', 'getIPNotesPrintHtml'], day: 'Day 3' },
  { label: 'OP consultation: composer, last visit, allergies, templates, drug and test lists, safety check, doses, printed prescription', fns: ['getComposerContext', 'getLastVisitRecall', 'getPatientAllergies', 'fetchOPDrugMaster', 'checkRxSafety', 'suggestPaediatricDose', 'getOPPrescriptionHtml'], day: 'Day 3' },
  { label: 'Hospital Billing: patient lookup, the billing ledger, reprints, orders to bill, IP bill status, draft bill, advance receipts; the lab\'s billing ledger; the IP ledger (the app\'s own code on Supabase)',
    fns: ['hb_getBootstrap', 'hb_getPatientContext', 'hb_getInvoices', 'hb_getInvoice', 'hb_listOpenOrders', 'getIpBillingStatus',
          'getIpDraftBillHtml', 'getIpAdvanceReceipt', 'getLabLedger', 'getIPHistory', 'getAdmissionDetail'], day: 'Day 4' },
  { label: 'Ward, bed map, IP charts and records, mother & child, MLC, outside labs, stock alerts, availability grid (the app\'s own code on Supabase)',
    fns: ['getActiveIPWard', 'getWardBedBoard', 'getBedStatuses', 'getIPDiabeticChart', 'getIPRecordsLedger', 'mcGetAntenatal', 'getMLCRegister',
          'getPatientLabResults', 'getStockAlerts', 'getDoctorAvailabilityGrid'], day: 'Day 4b' },
  { label: 'Pharmacy: billing desk, dashboard, returns, stock, purchases, supplier returns, sales, GST and Schedule H reports (the app\'s own code on Supabase)',
    fns: ['fetchBillableStock', 'fetchPharmacyInventory', 'getPatientBillingContext', 'getPharmacyDashboard', 'getPharmacyStockList',
          'getPharmacySalesAnalysis', 'getPharmacyGstSummary', 'getPharmacyPurchases', 'getSupplierReturns'], day: 'Day 5' },
  { label: 'Lab: queues, orders, result entry, collection, labels, catalogue, reports, bills, billing, records (the app\'s own code on Supabase)',
    fns: ['getLabWorkspaceData', 'getLabOrderPanel', 'buildResultEntrySheet', 'getLabCatalog', 'getLabReportHtml', 'getLabBillingWorkspace', 'searchLabRecords'], day: 'Day 6' },
  { label: 'Discharge desk, IP case sheet, admitted patients\' timelines, patient portal, consent, barcodes (the app\'s own code on Supabase)',
    fns: ['ds_getQueue', 'ds_getSummary', 'getIPCasesheetContext', 'buildLongitudinalTimeline', 'portalHome', 'getConsentStatus', 'resolveScan'], day: 'Day 6' },
  { label: 'Pharmacy disposal register; Command Center access overview; privacy console: consent queue, summary, breach notice (the app\'s own code on Supabase)',
    fns: ['getDisposalLog', 'crescGetAccessOverview', 'crescUserAdminScope', 'dpdpConsentQueue', 'dpdpConsoleSnapshot', 'dpdpBreachNotice'], day: 'Day 6c' },
  { label: 'Finance Hub · claim tracker: the ledger a page at a time, one claim opened (the app\'s own code on Supabase)',
    fns: ['getClaimTracker', 'getClaimDetail'], day: 'Claims' },
  { label: 'Sign-in itself (password, authenticator code), staff accounts and authenticator status, the audit viewer, label printing — Apps Script', fns: [], day: 'stays' },
  { label: 'Saves, group A: bookings, check-ins, appointment status and time, patients\' profiles and allergies (made in Supabase, in the Sheet seconds later)',
    fns: ['submitNewAppointment', 'bookAppointmentScoped', 'updateAppointmentStatus', 'setAppointmentTime', 'barcodeUpdateAppointment',
          'portalBookAppointment', 'updatePatientProfile', 'savePatientAllergies'], day: 'Phase W' },
  { label: 'Saves, group B: the OP consultation, referrals, templates, prescription bundles (made in Supabase, in the Sheet seconds later)',
    fns: ['saveOPEncounterScoped', 'createOPReferral', 'respondToOPReferral', 'saveConsultTemplate', 'saveRxBundle', 'saveExamDefaults'], day: 'Phase W' },
  { label: 'Saves, group C: Hospital Billing — bills, payments, cancellations, payment modes (made in Supabase, in the Sheet seconds later)',
    fns: ['hb_saveInvoice', 'hb_recordPayment', 'hb_cancelInvoice', 'hb_changePaymentMode', 'hb_dismissOrder'], day: 'Phase W' },
  { label: 'Saves, group D: registration, doctors\' hours and leave, staff access and new accounts (made in Supabase, in the Sheet seconds later)',
    fns: ['registerPatient', 'saveDoctorSchedule', 'addScheduleException', 'setDoctorDayBlocks', 'crescSaveUserAccess', 'crescCreateStaffAccount'], day: 'Phase W' },
  { label: 'Saves, group E: the ward — admissions, transfers, discharge, beds, IP notes, care team, charts, OT and MLC records, case sheets',
    fns: ['saveNewAdmissionLedger', 'processBedTransfer', 'processPatientDischarge', 'saveIPNote', 'addIPCareTeamMember', 'saveIPCasesheet'], day: 'Phase W' },
  { label: 'Saves, group F: Finance Hub — ledger, shifts, payables, claims; the IP bill — charges, advances, settlement',
    fns: ['recordLedgerEntry', 'openShift', 'closeShift', 'recordPayable', 'payPayable', 'createManualClaim', 'addIpCharge', 'collectIpAdvance', 'settleDischarge'], day: 'Phase W' },
  { label: 'Saves, group G: the pharmacy — bills, returns, purchases, stock, supplier returns',
    fns: ['processPharmacyBill', 'processPharmacyReturn', 'savePharmacyPurchase', 'updatePharmacyStock', 'createSupplierReturn'], day: 'Phase W' },
  { label: 'Pharmacy reorder: what to order, draft orders, each medicine\'s level (Live Inventory\'s low-stock count too); its saves — a level, a supplier\'s lead time, the defaults, a draft order and its status (made in Supabase, in the Sheet seconds later; e-mailing an order stays with Apps Script)',
    fns: ['getReorderPlan', 'getPurchaseOrders', 'getPurchaseOrder', 'getReorderLevels', 'saveReorderSetting', 'saveSupplierReorderSetting',
          'saveReorderConfig', 'createPurchaseOrderDraft', 'setPurchaseOrderStatus'], day: 'Phase W' },
  { label: 'Saves, group H: the lab — orders, bills, samples, results, verification, catalogue, outside reports',
    fns: ['createLabRequest', 'generateLabBill', 'collectLabSample', 'saveLabResultsDraft', 'verifyLabResults', 'saveCatalogEntry', 'saveExternalLabResult'], day: 'Phase W' },
  { label: 'Saves, groups I and J: discharge summaries (not the signature), mother & child, consent, nominees',
    fns: ['ds_initiateDischarge', 'ds_saveWorking', 'ds_submit', 'mcOpenAntenatal', 'mcRecordImmunisation', 'recordConsent', 'recordNomination'], day: 'Phase W' },
  { label: 'Saves, group K: the privacy console — data requests, breaches, consent asked or backfilled; a reminder marked sent',
    fns: ['raiseDPDPRequest', 'dpdpVerifyRequester', 'closeDPDPRequest', 'dpdpRaiseBreach', 'dpdpAssessBreach', 'recordDispatchConsent', 'markReminderSent', 'dpdpBackfillConsent'], day: 'Day 6c' },
  { label: 'Saves, the claim tracker: a stage moved, a document ticked, a reminder noted, an insurer\'s contact, the time limits',
    fns: ['moveClaimStage', 'tickClaimDocument', 'chaseClaim', 'saveInsurerContact', 'saveClaimSla'], day: 'Claims' },
  { label: 'Saves that stay with Apps Script: passwords changed or reset, a summary signed, a visiting consultant\'s session, a month locked, a setting changed; PDFs, Drive, e-mail with attachments',
    fns: [], day: 'stays' }
];
export function migrationStatus(env) {
  const on = (f) => (EDGE[f] && edgeOn(env, f)) || (RUNNER.has(f) && edgeOn(env, f) && edgeOn(env, 'runner')) ||
    (WRITER.has(f) && edgeOn(env, f) && edgeOn(env, 'writes') && edgeOn(env, 'runner'));
  return { screens: MIGRATION_SCREENS.map((g) => ({ label: g.label, day: g.day, done: g.fns.length > 0 && g.fns.every(on) })) };
}

export function notSetUp() {
  return page('<p style="color:#cbd5e1;font:16px system-ui;padding:40px;text-align:center">' +
              'The app address is not set up on this server yet (APP_EXEC_URL).</p>', 503);
}

// ---------------------------------------------------------------------------

export function secure(h) {
  return Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Permissions-Policy': 'geolocation=(), payment=()'
  }, h);
}
export function text(body, status, type, cacheControl) {
  return new Response(body, { status, headers: secure({ 'Content-Type': type, 'Cache-Control': cacheControl, 'CDN-Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Expires': '0' }) });
}
function json(o, status, extra) {
  return new Response(JSON.stringify(o), { status, headers: secure(Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {})) });
}
function page(body, status) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#020617">' +
    '<title>DEMO CLINIC</title>' +
    '<style>html,body{margin:0;height:100%;background:#020617;overflow:hidden}' +
    'iframe{position:fixed;inset:0;width:100%;height:100%;border:0;display:block}</style>' +
    '</head><body>' + body + '</body></html>';
  return text(html, status, 'text/html; charset=utf-8', 'no-store, no-cache, must-revalidate, max-age=0');
}
function attr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
