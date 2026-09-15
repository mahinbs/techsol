'use strict';

/**
 * Automatic CRM Deal stage advancement (client request).
 *
 * As each step of the flow completes, move the Zoho CRM Deal to the mapped
 * pipeline stage — e.g. quotation built → "Proposal Created", quotation sent →
 * "Quotation Sent", order received → "Closed Won". The mapping and the ordered
 * pipeline live in config (crmStages) so the client can tune stage names without
 * a code change, and only the milestones the app can DETERMINISTICALLY detect
 * are automated — judgment stages (Negotiation, Budgetary Quote, the various
 * Closed – … reasons) stay manual.
 *
 * Stage history: updating the Stage via the API makes Zoho record the change in
 * its built-in **Stage History** related list automatically. If the client also
 * keeps a custom history field, set crmStages.historyField and each change is
 * appended there too. Either way we mirror every change locally in crm_stage_log
 * so the app can show and prove the progression.
 *
 * Forward-only: the stage never moves backwards (guarded against re-runs like
 * rebuilding a quotation after an order is already won). Best-effort: a Zoho
 * failure alerts ops and is logged, but never breaks the workflow step.
 */
async function advanceStage(deps, enquiryId, milestone, extra = {}) {
  const { db, zoho, audit, alerter, cfg } = deps;
  const conf = (cfg && cfg.crmStages) || {};
  if (!conf.enabled) return { skipped: 'disabled' };

  const stage = (conf.map || {})[milestone];
  if (!stage) return { skipped: 'no-mapping', milestone };

  // Forward-only guard, using our own log as the current position.
  const last = db.prepare('SELECT stage FROM crm_stage_log WHERE enquiry_id=? ORDER BY id DESC LIMIT 1').get(enquiryId);
  const order = conf.order || [];
  if (last && order.length) {
    const cur = order.indexOf(last.stage), tgt = order.indexOf(stage);
    if (cur >= 0 && tgt >= 0 && tgt <= cur) return { skipped: 'not-forward', from: last.stage, to: stage };
  }

  const enq = db.prepare('SELECT crm_deal_id FROM enquiries WHERE id=?').get(enquiryId);
  const dealId = enq && enq.crm_deal_id;

  // No CRM deal (mock mode, or the deal create failed) — still record locally so
  // the in-app history is complete; there is just nothing to push to Zoho.
  if (!dealId) {
    try { db.prepare(`INSERT INTO crm_stage_log (enquiry_id, deal_id, milestone, stage, note) VALUES (?,?,?,?,?)`).run(enquiryId, null, milestone, stage, extra.note || null); } catch {}
    return { skipped: 'no-deal', stage };
  }

  try {
    const update = { Stage: stage };
    // Append to a custom history field only if the client configured one.
    if (conf.historyField) {
      let prior = '';
      try { const r = await zoho.crmGetDeal(dealId); prior = (r && r.data && r.data[0] && r.data[0][conf.historyField]) || ''; } catch { /* read best-effort */ }
      const line = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} → ${stage}${extra.note ? ' (' + extra.note + ')' : ''}`;
      update[conf.historyField] = prior ? `${prior}\n${line}` : line;
    }
    await zoho.crmUpdateDeal(dealId, update);
    try { db.prepare(`INSERT INTO crm_stage_log (enquiry_id, deal_id, milestone, stage, note) VALUES (?,?,?,?,?)`).run(enquiryId, String(dealId), milestone, stage, extra.note || null); } catch {}
    audit.log({ workflow: 'CRM', action: 'crm.stage.updated', entityType: 'enquiry', entityId: String(enquiryId), outcome: 'ok', detail: { milestone, stage, dealId } });
    return { ok: true, stage };
  } catch (e) {
    if (alerter) alerter.notify({ context: 'crm.stage', error: e, workflow: 'CRM', entityType: 'enquiry', entityId: enquiryId, detail: { milestone, stage } });
    audit.log({ workflow: 'CRM', action: 'crm.stage.failed', entityType: 'enquiry', entityId: String(enquiryId), outcome: 'error', detail: { milestone, stage, message: e.message } });
    return { ok: false, error: e.message };
  }
}

module.exports = { advanceStage };
