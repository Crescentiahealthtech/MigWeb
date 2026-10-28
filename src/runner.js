// ============================================================================
// Reads answered by the app's own Apps Script code, run on the Supabase copy.
// ----------------------------------------------------------------------------
// The Supabase Edge Function cresrx-reads (MIGRATION repo,
// supabase/functions/cresrx-reads) runs the project's .gs files unchanged,
// with Apps Script's services stood in for: the spreadsheet is the Supabase
// copy, the clock is the clinic's, who is asking is the session Apps Script
// stored in Supabase. The functions below go there instead of to Apps
// Script; anything it cannot do exactly (a read that writes, a Google-only
// service, a tab or setting not copied), it says so (409, X-CresRx-Why) and
// Apps Script answers, as before.
//
// The list is the Edge Function's served.json; the MIGRATION repo's
// tools/sbmirror.js checks the two agree and that each gives Apps Script's
// own answer on the demo year. The saves (WRITER, below) likewise, and
// tools/edgewrites.js proves each leaves the Sheet as Apps Script would.
// ============================================================================

export const RUNNER = new Set([
  // Finance Hub
  'getAccountsDashboard', 'getFinanceDashboard', 'getReceivables', 'getAllDrawerStates', 'getShiftState', 'getPayables',
  'getExpenseRegister', 'getTaxSummary', 'getAuditModules', 'getAuditLog', 'getInsuranceClaims', 'getInsurers', 'getPackages',
  'getOpenAdmissions', 'getRunningTab', 'getIpVisits', 'getPharmacyLedger',
  // IP Notes
  'getActiveIPAdmissionsForNotes', 'getIPNotesBundle', 'getIPTimeline', 'getIPNotePermissions', 'getClinicalContext',
  'getIPLabResults', 'getIPCareTeamPanel', 'getIPTeamRoles', 'getIPNotesLabCatalog', 'getIPNotesPrintHtml',
  // OP consultation
  'getComposerContext', 'getPatientAllergies', 'getLastVisitRecall', 'listConsultTemplates', 'getAssistForDiagnosis',
  'getOPDOrderableTests', 'fetchOPDrugMaster', 'fetchUniversalDrugs', 'fetchPharmacyMasterForIP', 'checkRxSafety',
  'mcCardEligibility', 'buildTaperPlan', 'suggestPaediatricDose', 'getOPPrescriptionHtml', 'getOPReferralLetter',
  // Hospital Billing, the billing ledgers, the IP ledger (Day 4)
  'hb_getBootstrap', 'hb_getPatientContext', 'hb_getInvoices', 'hb_getInvoice', 'hb_listOpenOrders',
  'getIpBillingStatus', 'getIpDraftBillHtml', 'getIpAdvanceReceipt', 'getIPHistory', 'getAdmissionDetail', 'getLabLedger',
  // Day 4b: reads left on screens moved earlier (availability grid, stock
  // alerts, lab results, dose reference, the visiting consultant's state,
  // outside labs, mother & child, MLC, reminders), the ward and bed map, IP
  // charts and records. Not listVisitingConsultants: it closes stale
  // sessions on the sheet as it reads (a write), by their tokens (never copied).
  'getDoctorAvailabilityGrid', 'getStockAlerts', 'getPatientLabResults', 'getDoseReference', 'getVisitingConsultantState',
  'getExternalLabFormContext', 'getOutsideLabPrintHtml', 'mcGetAntenatal', 'mcGetImmunisation',
  // The child's cards and the antenatal card's scans, checklist and register (Child_Growth.gs, Child_Development.gs, Antenatal_Plus.gs).
  'mcGetGrowth', 'mcGetMilestones', 'mcGetAntenatalPlus', 'mcListOpenAntenatal', 'mcListVaccinesDue',
  'getMLCRecords', 'getMLCRegister', 'getMLCStatus', 'getMLCPrintHtml', 'getReminderQueue',
  'getActiveIPWard', 'getAvailableBedsByWard', 'getBedStatuses', 'getConsultantList', 'getWardBedBoard', 'getWardList',
  'fetchPatientForAdmit', 'getIPDiabeticChart', 'getOTForm', 'getOTPrintHtml', 'getIPRecordsLedger', 'getIPRecordFile',
  'getIPRecordPrintHtml', 'getDischargeSummaryFull', 'mtPrintOPEncounter', 'ds_getPrintHtml',
  // Day 5: Pharmacy (billing desk, dashboard, returns, reports, purchases, stock, supplier returns)
  'fetchBillableStock', 'fetchPharmacyInventory', 'getPatientBillingContext', 'getInvoiceForPrint', 'searchPharmacyInvoices',
  'getPharmacyDashboard', 'getPharmacyFinanceSummary', 'getInvoiceForReturn', 'getPendingCreditBills', 'getPharmacyStockList',
  'getPharmacySalesAnalysis', 'getPharmacyGstSummary', 'getScheduleDrugRegister', 'getPharmacyPurchases', 'getPharmacyPurchase',
  'getPurchaseLookups', 'getPharmacyBatchHistory', 'getStockAdjustReasons', 'getDisposalReasons', 'suggestDrugSchedule',
  'previewPackSizes', 'previewScheduleClassification', 'getSupplierReturns', 'getSupplierReturnStock', 'getSupplierReturnPrint',
  'getSupplierCredit', 'getSupplierCreditReport',
  // Smart reorder: the plan and the draft orders (Pharmacy_Reorder.gs).
  'getReorderPlan', 'getPurchaseOrders', 'getPurchaseOrder', 'getReorderLevels',
  // Day 6: the lab (queues, orders, result entry, collection, labels, catalogue,
  // new requests, reports, bills, billing, cancelled, critical values), the IP
  // case sheet, the discharge desk, the patient portal, consent, barcodes
  'getLabWorkspaceData', 'getLabOrderPanel', 'buildResultEntrySheet', 'getSuggestedTubes', 'getSampleLabelData',
  'verifyCollectionIdentity', 'getLabCatalog', 'getOrderableTests', 'lookupLabPatient', 'searchPatientByMobile',
  'getLabReportHtml', 'getLabBillHtml', 'getLabBillingWorkspace', 'getLabDailyCollection', 'getLabReceiptHtml',
  'labListCancelled', 'labListCriticalUnacked', 'getIPCasesheetContext', 'getIPCasesheetWard', 'getIPCasesheetPrintHtml',
  'ds_getDiff', 'ds_getSourceItem', 'portalHome', 'portalLabResults', 'portalRecords', 'portalBookableDoctors',
  'portalDoctorSlots', 'getConsentStatus', 'getNomination', 'getScanRouterConfig', 'resolveScan', 'getPatientLabelData',
  'ds_getQueue', 'ds_getSummary', 'ds_getSummaryLite', 'ds_getGateStatus', 'ds_getStatusMap', 'ds_getPickers',
  'ds_getSignableDoctors', 'getIPDiabeticPrintHtml', 'getIPDrugChartPrintHtml', 'getIPEWSPrintHtml', 'searchLabRecords',
  // The clinical timeline: the Worker answers outpatients itself (src/app.js);
  // an admitted patient's, which it leaves, goes here before Apps Script.
  'buildLongitudinalTimeline',
  'getUsernameMappingReport', 'getEncounterForPrint',
  // The last reads that need no Google service: the disposal register, the
  // access overview, the privacy console.
  'getDisposalLog', 'crescGetAccessOverview', 'crescUserAdminScope', 'dpdpConsentQueue', 'dpdpConsoleSnapshot',
  'dpdpBreachNotice',
  // The Master Ledger a page at a time, with the totals of every match;
  // Operations: the day summary (its sign-in figures stay with Apps Script:
  // Audit_Log, getDaySignIns) and the backups' log and schedule.
  'getMasterLedger', 'getDaySummary', 'getBackupStatus',
  // The claim tracker, as a ledger: a page of claims with the whole set's totals, one claim opened.
  'getClaimTracker', 'getClaimDetail'
]);

