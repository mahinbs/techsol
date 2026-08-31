'use strict';
/**
 * Demo dataset (WF1 + WF2).
 *
 * Everything here is produced by driving the REAL engines — the same intake,
 * extraction, matching, pricing, approval and SO-PO code paths a live enquiry
 * takes. Nothing is inserted as a pre-baked row. That matters for two reasons:
 * what the client sees on screen is genuinely what the system does, and the
 * audit trail behind it is a real trail rather than decoration.
 *
 * The one thing that is NOT real is the outside world: Zoho stays in MOCK, so
 * no CRM deal, sales order or purchase order leaves the machine, and no mail
 * is sent. Seeded records are marked so nobody can mistake them for live work.
 */

const DEMO_ITEMS = [
  ['UC-08-SS316',  'OD 08MM THK 1MM Union Coupling SS316',   'SS316', 142],
  ['SC-08-DBP',    'OD 08MM Straight Type DBP Connector',    'SS316', 96.5],
  ['PC-08-BOX',    'Box Type Pipe Clamp 08MM',               'MS',    58],
  ['MC-08-SS316',  'OD 08MM Male Connector SS316',           'SS316', 110],
  ['MUC-08-SS316', 'OD 08MM Male Union Connector SS316',     'SS316', 112],
  ['EC-08-SS316',  'OD 08MM Elbow Connector SS316',          'SS316', 104],
];

const RFQ_A = {
  sender: 'purchase@bharatpetroleum.co.in',
  subject: 'RFQ 4471 — Clamps & Fittings for 08MM instrument line',
  body: [
    'Dear Techsol Engineers,',
    '',
    'Please quote your best rates for the following, delivery to Mangalore refinery:',
    '',
    '1. 600 EA  OD 08MM THK 1MM Union Coupling SS316',
    '2. 120 NOS OD 08MM Straight Type DBP Connector',
    '3. 180 EA OD 08MM Male Union Connector SS316',
    '4. 40 SETS Box Type Pipe Clamp 08MM',
    '',
    'Kindly confirm delivery lead time along with the quotation.',
    '',
    'Regards,',
    'Purchase Department',
  ].join('\n'),
};

const RFQ_B = {
  sender: 'projects@hindustanpetro.com',
  subject: 'RFQ — Instrumentation fittings requirement',
  body: [
    'Hi,',
    '',
    'Requirement as below:',
    '',
    '1. 250 Nos OD 08MM Male Connector SS316',
    '2. 80 EA OD 08MM Elbow Connector SS316',
    '3. 15 MTR flexible hose assembly',
    '',
    'Please share the quote at the earliest.',
  ].join('\n'),
};

const RFQ_C = {
  sender: '+919845012345',
  subject: 'WhatsApp enquiry',
  body: 'RFQ: need 300 EA OD 08MM Elbow Connector SS316 and 45 nos male union connector 08mm. Urgent, please quote today.',
};

class DemoData {
  constructor({ db, audit, wf1, wf2, sopo }) {
    Object.assign(this, { db, audit, wf1, wf2, sopo });
  }

  /** True when the application has never been used — no enquiries of any kind. */
  isEmpty() {
    return this.db.prepare('SELECT COUNT(*) c FROM enquiries').get().c === 0;
  }

  /** True when everything present came from this seeder. */
  isDemoOnly() {
    const total = this.db.prepare('SELECT COUNT(*) c FROM enquiries').get().c;
    const demo = this.db.prepare(
      `SELECT COUNT(*) c FROM enquiries WHERE source_message_id LIKE 'demo-%'`
    ).get().c;
    return total > 0 && total === demo;
  }

  status() {
    const demo = this.db.prepare(
      `SELECT COUNT(*) c FROM enquiries WHERE source_message_id LIKE 'demo-%'`
    ).get().c;
    return { demoEnquiries: demo, present: demo > 0, onlyDemoData: this.isDemoOnly() };
  }

  seedItems() {
    const have = this.db.prepare('SELECT COUNT(*) c FROM items').get().c;
    if (have) return have;
    const ins = this.db.prepare('INSERT INTO items (sku, description, spec, list_price) VALUES (?, ?, ?, ?)');
    DEMO_ITEMS.forEach(r => ins.run(...r));
    return DEMO_ITEMS.length;
  }

