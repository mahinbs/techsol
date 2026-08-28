'use strict';
/**
 * WF3 — Dispatch & Customer Communication.
 * Starts ONLY after invoice generation (WF3-01). Collects shipment data +
 * documents, drafts the customer email from the template, and gates the send.
 */
const REQUIRED_DOCS = ['invoice', 'mtc', 'delivery_challan', 'lr_copy'];

class WF3 {
  constructor({ db, audit, approvals, zoho }) { Object.assign(this, { db, audit, approvals, zoho }); }

  /** Open a dispatch for an invoice (enforces the invoice-first rule). */
  open(invoiceNo) {
    const inv = this.db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(invoiceNo);
    if (!inv) throw new Error(`invoice ${invoiceNo} not found — dispatch starts only after invoice generation`);
    const r = this.db.prepare('INSERT INTO dispatches (invoice_id, documents) VALUES (?, ?)').run(inv.id, '[]');
    this.audit.log({ workflow: 'WF3', action: 'dispatch.open', entityType: 'dispatch', entityId: String(r.lastInsertRowid), outcome: 'ok', detail: { invoiceNo } });
    return r.lastInsertRowid;
  }

  /** Record shipment details from WMS / channels. */
  setShipment(dispatchId, { vehicle, driver, contact, transporter, lrNo, dispatchDate, packages }) {
    const r = this.db.prepare(
      `UPDATE dispatches SET vehicle=?, driver=?, contact=?, transporter=?, lr_no=?, dispatch_date=?, packages=? WHERE id=?`
    ).run(vehicle, driver, contact, transporter, lrNo, dispatchDate, packages, dispatchId);
    if (!r.changes) throw new Error(`dispatch ${dispatchId} not found`);
  }

  /** Attach a retrieved document (invoice | mtc | delivery_challan | lr_copy). */
  attachDoc(dispatchId, type, name) {
    if (!REQUIRED_DOCS.includes(type)) throw new Error(`unknown document type ${type}`);
    const d = this.db.prepare('SELECT documents FROM dispatches WHERE id = ?').get(dispatchId);
    if (!d) throw new Error(`dispatch ${dispatchId} not found`);
    const docs = JSON.parse(d.documents);
    if (!docs.find(x => x.type === type)) docs.push({ type, name });
    this.db.prepare('UPDATE dispatches SET documents=? WHERE id=?').run(JSON.stringify(docs), dispatchId);
  }

  /** Draft the dispatch email — blocked until data + all documents are present. */
  draftEmail(dispatchId, toAddr) {
    const d = this.db.prepare(
      `SELECT dp.*, i.invoice_no, i.customer, s.customer_po_no
       FROM dispatches dp JOIN invoices i ON i.id = dp.invoice_id
       LEFT JOIN sales_orders s ON s.id = i.so_id WHERE dp.id = ?`
    ).get(dispatchId);
    if (!d) throw new Error(`dispatch ${dispatchId} not found`);
    if (!d.lr_no || !d.transporter || !d.dispatch_date) throw new Error('shipment details incomplete');
    const docs = JSON.parse(d.documents).map(x => x.type);
    const missing = REQUIRED_DOCS.filter(t => !docs.includes(t));
    if (missing.length) throw new Error(`documents missing: ${missing.join(', ')}`);

    const body = [
      'Dear Sir/Madam,', '',
      `Please find attached herewith the Tax Invoice, MTC & Dispatch details of your PO ${d.customer_po_no || ''}`.trim() + '.',
      `Invoice ${d.invoice_no} through ${d.transporter.toUpperCase()}: ${d.lr_no} dated ${d.dispatch_date}.`, '',
      'Regards,', 'Techsol Engineers',
    ].join('\n');

    const approvalId = this.approvals.request({
      workflow: 'WF3', kind: 'dispatch_email', entityType: 'dispatch', entityId: dispatchId,
      payload: { to: toAddr, subject: `Dispatch details — Invoice ${d.invoice_no}`, body, attachments: JSON.parse(d.documents) },
    });
    this.db.prepare(`UPDATE dispatches SET status='email_pending' WHERE id=?`).run(dispatchId);
    return approvalId;
  }

  /** Execute an approved dispatch email — idempotent; updates CRM + audit. */
  async sendApproved(approvalId, userId, editedPayload = null) {
    const payload = this.approvals.approve(approvalId, userId, editedPayload);
    const key = `wf3-dispatch-${approvalId}`;
    if (this.db.prepare('SELECT id FROM outbox WHERE idempotency_key=?').get(key)) return { deduped: true };
    this.db.prepare(
      `INSERT INTO outbox (idempotency_key, channel, to_addr, subject, body, status, sent_at)
       VALUES (?, 'email', ?, ?, ?, 'sent', datetime('now'))`
    ).run(key, payload.to, payload.subject, payload.body);
    const a = this.db.prepare('SELECT entity_id FROM approvals WHERE id=?').get(approvalId);
    this.db.prepare(`UPDATE dispatches SET status='notified' WHERE id=?`).run(a.entity_id);
    await this.zoho.crmAddNote('deal', `Dispatch notified: ${payload.subject}`);
    this.audit.log({ actor: userId, workflow: 'WF3', action: 'dispatch.sent', entityType: 'dispatch', entityId: String(a.entity_id), outcome: 'ok' });
    return { sent: true };
  }
}
module.exports = { WF3, REQUIRED_DOCS };