/**
 * Saves the Edge Function makes (Phase W: served.json "writes"): the app's
 * own save, run on the copy, all its writes committed there in one go, then
 * written into the Sheet by Apps Script within seconds (sbDrainEdgeWrites_)
 * — straight away, as this asks for it after each save (drainSoon). A save
 * it cannot make exactly (a tab created, a session ended, a Google service)
 * is refused with nothing written, and Apps Script makes it, as before.
 * Kept with Apps Script altogether: a password changed or reset, a summary
 * signed, a visiting consultant's session, a month's books locked (each
 * needs what never leaves Google: a password digest, a session, a setting).
 *
 * A call id goes with each save (x-cresrx-call): if the answer is lost on
 * the way, the call is closed in the log by it (recover), so a save is never
 * made twice, here and by Apps Script.
 */
export const WRITER = new Set([
  // Group A: appointments and patients
  'updateAppointmentStatus', 'setAppointmentTime', 'barcodeUpdateAppointment', 'submitNewAppointment', 'bookAppointmentScoped',
  'portalBookAppointment', 'portalCancelAppointment', 'updatePatientProfile', 'saveUserProfile', 'savePatientAllergies',
  // Group B: the OP consultation
  'saveOPEncounterScoped', 'createOPReferral', 'respondToOPReferral', 'saveConsultTemplate', 'applyConsultTemplate',
  'deleteConsultTemplate', 'saveRxBundle', 'noteRxBundleUsed', 'deleteRxBundle', 'promotePhraseToClinic', 'saveExamDefaults',
  // Group C: Hospital Billing
  'hb_saveInvoice', 'hb_recordPayment', 'hb_cancelInvoice', 'hb_changePaymentMode', 'hb_dismissOrder',
  // Group D: registration, the doctors' hours, accounts
  'registerPatient', 'saveDoctorSchedule', 'addScheduleException', 'deleteScheduleException', 'setDoctorDayBlocks',
  'crescSaveUserAccess', 'crescSetAccountActive', 'crescCreateStaffAccount', 'deletePhraseTemplate',
  // Group E: the ward and IP notes
  'saveNewAdmissionLedger', 'processBedTransfer', 'processPatientDischarge', 'updateBedStatusInDB', 'saveIPNote',
  'updateIPMedAction', 'addIPCrossConsult', 'removeIPCrossConsult', 'addIPCareTeamMember', 'removeIPCareTeamMember',
  'updateIPDiagnosis', 'saveIPDiabeticEntry', 'voidIPDiabeticEntry', 'saveOTRecord', 'saveMLCRecord', 'saveIPCasesheet',
  'amendIPCasesheet',
  // Group F: Finance Hub and the IP bill
  'recordLedgerEntry', 'recordBankTransfer', 'moveShiftCashOut', 'openShift', 'closeShift', 'recordPayable', 'payPayable',
  'createManualClaim', 'updateClaim', 'settleClaim', 'addIpCharge', 'addIpCharges', 'billChargeToIp', 'editIpCharge',
  'voidIpCharge', 'markIpChargePaidAtCounter', 'collectIpAdvance', 'addIpVisit', 'saveDischargeDraft', 'settleReceivableBill',
  'settleDischarge',
  // Group G: the pharmacy
  'processPharmacyBill', 'processPharmacyReturn', 'settleCreditBill', 'changePharmacyPayMode', 'savePharmacyPurchase',
  'cancelPharmacyPurchase', 'createSupplierReturn', 'savePharmacyInventory', 'updatePharmacyStock', 'deletePharmacyBatch',
  'discardPharmacyStock', 'applyPackSizes', 'applyScheduleClassification',
  // Group H: the lab
  'createLabRequest', 'advanceOrderStatus', 'collectLabSample', 'receiveLabSample', 'receiveLabSampleByBarcode', 'rejectLabSample',
  'collectAndBillLabSample', 'generateLabBill', 'labCancelBill', 'labCancelPendingOrder', 'settleLabBillBalance',
  'saveLabResultsDraft', 'submitLabResults', 'verifyLabResults', 'labAcknowledgeCritical', 'saveCatalogEntry',
  'savePanelWithParameters', 'setCatalogActive', 'saveExternalLabResult', 'voidExternalLabResult',
  // Group I: discharge summaries (signing aside)
  'ds_initiateDischarge', 'ds_saveWorking', 'ds_regenerate', 'ds_submit', 'ds_return', 'ds_startAmendment', 'ds_discardAmendment',
  'ds_cancel',
  // Group J: mother & child, consent, nominees
  'mcOpenAntenatal', 'mcCloseAntenatal', 'mcRecordAntenatalVisit', 'mcRecordImmunisation', 'mcMarkDoseNotGiven', 'recordConsent',
  'withdrawConsent', 'recordNomination', 'revokeNomination',
  // Group L: the antenatal card's scans, checklist and PICME number; a child's growth, milestones and the schedule caught up
  'mcRecordScan', 'mcVoidScan', 'mcRedateToScan', 'mcRecordChecklist', 'mcVoidChecklist', 'mcSetPicme',
  'mcRecordGrowth', 'mcVoidGrowth', 'mcRecordMilestones', 'mcRecordUipUpToAge',
  // Group K: the privacy console (data requests, breaches, consent asked as a
  // document is sent, consent backfilled), a reminder marked sent
  'raiseDPDPRequest', 'dpdpVerifyRequester', 'closeDPDPRequest', 'dpdpRaiseBreach', 'dpdpAssessBreach', 'recordDispatchConsent',
  'markReminderSent', 'dpdpBackfillConsent',
  // The claim tracker: a stage moved, a document ticked, a reminder noted (sent
  // from the desk's own WhatsApp or mail), an insurer's contact, the time limits
  'moveClaimStage', 'tickClaimDocument', 'chaseClaim', 'saveInsurerContact', 'saveClaimSla',
  // Group G, the pharmacy's reorder (Pharmacy_Reorder.gs): a medicine's level,
  // a supplier's lead time, the defaults, a draft order and its status. The
  // order e-mailed as a PDF (emailPurchaseOrder) stays with Apps Script.
  'saveReorderSetting', 'saveSupplierReorderSetting', 'saveReorderConfig', 'createPurchaseOrderDraft', 'setPurchaseOrderStatus'
]);

