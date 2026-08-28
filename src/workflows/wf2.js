'use strict';
/**
 * WF2 — Quotation → Sales Order → Inventory → Procurement (SO–PO Engine).
 * Rules enforced in code:
 *  - pricing is recommended, NEVER auto-finalised (WF2-03)
 *  - unmatched lines flag, never guess (WF2-02)
 *  - SO and Vendor POs are review-gated (WF2-06/08)
 */
class WF2 {
  constructor({ db, audit, approvals, zoho, sopo, matcher, cfg }) {
    Object.assign(this, { db, audit, approvals, zoho, sopo, matcher, cfg });
  }

  /** Build a draft quotation from enquiry lines: match + recommend pricing. */
  buildQuotation(enquiryId, customer, quoteNo) {
    const lines = this.db.prepare('SELECT * FROM enquiry_lines WHERE enquiry_id = ? ORDER BY line_no').all(enquiryId);
    if (!lines.length) throw new Error('no enquiry lines to quote');

    const qr = this.db.prepare(
      `INSERT INTO quotations (quote_no, enquiry_id, customer) VALUES (?, ?, ?)`
    ).run(quoteNo, enquiryId, customer);
    const quotationId = qr.lastInsertRowid;

    const ins = this.db.prepare(
      `INSERT INTO quotation_lines (quotation_id, line_no, rfq_description, item_id, match_method, match_confidence, qty, uom, recommended_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const issues = [];
    for (const l of lines) {
      const m = this.matcher.match(l.description);
      let itemId = null, method = m.method, conf = m.confidence ?? null, rec = null;
      if (m.method === 'exact' || m.method === 'fuzzy') {
        itemId = m.item.id;
        rec = this.matcher.recommendPrice(itemId, customer, this.cfg.pricing);
      } else {
        issues.push({ line: l.line_no, method: m.method, candidates: (m.candidates || []).map(c => c.sku) });
      }
      ins.run(quotationId, l.line_no, l.description, itemId, method, conf, l.qty ?? 0, l.uom ?? 'EA', rec);
    }
    if (issues.length) {
      this.db.prepare(`INSERT INTO exceptions (workflow, entity_type, entity_id, reason, detail) VALUES ('WF2','quotation',?,?,?)`)
        .run(String(quotationId), 'unmatched-or-ambiguous-lines', JSON.stringify(issues));
    }
    this.audit.log({ workflow: 'WF2', action: 'quotation.draft', entityType: 'quotation', entityId: String(quotationId), outcome: 'ok', detail: { lines: lines.length, issues: issues.length } });
    return { quotationId, issues };
  }

  /** Human resolves an ambiguous/unmatched line by choosing the item. */
  resolveLine(quotationId, lineNo, itemId, userId) {
    const item = this.db.prepare('SELECT id FROM items WHERE id = ?').get(itemId);
    if (!item) throw new Error(`item ${itemId} not found`);
    const q = this.db.prepare('SELECT customer FROM quotations WHERE id = ?').get(quotationId);
    const rec = this.matcher.recommendPrice(itemId, q.customer, this.cfg.pricing);
    this.db.prepare(
      `UPDATE quotation_lines SET item_id=?, match_method='manual', recommended_price=? WHERE quotation_id=? AND line_no=?`
    ).run(itemId, rec, quotationId, lineNo);
    this.audit.log({ actor: userId, workflow: 'WF2', action: 'line.resolved', entityType: 'quotation', entityId: String(quotationId), outcome: 'ok', detail: { lineNo, itemId } });
  }

  /** Human finalises pricing — the only path to a final price (WF2-03). */
  finalisePrice(quotationId, lineNo, price, userId) {
    if (typeof price !== 'number' || price <= 0) throw new Error('final price must be a positive number');
    const r = this.db.prepare(
      `UPDATE quotation_lines SET final_price=?, price_finalised_by=? WHERE quotation_id=? AND line_no=?`
    ).run(price, userId, quotationId, lineNo);
    if (!r.changes) throw new Error(`line ${lineNo} not found on quotation ${quotationId}`);
    this.audit.log({ actor: userId, workflow: 'WF2', action: 'price.finalised', entityType: 'quotation', entityId: String(quotationId), outcome: 'ok', detail: { lineNo, price } });
  }

  /**
   * Request quotation approval — blocked until every line has item + final price.
   *
   * The payload carries a FULL SNAPSHOT of the priced quotation, not just the
   * total. Two reasons, both deliberate:
   *   - an approver must be able to see exactly what they are signing off:
   *     every RFQ line, the SKU it was matched to, how it was matched, the
   *     quantity, the unit price a human set, and the line value;
   *   - the snapshot is frozen at the moment approval was requested, so the
   *     audit trail records what was approved even if the quotation is edited
   *     afterwards. Reading the live quotation back would not prove that.
   */
  requestQuotationApproval(quotationId) {
    const q = this.db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
    if (!q) throw new Error(`quotation ${quotationId} not found`);
    const bad = this.db.prepare(
      `SELECT line_no FROM quotation_lines WHERE quotation_id=? AND (item_id IS NULL OR final_price IS NULL)`
    ).all(quotationId);
    if (bad.length) throw new Error(`lines not ready (item/final price missing): ${bad.map(b => b.line_no).join(',')}`);

    const rows = this.db.prepare(
      `SELECT ql.line_no, ql.rfq_description, ql.qty, ql.uom, ql.match_method, ql.match_confidence,
              ql.recommended_price, ql.final_price, ql.price_finalised_by,
              i.sku, i.description AS item_description
         FROM quotation_lines ql
         LEFT JOIN items i ON i.id = ql.item_id
        WHERE ql.quotation_id = ? ORDER BY ql.line_no`
    ).all(quotationId);

    const lines = rows.map(r => ({
      lineNo: r.line_no,
      rfqDescription: r.rfq_description,
      sku: r.sku || null,
      itemDescription: r.item_description || null,
      matchMethod: r.match_method || null,
      matchConfidence: r.match_confidence == null ? null : +r.match_confidence,
      qty: +r.qty,
      uom: r.uom || null,
      recommendedPrice: r.recommended_price == null ? null : +r.recommended_price,
      finalPrice: +r.final_price,
      pricedBy: r.price_finalised_by || null,
      lineTotal: Math.round(r.final_price * r.qty * 100) / 100,
    }));
    const total = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;

    this.db.prepare('UPDATE quotations SET total=? WHERE id=?').run(total, quotationId);
    return this.approvals.request({
      workflow: 'WF2', kind: 'quotation', entityType: 'quotation', entityId: quotationId,
      payload: {
        quotationId,
        quoteNo: q.quote_no,
        customer: q.customer,
        enquiryId: q.enquiry_id,
        currency: 'INR',
        lineCount: lines.length,
        lines,
        total,
      },
    });
  }

  /** After customer accepts + PO received: create SO (draft in Zoho) and split by stock. */
  async createSalesOrder({ quotationId, customerPoNo, soNo, stockBySku }) {
    const q = this.db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
    if (!q) throw new Error(`quotation ${quotationId} not found`);
    if (q.status !== 'approved' && q.status !== 'sent' && q.status !== 'accepted') {
      throw new Error(`quotation ${quotationId} is '${q.status}' — approve before creating an SO`);
    }
    const zso = await this.zoho.booksCreateSalesOrder({ customer_name: q.customer, reference_number: customerPoNo });
    const r = this.db.prepare(
      `INSERT INTO sales_orders (so_no, quotation_id, customer, customer_po_no, zoho_so_id) VALUES (?, ?, ?, ?, ?)`
    ).run(soNo, quotationId, q.customer, customerPoNo, String(zso.id || ''));
    const soId = r.lastInsertRowid;
    this.audit.log({ workflow: 'WF2', action: 'so.created', entityType: 'so', entityId: String(soId), outcome: 'ok', detail: { customerPoNo } });

    // inventory split
    const lines = this.db.prepare(
      `SELECT ql.*, i.sku FROM quotation_lines ql JOIN items i ON i.id = ql.item_id WHERE ql.quotation_id=?`
    ).all(quotationId);
    const inStock = [], toProcure = [];
    for (const l of lines) {
      const available = stockBySku[l.sku] ?? 0;
      (available >= l.qty ? inStock : toProcure).push(l);
    }
    return { soId, inStock, toProcure };
  }

  /** Create draft Vendor POs for shortfall lines, grouped by vendor, linked via SO–PO Engine, approval-gated. */
  async createVendorPos(soId, groups /* [{vendor, vpoNo, lines:[{sku,qty}]}] */) {
    const out = [];
    for (const g of groups) {
      const zpo = await this.zoho.booksCreatePurchaseOrder({ vendor_name: g.vendor });
      const r = this.db.prepare(
        `INSERT INTO vendor_pos (vpo_no, vendor, zoho_po_id) VALUES (?, ?, ?)`
      ).run(g.vpoNo, g.vendor, String(zpo.id || ''));
      const vpoId = r.lastInsertRowid;
      this.sopo.link(soId, vpoId); // one SO -> many VPOs, integrity enforced
      const approvalId = this.approvals.request({
        workflow: 'WF2', kind: 'vendor_po', entityType: 'vpo', entityId: vpoId,
        payload: { vendor: g.vendor, vpoNo: g.vpoNo, lines: g.lines, soId },
      });
      out.push({ vpoId, approvalId });
    }
    return out;
  }
}
module.exports = { WF2 };
