'use strict';
/**
 * WF4 — AP Vendor Invoice Processing + BOE.
 * Validations: GSTIN (checksum), duplicate, PO match (SO–PO Engine), GRN match.
 * Imported material: BOE captured/validated per SOP and linked to bill/PO/SO.
 * Draft bill posts to Zoho ONLY after approval; failures go to exceptions.
 */
const { validateGstin, isDuplicateBill } = require('../engines/rules');

class WF4 {
  constructor({ db, audit, approvals, zoho, sopo }) { Object.assign(this, { db, audit, approvals, zoho, sopo }); }

  /**
   * Ingest a vendor invoice (fields come from the OCR service in production).
   * @returns {{billId?:number, approvalId?:number, exceptions:string[]}}
   */
  async ingest({ vendor, gstin, invoiceNo, invoiceDate, amount, vpoNo, boe = null }) {
    const problems = [];

    const g = validateGstin(gstin || '');
    if (!g.valid) problems.push(`gstin:${g.reason}`);
    if (isDuplicateBill(this.db, { vendor, invoiceNo })) problems.push('duplicate-invoice');

    let vpo = null;
    if (vpoNo) {
      vpo = this.db.prepare('SELECT * FROM vendor_pos WHERE vpo_no = ?').get(vpoNo);
      if (!vpo) problems.push('po-not-found');
    } else problems.push('po-missing');

    let grn = null;
    if (vpo) {
      grn = this.db.prepare('SELECT * FROM grns WHERE vpo_id = ?').get(vpo.id);
      if (!grn) problems.push('grn-missing');
    }

    if (problems.length) {
      const r = this.db.prepare(
        `INSERT INTO exceptions (workflow, entity_type, entity_id, reason, detail) VALUES ('WF4','vendor_invoice',?,?,?)`
      ).run(invoiceNo, 'validation-failed', JSON.stringify({ vendor, problems }));
      this.audit.log({ workflow: 'WF4', action: 'bill.rejected-to-queue', entityType: 'vendor_invoice', entityId: invoiceNo, outcome: 'error', detail: { problems } });
      return { exceptions: problems, exceptionId: r.lastInsertRowid };
    }

    const br = this.db.prepare(
      `INSERT INTO vendor_bills (vendor, gstin, invoice_no, invoice_date, amount, vpo_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(vendor, gstin.toUpperCase(), invoiceNo, invoiceDate, amount, vpo.id);
    const billId = br.lastInsertRowid;

    // BOE for imported material — validated per SOP, linked to bill + PO (+SO via engine)
    if (boe) {
      const sopOk = this.validateBoePerSop(boe);
      this.db.prepare(
        `INSERT INTO boes (boe_no, shipment_ref, vpo_id, bill_id, sop_valid, detail) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(boe.boeNo, boe.shipmentRef || null, vpo.id, billId, sopOk ? 1 : 0, JSON.stringify(boe));
      this.sopo.attachRef(vpo.id, 'boe', boe.boeNo);
      if (!sopOk) {
        this.db.prepare(`INSERT INTO exceptions (workflow, entity_type, entity_id, reason) VALUES ('WF4','boe',?,?)`)
          .run(boe.boeNo, 'boe-sop-nonconforming');
      }
    }

    this.sopo.attachRef(vpo.id, 'vendor_bill', String(billId));
    this.sopo.setStatus(vpo.id, 'billed');

    const approvalId = this.approvals.request({
      workflow: 'WF4', kind: 'vendor_bill', entityType: 'vendor_bill', entityId: billId,
      payload: { vendor, invoiceNo, amount, vpoNo },
    });
    this.audit.log({ workflow: 'WF4', action: 'bill.draft', entityType: 'vendor_bill', entityId: String(billId), outcome: 'ok' });
    return { billId, approvalId, exceptions: [] };
  }

  /** SOP checks for a BOE — rules extend as the client SOP document arrives. */
  validateBoePerSop(boe) {
    return Boolean(boe.boeNo && /^[0-9]{6,9}$/.test(String(boe.boeNo)) && boe.customsValue > 0);
  }

  /** Post an approved bill to Zoho Books (the only path to posting). */
  async postApproved(approvalId, userId) {
    const payload = this.approvals.approve(approvalId, userId);
    const a = this.db.prepare('SELECT entity_id FROM approvals WHERE id=?').get(approvalId);
    const zbill = await this.zoho.booksCreateBill({ vendor_name: payload.vendor, bill_number: payload.invoiceNo, total: payload.amount });
    this.db.prepare(`UPDATE vendor_bills SET zoho_bill_id=?, status='posted' WHERE id=?`).run(String(zbill.id || ''), a.entity_id);
    this.audit.log({ actor: userId, workflow: 'WF4', action: 'bill.posted', entityType: 'vendor_bill', entityId: a.entity_id, outcome: 'ok' });
    return { posted: true };
  }
}
module.exports = { WF4 };
