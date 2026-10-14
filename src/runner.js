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
  'mcCardEligibility', 'buildTaperPlan', 'suggestPaediatricDose', 'getOPPrescriptionHtml', 'getOPReferralLetter'
]);

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
