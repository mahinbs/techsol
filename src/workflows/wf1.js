'use strict';
/**
 * WF1 — RFQ / Enquiry Capture & Acknowledgement.
 * Pipeline: intake (idempotent) → extract → dedupe/match → CRM deal →
 * acknowledgement draft → APPROVAL → send + audit.
 *
 * The extractor is pluggable: production wires the OCR/LLM provider in
 * Phase 2.0; the interface (fields + confidence) is fixed here.
 */
class WF1 {
  constructor({ db, audit, approvals, zoho, cfg, extractor }) {
    Object.assign(this, { db, audit, approvals, zoho, cfg });
    this.extractor = extractor; // async (message) => {fields:{...{value,confidence}}, lines:[...]}
  }

  /** Intake — idempotent on source_message_id. Returns enquiry id or null if already seen. */
  intake(message) {
    const { sourceMessageId, source, sender, subject, body, attachments = [] } = message;
    const dup = this.db.prepare('SELECT id FROM enquiries WHERE source_message_id = ?').get(sourceMessageId);
    if (dup) return null; // already processed — never double-handle
    const r = this.db.prepare(
      `INSERT INTO enquiries (source, source_message_id, sender, subject, body, attachments)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(source, sourceMessageId, sender, subject || '', body || '', JSON.stringify(attachments));
    this.audit.log({ workflow: 'WF1', action: 'enquiry.intake', entityType: 'enquiry', entityId: String(r.lastInsertRowid), outcome: 'ok', detail: { sender, subject } });
    return r.lastInsertRowid;
  }

  /** Extraction + duplicate detection + routing. */
  async process(enquiryId) {
    const enq = this.db.prepare('SELECT * FROM enquiries WHERE id = ?').get(enquiryId);
    if (!enq) throw new Error(`enquiry ${enquiryId} not found`);

    const { isDuplicateEnquiry } = require('../engines/rules');
    if (isDuplicateEnquiry(this.db, { sender: enq.sender, subject: enq.subject, windowDays: this.cfg.extraction.duplicateWindowDays, excludeId: enquiryId })) {
      // linked as follow-up, not an exception
      this.audit.log({ workflow: 'WF1', action: 'enquiry.linked-duplicate', entityType: 'enquiry', entityId: String(enquiryId), outcome: 'ok' });
    }

    const extracted = await this.extractor(enq);
    this.db.prepare('UPDATE enquiries SET extracted = ?, status = ? WHERE id = ?')
      .run(JSON.stringify(extracted.fields), 'extracted', enquiryId);
    const insLine = this.db.prepare(
      `INSERT INTO enquiry_lines (enquiry_id, line_no, description, qty, uom, spec, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    (extracted.lines || []).forEach((l, i) => insLine.run(enquiryId, i + 1, l.description, l.qty ?? null, l.uom ?? null, l.spec ?? null, l.confidence ?? null));

    // low-confidence gate → exception queue (WF1-08)
    const threshold = this.cfg.extraction.confidenceThreshold;
    const lowFields = Object.entries(extracted.fields)
      .filter(([, v]) => v && typeof v.confidence === 'number' && v.confidence < threshold)
      .map(([k]) => k);
    if (lowFields.length) {
      this.db.prepare(`INSERT INTO exceptions (workflow, entity_type, entity_id, reason, detail) VALUES ('WF1','enquiry',?,?,?)`)
        .run(String(enquiryId), 'low-confidence-fields', JSON.stringify({ fields: lowFields, threshold }));
    }

    // CRM deal (draft; write happens now, send/communications stay gated)
    const customer = extracted.fields.customer?.value || enq.sender;
    const deal = await this.zoho.crmUpsertDeal({
      Deal_Name: `${customer} — ${enq.subject || 'Enquiry'}`,
      Stage: process.env.ZOHO_DEAL_STAGE || 'Enquiry',            // matches Techsol's custom stage picklist
      Pipeline: process.env.ZOHO_DEAL_PIPELINE || 'Standard (Standard)', // mandatory field in Techsol's CRM org
    });
    this.db.prepare('UPDATE enquiries SET crm_deal_id = ?, status = ? WHERE id = ?')
      .run(String(deal.id || ''), 'deal_created', enquiryId);
    this.audit.log({ workflow: 'WF1', action: 'crm.deal.upsert', entityType: 'enquiry', entityId: String(enquiryId), outcome: 'ok' });

    // acknowledgement draft → approval (WF1-06/07)
    const ackBody = this.renderAck(customer, extracted.lines?.length || 0);
    const approvalId = this.approvals.request({
      workflow: 'WF1', kind: 'ack_email', entityType: 'enquiry', entityId: enquiryId,
      payload: { to: enq.sender, subject: `RE: ${enq.subject || 'Your enquiry'}`, body: ackBody },
    });
    this.db.prepare(`UPDATE enquiries SET status='ack_pending' WHERE id=?`).run(enquiryId);
    return { enquiryId, approvalId, lowFields };
  }

  renderAck(customer, itemCount) {
    return [
      'Dear Sir,', '',
      'Greetings from Techsol Engineers,', '',
      `We acknowledge the receipt of your enquiry${itemCount ? ` (${itemCount} items)` : ''}.`,
      'Our team is preparing the quotation and will revert at the earliest.', '',
      'Regards,', 'Techsol Engineers',
    ].join('\n');
  }

  /** Execute an approved acknowledgement — idempotent via outbox. */
  sendApproved(approvalId, userId, editedPayload = null) {
    const payload = this.approvals.approve(approvalId, userId, editedPayload);
    const key = `wf1-ack-${approvalId}`;
    const existing = this.db.prepare('SELECT id, status FROM outbox WHERE idempotency_key = ?').get(key);
    if (existing) return { deduped: true };
    this.db.prepare(
      `INSERT INTO outbox (idempotency_key, channel, to_addr, subject, body, status, sent_at)
       VALUES (?, 'email', ?, ?, ?, 'sent', datetime('now'))`
    ).run(key, payload.to, payload.subject, payload.body);
    const a = this.db.prepare('SELECT entity_id FROM approvals WHERE id = ?').get(approvalId);
    this.db.prepare(`UPDATE enquiries SET status='ack_sent' WHERE id=?`).run(a.entity_id);
    this.audit.log({ actor: userId, workflow: 'WF1', action: 'ack.sent', entityType: 'enquiry', entityId: String(a.entity_id), outcome: 'ok' });
    return { sent: true };
  }
}
module.exports = { WF1 };