/**
 * What every page asks with no session (served.json "public"): a screen's
 * bundle, the build check, the consent notice, the letterhead. The Edge
 * Function makes them from its own .gs and .html files (the same commit as
 * its reads), so Apps Script is not asked for them; src/app.js serves its
 * answer first and keeps the stored copy and Apps Script only for when it
 * cannot. Its answers carry the build of the page it serves
 * (X-CresRx-Shell-Build, see viaShell).
 */
export const PUBLIC = new Set(['crescGetBundle', 'getAppBuild', 'getDPDPNotice', 'getClinicProfile']);

const fnUrl = (env) => String(env.SUPABASE_URL).replace(/\/+$/, '') + '/functions/v1/cresrx-reads';
const restUrl = (env, fn) => String(env.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/rpc/' + fn;
function keyHeaders(env) {
  const h = { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' };
  if (!/^sb_/.test(String(env.SUPABASE_SECRET_KEY || ''))) h.Authorization = 'Bearer ' + env.SUPABASE_SECRET_KEY;
  return h;
}
const SAVE_WAIT_MS = 45000;

/**
 * A save whose answer did not come back: made, or not? The call is closed in
 * the log by its id (edge_writes {fence}): either it was made, and this has
 * its answer ({answer}), or from now on it cannot be, and Apps Script may make
 * it ({why}). {unsure} when Supabase cannot be asked: the person is told.
 */
export async function recover(env, callId) {
  try {
    const r = await fetch(restUrl(env, 'edge_writes'), { method: 'POST', headers: keyHeaders(env), body: JSON.stringify({ p: { fence: callId } }) });
    if (!r.ok) return { unsure: true };
    const st = await r.json();
    if (st && st.fenced === true) return { why: 'the save service did not answer' };
    if (st && st.found) return st.fenced ? { why: 'the save service did not answer' } : { answer: st.answer };
    return { unsure: true };
  } catch (e) { return { unsure: true }; }
}

/**
 * A save sent to the Edge Function (its bytes, as the page sent them). The
 * answer as a Response; {why} when nothing was or can now be written, for
 * Apps Script; {answer} when it was made but its own answer was lost (from
 * the log); {unsure} when it may have been made and Supabase cannot say.
 */
export async function viaSaver(env, bytes, callId) {
  const headers = Object.assign(keyHeaders(env), { 'x-cresrx-call': callId });
  if (env.SUPABASE_REGION) headers['x-region'] = String(env.SUPABASE_REGION);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), SAVE_WAIT_MS);
  let res;
  try {
    res = await fetch(fnUrl(env), { method: 'POST', body: bytes, headers, signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    return recover(env, callId);
  }
  clearTimeout(timer);
  if (res.status === 200) return res;
  const why = res.headers.get('X-CresRx-Why');
  try { if (res.body) await res.body.cancel(); } catch (e) { /* nothing to read */ }
  // 409: refused before anything was written. 404: not deployed. Anything
  // else may have come after a commit: the log says.
  if (res.status === 409) return { why: why || 'the save service refused it' };
  if (res.status === 404) return { why: 'the reads service is not deployed' };
  // Unsure, or failed after it may have committed: the call is closed in the log.
  return recover(env, callId);
}

/** Are saves made in Supabase waiting for the Sheet? true when it cannot say (Apps Script then checks itself). */
export async function savesWaiting(env) {
  if (!env.SUPABASE_SECRET_KEY) return false;
  try {
    const r = await fetch(restUrl(env, 'edge_writes'), { method: 'POST', headers: keyHeaders(env), body: JSON.stringify({ p: { pending: true } }) });
    if (!r.ok) return true;
    const j = await r.json();
    return !(j && j.n === 0);
  } catch (e) { return true; }
}

/**
 * The reads each screen bundle (crescGetBundle) makes as it opens. When the
 * bundle is fetched the Edge Function is asked to load the tabs they read
 * (warmRunner), so the screen's first calls find them in memory.
 */
export const WARM = {
  billing: ['hb_getBootstrap', 'hb_getPatientContext', 'hb_getInvoices', 'hb_listOpenOrders', 'getIpBillingStatus',
            'getOpenAdmissions', 'getRunningTab', 'getShiftState'],
  pharmacy: ['fetchBillableStock', 'getPatientBillingContext', 'getPharmacyDashboard', 'getPharmacyStockList',
             'fetchPharmacyInventory', 'getPendingCreditBills', 'getStockAlerts', 'getShiftState', 'getReorderLevels'],
  accounts: ['getAccountsDashboard', 'getFinanceDashboard', 'getAllDrawerStates', 'getShiftState', 'getReceivables', 'getMasterLedger'],
  'emr-notes': ['getActiveIPAdmissionsForNotes', 'getIPNotesBundle', 'getIPTimeline', 'getIPDiabeticChart'],
  'emr-op': ['getComposerContext', 'getLastVisitRecall', 'fetchOPDrugMaster', 'listConsultTemplates'],
  'emr-ward': ['getActiveIPWard', 'getWardBedBoard', 'getBedStatuses', 'getIPHistory'],
  'emr-records': ['getIPRecordsLedger'],
  lab: ['getLabWorkspaceData', 'getLabBillingWorkspace', 'getLabCatalog', 'getLabLedger', 'labListCriticalUnacked'],
  'emr-discharge': ['ds_getQueue', 'ds_getPickers', 'ds_getSignableDoctors'],
  'emr-casesheet': ['getIPCasesheetWard', 'getComposerContext', 'fetchOPDrugMaster'],
  patient: ['portalHome', 'portalRecords', 'portalLabResults']
};
const WARMED = new Map();     // bundle -> when this instance last asked
const WARM_EVERY_MS = 60 * 1000;

/** Asks the Edge Function to load the tabs a screen is about to read. Never throws. */
export async function warmRunner(env, bundle) {
  const names = WARM[bundle];
  if (!names || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return;
  const last = WARMED.get(bundle) || 0;
  if (Date.now() - last < WARM_EVERY_MS) return;
  WARMED.set(bundle, Date.now());
  try {
    const headers = { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' };
    if (env.SUPABASE_REGION) headers['x-region'] = String(env.SUPABASE_REGION);
    const res = await fetch(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/functions/v1/cresrx-reads',
      { method: 'POST', body: JSON.stringify({ fn: '__warm', args: names }), headers });
    if (res.body) await res.body.cancel();
  } catch (e) { /* the screen's own calls load them */ }
}

/**
 * The call, sent on to the Edge Function as the page sent it (its bytes, not
 * parsed). The answer as a Response to pass on, or {why} for Apps Script to
 * answer instead.
 */
export async function viaRunner(env, bytes) {
  let res;
  try {
    const headers = { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' };
    // Run it in the database's region (wrangler.jsonc SUPABASE_REGION): it
    // reads the copy several times per call.
    if (env.SUPABASE_REGION) headers['x-region'] = String(env.SUPABASE_REGION);
    res = await fetch(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/functions/v1/cresrx-reads', { method: 'POST', body: bytes, headers });
  } catch (e) {
    return { why: 'the reads service could not be reached' };
  }
  if (res.status === 200) return res;
  const why = res.headers.get('X-CresRx-Why') ||
    (res.status === 404 ? 'the reads service is not deployed' : 'the reads service answered ' + res.status);
  try { if (res.body) await res.body.cancel(); } catch (e) { /* nothing to read */ }
  return { why };
}

/**
 * The app's page from the Edge Function ({fn: "__shell"}): Index.html as
 * Apps Script's ?shell=1 gives it, made from the Edge Function's own files.
 * Its text and build, or null (Apps Script's page is used instead).
 */
export async function viaShell(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return null;
  try {
    const headers = { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' };
    if (env.SUPABASE_REGION) headers['x-region'] = String(env.SUPABASE_REGION);
    const res = await fetch(fnUrl(env), { method: 'POST', body: '{"fn":"__shell","args":[]}', headers });
    const build = res.headers.get('X-CresRx-Shell-Build') || '';
    if (res.status !== 200 || !/^[0-9a-f]{6,32}$/.test(build)) {
      try { if (res.body) await res.body.cancel(); } catch (e) { /* nothing to read */ }
      return null;
    }
    return { html: await res.text(), build };
  } catch (e) { return null; }
}