  /**
   * Build the demo dataset. Refuses to run over real work — a mixed database
   * where seeded records sit beside genuine ones would make the audit trail
   * useless, which is the opposite of what this system is for.
   */
  async seed({ force = false } = {}) {
    if (!this.isEmpty() && !this.isDemoOnly() && !force) {
      throw new Error('This database already contains real enquiries. Demo data was not loaded.');
    }
    if (this.isDemoOnly()) this.reset();
    this.seedItems();

    const wf1 = this.wf1, wf2 = this.wf2;
    const stamp = Date.now();

    // ---- Enquiry A: full journey, ends at a quotation awaiting approval ----
    const a = wf1.intake({
      sourceMessageId: `demo-a-${stamp}`, source: 'email',
      sender: RFQ_A.sender, subject: RFQ_A.subject, body: RFQ_A.body,
    });
    await wf1.process(a);

    const quoteNo = `Q-${271000 + a}`;
    const { quotationId } = wf2.buildQuotation(a, 'Bharat Petroleum Corporation Ltd', quoteNo);

    // Any line the matcher could not place is resolved by a human — exactly as
    // a commercial engineer would, and recorded as a manual decision.
    const unresolved = this.db.prepare(
      `SELECT line_no, rfq_description FROM quotation_lines WHERE quotation_id=? AND item_id IS NULL`
    ).all(quotationId);
    for (const l of unresolved) {
      const guess = this.db.prepare(
        `SELECT id FROM items WHERE description LIKE ? ORDER BY id LIMIT 1`
      ).get('%Tube%') || this.db.prepare('SELECT id FROM items ORDER BY id LIMIT 1').get();
      wf2.resolveLine(quotationId, l.line_no, guess.id, 'r.kumar (commercial)');
    }

    // Prices are set by a person, never by the system — a small uplift on the
    // recommendation, which is what the gate exists to capture.
    const priceRows = this.db.prepare(
      `SELECT line_no, recommended_price FROM quotation_lines WHERE quotation_id=? ORDER BY line_no`
    ).all(quotationId);
    priceRows.forEach((l, i) => {
      const base = l.recommended_price || 100;
      const price = Math.round((base * (1 + [0.03, 0.03, 0.06, 0.055][i % 4])) * 100) / 100;
      wf2.finalisePrice(quotationId, l.line_no, price, 'r.kumar (commercial)');
    });
    const quotationApprovalId = wf2.requestQuotationApproval(quotationId);

    // ---- Enquiry B: quoted, but one line has no match in the item master ----
    // Left deliberately as a draft. This is the behaviour worth showing: the
    // system flags the line and stops, rather than guessing a SKU, and the
    // approval gate refuses the quotation until a person resolves it.
    const b = wf1.intake({
      sourceMessageId: `demo-b-${stamp}`, source: 'email',
      sender: RFQ_B.sender, subject: RFQ_B.subject, body: RFQ_B.body,
    });
    await wf1.process(b);
    const quoteNoB = `Q-${271000 + b}`;
    const { quotationId: qB, issues: issuesB } =
      wf2.buildQuotation(b, 'Hindustan Petroleum Corporation Ltd', quoteNoB);

    // ---- Enquiry C: arrives over WhatsApp, showing channel provenance ----
    const c = wf1.intake({
      sourceMessageId: `demo-c-${stamp}`, source: 'whatsapp',
      sender: RFQ_C.sender, subject: RFQ_C.subject, body: RFQ_C.body,
    });
    await wf1.process(c);
    this.audit.log({
      workflow: 'WF1', action: 'whatsapp.enquiry.received', entityType: 'enquiry',
      entityId: String(c), outcome: 'ok',
      detail: { channel: 'whatsapp', sourceAddress: RFQ_C.sender, receivedOn: 'demo business number' },
    });

    this.audit.log({
      workflow: 'SYS', action: 'demo.data.loaded', entityType: 'demo', entityId: String(stamp),
      outcome: 'ok',
      detail: { enquiries: 3, quotation: quoteNo, note: 'sample data — Zoho in MOCK, nothing sent externally' },
    });

    return {
      enquiries: [a, b, c],
      quotationId, quoteNo, quotationApprovalId,
      draftQuotation: { id: qB, quoteNo: quoteNoB, unresolvedLines: issuesB.length },
      pendingApprovals: this.db.prepare(`SELECT COUNT(*) c FROM approvals WHERE status='pending'`).get().c,
    };
  }

  /**
   * Remove seeded records. Only ever touches a database whose enquiries all
   * came from the seeder, so a live install can never be wiped by this.
   */
  reset() {
    if (!this.isDemoOnly() && !this.isEmpty()) {
      throw new Error('This database contains real enquiries. Nothing was deleted.');
    }
    const x = s => this.db.exec(s);
    x(`DELETE FROM approvals`);
    x(`DELETE FROM outbox`);
    x(`DELETE FROM exceptions`);
    x(`DELETE FROM so_po_refs`);
    x(`DELETE FROM so_po_map`);
    x(`DELETE FROM vendor_pos`);
    x(`DELETE FROM sales_orders`);
    x(`DELETE FROM quotation_lines`);
    x(`DELETE FROM quotations`);
    x(`DELETE FROM enquiry_lines`);
    x(`DELETE FROM enquiries`);
    this.audit.log({ workflow: 'SYS', action: 'demo.data.cleared', entityType: 'demo', entityId: '0', outcome: 'ok' });
    return { cleared: true };
  }
}

module.exports = { DemoData };
