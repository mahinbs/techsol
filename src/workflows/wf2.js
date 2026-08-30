'use strict';
/**
 * WF2 — Quotation → Sales Order → Inventory → Procurement (SO–PO Engine).
 * Rules enforced in code:
 *  - pricing is recommended, NEVER auto-finalised (WF2-03)
 *  - unmatched lines flag, never guess (WF2-02)
 *  - SO and Vendor POs are review-gated (WF2-06/08)
 */
class WF2 {
  constructor({ db, audit, approvals, zoho, sopo, matcher, cfg, mailer }) {
    Object.assign(this, { db, audit, approvals, zoho, sopo, matcher, cfg });
    this.mailer = mailer || null; // optional outbound SMTP; absent → quote is recorded, not emailed
    this.waSender = null;         // set by the server; used to send a quote to a WhatsApp customer
  }

  /**
   * Email an approved quotation to the customer who raised the enquiry.
   *
   * The recipient is the enquiry's sender — the address the RFQ actually came
   * from — while the greeting uses the (operator-corrected) customer name on
   * the quotation. Sending is triggered by the human approval, so it goes out
   * whenever a mailbox is configured; with none configured the quotation is
   * recorded as a draft, never falsely marked sent. Idempotent per quotation,
   * and a failed send is left retryable.
   */
  async emailApprovedQuotation(quotationId, userId) {
    const q = this.db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
    if (!q) throw new Error(`quotation ${quotationId} not found`);
    const enq = q.enquiry_id
      ? this.db.prepare('SELECT sender, subject, source FROM enquiries WHERE id=?').get(q.enquiry_id)
      : null;
    const to = enq && enq.sender ? enq.sender : null;
    // Send the quotation on the same channel the enquiry came in on. A WhatsApp
    // customer is a phone number and cannot receive an email — that is exactly
    // why an approved quote for a WhatsApp RFQ never arrived before.
    const channel = enq && enq.source === 'whatsapp' ? 'whatsapp' : 'email';

    const key = `wf2-quote-${quotationId}`;
    const existing = this.db.prepare('SELECT id, status FROM outbox WHERE idempotency_key=?').get(key);
    if (existing && existing.status === 'sent') return { deduped: true, emailed: true, to };

    if (!to) {
      this.audit.log({ actor: userId, workflow: 'WF2', action: 'quote.send.skipped', entityType: 'quotation',
        entityId: String(quotationId), outcome: 'failed', detail: { reason: 'no customer address on the enquiry' } });
      return { emailed: false, recorded: false, error: 'This enquiry has no sender address to send the quotation to.' };
    }

    const subject = `Quotation ${q.quote_no}${enq && enq.subject ? ` — re: ${enq.subject}` : ''}`;
    const composed = this._renderQuotationEmail(q);
    const body = composed.text;   // the plain-text version is what the outbox stores

    // WhatsApp carries plain text only, so the customer gets the text quotation;
    // email carries the branded HTML with the logo.
    let canSend, doSend;
    if (channel === 'whatsapp') {
      canSend = !!(this.waSender && this.waSender.isReady());
      doSend = () => this.waSender.send(to, composed.text);
    } else {
      canSend = !!(this.mailer && this.mailer.isReady());
      doSend = () => this.mailer.send({ to, subject, body: composed.text, html: composed.html, attachments: composed.attachments });
    }

    let status = 'recorded', emailed = false, error = null;
    if (canSend) {
      try { await doSend(); status = 'sent'; emailed = true; }
      catch (e) { status = 'failed'; error = e.message; }
    }

    if (existing) {
      this.db.prepare(`UPDATE outbox SET status=?, channel=?, subject=?, body=?, to_addr=?, sent_at=CASE WHEN ?='sent' THEN datetime('now') ELSE sent_at END WHERE id=?`)
        .run(status, channel, subject, body, to, status, existing.id);
    } else {
      this.db.prepare(
        `INSERT INTO outbox (idempotency_key, channel, to_addr, subject, body, status, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ?='sent' THEN datetime('now') ELSE NULL END)`
      ).run(key, channel, to, subject, body, status, status);
    }
    if (emailed) this.db.prepare(`UPDATE quotations SET status='sent' WHERE id=?`).run(quotationId);

    this.audit.log({
      actor: userId, workflow: 'WF2',
      action: emailed ? 'quote.sent' : (canSend ? 'quote.send.failed' : 'quote.recorded'),
      entityType: 'quotation', entityId: String(quotationId),
      outcome: emailed ? 'ok' : (canSend ? 'failed' : 'ok'),
      detail: { to, channel, quoteNo: q.quote_no, emailed, error },
    });
    return { emailed, recorded: !canSend, to, channel, error };
  }

