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
// own answer on the demo year.
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
  'buildLongitudinalTimeline'
]);

/**
 * The reads each screen bundle (crescGetBundle) makes as it opens. When the
 * bundle is fetched the Edge Function is asked to load the tabs they read
 * (warmRunner), so the screen's first calls find them in memory.
 */
export const WARM = {
  billing: ['hb_getBootstrap', 'hb_getPatientContext', 'hb_getInvoices', 'hb_listOpenOrders', 'getIpBillingStatus',
            'getOpenAdmissions', 'getRunningTab', 'getShiftState'],
  pharmacy: ['fetchBillableStock', 'getPatientBillingContext', 'getPharmacyDashboard', 'getPharmacyStockList',
             'fetchPharmacyInventory', 'getPendingCreditBills', 'getStockAlerts', 'getShiftState'],
  accounts: ['getAccountsDashboard', 'getFinanceDashboard', 'getAllDrawerStates', 'getShiftState', 'getReceivables'],
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
