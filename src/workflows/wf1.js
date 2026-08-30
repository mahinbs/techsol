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
  constructor({ db, audit, approvals, zoho, cfg, extractor, mailer }) {
    Object.assign(this, { db, audit, approvals, zoho, cfg });
    this.extractor = extractor; // async (message) => {fields:{...{value,confidence}}, lines:[...]}
    this.mailer = mailer || null; // optional outbound SMTP; absent → nothing is emailed
    this.waSender = null;         // set by the server once the WhatsApp watcher exists
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

  /**
   * Execute an approved acknowledgement.
   *
   * "sent" now means the email actually left over SMTP. Three outcomes, each
   * recorded honestly in the outbox:
   *   - emailed  → an SMTP transport is configured and the send succeeded.
   *   - recorded → no transport configured; the acknowledgement is kept as a
   *                draft. It is NOT claimed as sent.
   *   - failed   → a transport is configured but the send errored; left
   *                retryable so a later attempt can go out.
   * Idempotent on the approval: a message already emailed is never sent twice,
   * but a failed or draft attempt may be retried.
   */
  async sendApproved(approvalId, userId, editedPayload = null) {
    const a = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!a) throw new Error(`approval ${approvalId} not found`);
    let payload;
    if (a.status === 'pending') {
      // First decision — consume the approval.
      payload = this.approvals.approve(approvalId, userId, editedPayload);
    } else if (a.status === 'approved') {
      // Retry of an acknowledgement that was approved but never actually sent
      // (the SMTP send failed). Re-deliver from the stored payload rather than
      // trying to approve again.
      payload = editedPayload || JSON.parse(a.edited_payload || a.payload);
    } else {
      throw new Error(`approval ${approvalId} already ${a.status}`);
    }
    return this._deliverAck(approvalId, a.entity_id, payload, userId);
  }

  /**
   * Auto-acknowledge an arriving enquiry: find its pending acknowledgement and,
   * only if the mailer is configured AND automatic sending is switched on, send
   * it without anyone approving. Otherwise it is left in the queue untouched.
   */
  async autoAcknowledge(enquiryId) {
    // The switch is channel-agnostic: with it on, a WhatsApp enquiry is
    // acknowledged on WhatsApp and an email enquiry by email, each subject to
    // that channel being configured.
    if (!this.mailer || !this.mailer.autoAckOn()) return { autoSent: false, reason: 'auto-send off' };
    const ap = this.db.prepare(
      `SELECT * FROM approvals WHERE entity_type='enquiry' AND entity_id=? AND kind='ack_email' AND status='pending' ORDER BY id DESC LIMIT 1`
    ).get(String(enquiryId));
    if (!ap) return { autoSent: false, reason: 'no pending acknowledgement' };
    const out = await this.sendApproved(ap.id, 'auto', null);
    return { autoSent: !!out.emailed, ...out };
  }

  async _deliverAck(approvalId, enquiryId, payload, userId) {
    const key = `wf1-ack-${approvalId}`;
    const existing = this.db.prepare('SELECT id, status FROM outbox WHERE idempotency_key = ?').get(key);
    if (existing && existing.status === 'sent') return { deduped: true, emailed: true };

    // Acknowledge on the SAME channel the enquiry arrived on: a WhatsApp RFQ is
    // answered on WhatsApp, an emailed one by email. The recipient in the
    // payload is already the right handle (a phone number, or an address).
    const enq = this.db.prepare('SELECT source FROM enquiries WHERE id=?').get(enquiryId);
    const channel = enq && enq.source === 'whatsapp' ? 'whatsapp' : 'email';

    let canSend, doSend;
    if (channel === 'whatsapp') {
      canSend = !!(this.waSender && this.waSender.isReady());
      doSend = () => this.waSender.send(payload.to, payload.body);
    } else {
      canSend = !!(this.mailer && this.mailer.isReady());
      doSend = () => this.mailer.send({ to: payload.to, subject: payload.subject, body: payload.body });
    }

    let status = 'recorded', emailed = false, error = null;
    if (canSend) {
      try { await doSend(); status = 'sent'; emailed = true; }
      catch (e) { status = 'failed'; error = e.message; }
    }

    if (existing) {
      this.db.prepare(`UPDATE outbox SET status=?, channel=?, sent_at=CASE WHEN ?='sent' THEN datetime('now') ELSE sent_at END WHERE id=?`)
        .run(status, channel, status, existing.id);
    } else {
      this.db.prepare(
        `INSERT INTO outbox (idempotency_key, channel, to_addr, subject, body, status, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ?='sent' THEN datetime('now') ELSE NULL END)`
      ).run(key, channel, payload.to, payload.subject, payload.body, status, status);
    }

    // The enquiry only advances to ack_sent when the reply truly went out.
    if (emailed) this.db.prepare(`UPDATE enquiries SET status='ack_sent' WHERE id=?`).run(enquiryId);

    this.audit.log({
      actor: userId, workflow: 'WF1',
      action: emailed ? 'ack.sent' : (canSend ? 'ack.send.failed' : 'ack.recorded'),
      entityType: 'enquiry', entityId: String(enquiryId),
      outcome: emailed ? 'ok' : (canSend ? 'failed' : 'ok'),
      detail: { to: payload.to, channel, emailed, error },
    });
    return { sent: emailed, emailed, recorded: !canSend, channel, error };
  }
}
module.exports = { WF1 };