  /**
   * Compose the quotation as a customer sees it: a branded HTML document that
   * looks like a real Techsol quotation, with a plain-text fallback for clients
   * that do not render HTML. Returns { text, html, attachments } — the logo is
   * attached by cid so it shows even when a mail client blocks remote images.
   */
  _renderQuotationEmail(q) {
    const { BRAND } = require('../branding');
    const inr = n => (n == null || isNaN(+n)) ? '—'
      : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    // A guessed customer that is really a mail provider ("GMAIL", "YAHOO") must
    // never appear as the salutation on a customer-facing document.
    const bad = /^(gmail|yahoo|outlook|hotmail|rediff|proton|icloud|live|aol)$/i;
    const customer = (q.customer && !bad.test(q.customer.trim())) ? q.customer.trim() : 'Sir / Madam';
    const dated = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

    const lines = this.db.prepare(
      `SELECT ql.line_no, ql.rfq_description, ql.qty, ql.uom, ql.final_price,
              i.sku, i.description AS item_desc
         FROM quotation_lines ql LEFT JOIN items i ON i.id = ql.item_id
        WHERE ql.quotation_id = ? ORDER BY ql.line_no`
    ).all(q.id);
    let total = 0;
    for (const l of lines) total += (+l.final_price || 0) * (+l.qty || 0);

    // -------- plain-text fallback --------
    const textRows = lines.map(l => {
      const val = (+l.final_price || 0) * (+l.qty || 0);
      const name = l.sku ? `${l.sku} — ${l.item_desc || l.rfq_description}` : l.rfq_description;
      return `${String(l.line_no).padStart(2)}. ${name}\n`
        + `    ${l.qty} ${l.uom || ''} x INR ${inr(l.final_price)}  =  INR ${inr(val)}`;
    }).join('\n');
    const text = [
      `Dear ${customer},`, '',
      'Thank you for your enquiry. We are pleased to submit our quotation as below.', '',
      `Quotation No: ${q.quote_no}    Date: ${dated}`, '',
      'Items', '-----', textRows, '',
      `Total: INR ${inr(total)}`, '',
      'Prices are in INR and exclusive of applicable taxes unless stated otherwise.',
      'This quotation is valid for 30 days from the date of issue.',
      'Kindly confirm your purchase order to proceed.', '',
      'Regards,', BRAND.name, BRAND.tagline,
      `${BRAND.phone}  |  ${BRAND.email}  |  ${BRAND.website}`,
    ].join('\n');

    // -------- branded HTML (table layout, inline styles for mail clients) --------
    const itemRows = lines.map((l, i) => {
      const val = (+l.final_price || 0) * (+l.qty || 0);
      const bg = i % 2 ? '#ffffff' : BRAND.soft;
      const sku = l.sku ? `<div style="font-weight:700;color:${BRAND.navy};font-size:13px">${esc(l.sku)}</div>` : '';
      const desc = esc(l.item_desc || l.rfq_description);
      return `<tr>
        <td style="padding:11px 14px;border-bottom:1px solid ${BRAND.line};background:${bg};color:${BRAND.muted};font-size:12px;text-align:center">${l.line_no}</td>
        <td style="padding:11px 14px;border-bottom:1px solid ${BRAND.line};background:${bg}">${sku}<div style="color:${BRAND.ink};font-size:13px">${desc}</div></td>
        <td style="padding:11px 14px;border-bottom:1px solid ${BRAND.line};background:${bg};color:${BRAND.ink};font-size:13px;text-align:right;white-space:nowrap">${l.qty} ${esc(l.uom || '')}</td>
        <td style="padding:11px 14px;border-bottom:1px solid ${BRAND.line};background:${bg};color:${BRAND.ink};font-size:13px;text-align:right;white-space:nowrap">${inr(l.final_price)}</td>
        <td style="padding:11px 14px;border-bottom:1px solid ${BRAND.line};background:${bg};color:${BRAND.ink};font-size:13px;font-weight:700;text-align:right;white-space:nowrap">${inr(val)}</td>
      </tr>`;
    }).join('');

    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#eef2f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f6;padding:24px 0">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;box-shadow:0 2px 8px rgba(0,72,131,.08)">

  <!-- header -->
  <tr><td style="background:${BRAND.navy};padding:22px 32px" bgcolor="${BRAND.navy}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle"><img src="cid:${BRAND.logoCid}" width="150" alt="${BRAND.name}" style="display:block;height:auto;border:0"></td>
      <td style="vertical-align:middle;text-align:right;color:#cfe6f6;font-size:12px;letter-spacing:.04em">${esc(BRAND.tagline)}<br><span style="color:${BRAND.cyan};font-weight:700;letter-spacing:.14em;font-size:11px">QUOTATION</span></td>
    </tr></table>
  </td></tr>

  <!-- meta -->
  <tr><td style="padding:26px 32px 6px 32px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:top">
        <div style="color:${BRAND.muted};font-size:11px;text-transform:uppercase;letter-spacing:.08em">Quotation for</div>
        <div style="color:${BRAND.ink};font-size:16px;font-weight:700;margin-top:3px">${esc(customer)}</div>
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="color:${BRAND.muted};font-size:11px;text-transform:uppercase;letter-spacing:.08em">Quotation No.</div>
        <div style="color:${BRAND.navy};font-size:16px;font-weight:700;margin-top:3px">${esc(q.quote_no)}</div>
        <div style="color:${BRAND.muted};font-size:12px;margin-top:4px">${dated}</div>
      </td>
    </tr></table>
  </td></tr>

  <!-- intro -->
  <tr><td style="padding:16px 32px 4px 32px;color:${BRAND.ink};font-size:14px;line-height:1.55">
    Dear ${esc(customer)},<br>Thank you for your enquiry. We are pleased to submit our quotation as below.
  </td></tr>

  <!-- items -->
  <tr><td style="padding:14px 32px 0 32px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.line};border-radius:8px;overflow:hidden">
      <tr style="background:${BRAND.cyan}">
        <td style="padding:9px 14px;color:#ffffff;font-size:11px;font-weight:700;text-align:center">#</td>
        <td style="padding:9px 14px;color:#ffffff;font-size:11px;font-weight:700">Item</td>
        <td style="padding:9px 14px;color:#ffffff;font-size:11px;font-weight:700;text-align:right">Qty</td>
        <td style="padding:9px 14px;color:#ffffff;font-size:11px;font-weight:700;text-align:right">Unit (INR)</td>
        <td style="padding:9px 14px;color:#ffffff;font-size:11px;font-weight:700;text-align:right">Amount (INR)</td>
      </tr>
      ${itemRows}
      <tr>
        <td colspan="4" style="padding:13px 14px;text-align:right;color:${BRAND.ink};font-size:14px;font-weight:700;background:${BRAND.soft}">Total</td>
        <td style="padding:13px 14px;text-align:right;color:${BRAND.navy};font-size:15px;font-weight:800;background:${BRAND.soft};white-space:nowrap">₹ ${inr(total)}</td>
      </tr>
    </table>
  </td></tr>

  <!-- terms -->
  <tr><td style="padding:18px 32px 4px 32px;color:${BRAND.muted};font-size:12px;line-height:1.6">
    • Prices are in INR and exclusive of applicable taxes unless stated otherwise.<br>
    • This quotation is valid for 30 days from the date of issue.<br>
    • Kindly confirm your purchase order to proceed.
  </td></tr>

  <tr><td style="padding:14px 32px 22px 32px;color:${BRAND.ink};font-size:14px">
    Regards,<br><b style="color:${BRAND.navy}">${esc(BRAND.name)}</b>
  </td></tr>

  <!-- footer -->
  <tr><td style="background:${BRAND.soft};border-top:1px solid ${BRAND.line};padding:18px 32px">
    <div style="color:${BRAND.navy};font-weight:700;font-size:13px">${esc(BRAND.name)} <span style="color:${BRAND.muted};font-weight:400">· ${esc(BRAND.certs)}</span></div>
    <div style="color:${BRAND.muted};font-size:12px;line-height:1.6;margin-top:6px">
      ${esc(BRAND.address)}<br>
      ${esc(BRAND.phone)} &nbsp;·&nbsp; <a href="mailto:${esc(BRAND.email)}" style="color:${BRAND.cyan};text-decoration:none">${esc(BRAND.email)}</a> &nbsp;·&nbsp; <a href="${esc(BRAND.websiteUrl)}" style="color:${BRAND.cyan};text-decoration:none">${esc(BRAND.website)}</a>
    </div>
  </td></tr>

</table>
<div style="color:#9aa8b4;font-size:11px;font-family:Arial,Helvetica,sans-serif;margin-top:14px">This is a system-generated quotation from ${esc(BRAND.name)}.</div>
</td></tr></table></body></html>`;

    const attachments = [{
      filename: 'techsol-logo.png',
      content: BRAND.logoBase64,
      encoding: 'base64',
      cid: BRAND.logoCid,
      contentType: BRAND.logoType,
    }];

    return { text, html, attachments };
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
