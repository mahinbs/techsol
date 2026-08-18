'use strict';
/**
 * Techsol Automation — WF1/WF2 application server.
 * Real engines + real database. Zoho runs in MOCK mode until the client's
 * OAuth self-client is provisioned (set ZOHO_MOCK=0 + credentials to go live).
 *
 * Run:  npm install && npm start   → http://localhost:4577
 */
const path = require('path');
const express = require('express');
const { openDb } = require('./src/db');
const { Audit } = require('./src/services/audit');
const { Approvals } = require('./src/services/approvals');
const { SoPoEngine } = require('./src/engines/sopo');
const { Matcher } = require('./src/engines/match');
const { ZohoClient } = require('./src/integrations/zoho');
const { WF1 } = require('./src/workflows/wf1');
const { WF2 } = require('./src/workflows/wf2');
const { heuristicExtractor } = require('./src/extractor');
const cfg = require('./config/rules.json');

const db = openDb(process.env.DB_PATH || path.join(__dirname, 'data', 'techsol.db'));
const audit = new Audit(db);
const approvals = new Approvals(db, audit);
const zoho = new ZohoClient({ mock: process.env.ZOHO_MOCK !== '0' });
const sopo = new SoPoEngine(db, audit);
const matcher = new Matcher(db, cfg);
const wf1 = new WF1({ db, audit, approvals, zoho, cfg, extractor: heuristicExtractor });
const wf2 = new WF2({ db, audit, approvals, zoho, sopo, matcher, cfg });

// seed item master from the client's RFQ domain if empty (replaced by real master import)
if (!db.prepare('SELECT COUNT(*) c FROM items').get().c) {
  const ins = db.prepare('INSERT INTO items (sku, description, spec, list_price) VALUES (?, ?, ?, ?)');
  [
    ['UC-08-SS316', 'OD 08MM THK 1MM Union Coupling SS316', 'SS316', 142],
    ['SC-08-DBP', 'OD 08MM Straight Type DBP Connector', 'SS316', 96.5],
    ['PC-08-BOX', 'Box Type Pipe Clamp 08MM', 'MS', 58],
    ['MC-08-SS316', 'OD 08MM Male Connector SS316', 'SS316', 110],
    ['MUC-08-SS316', 'OD 08MM Male Union Connector SS316', 'SS316', 112],
    ['EC-08-SS316', 'OD 08MM Elbow Connector SS316', 'SS316', 104],
  ].forEach(r => ins.run(...r));
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
};

// ---------- meta ----------
app.get('/api/status', wrap((req, res) => {
  res.json({
    app: 'Techsol Automation — WF1/WF2',
    version: require('./package.json').version,
    zohoMode: zoho.mock ? 'MOCK (awaiting client OAuth credentials)' : 'LIVE',
    counts: {
      enquiries: db.prepare('SELECT COUNT(*) c FROM enquiries').get().c,
      quotations: db.prepare('SELECT COUNT(*) c FROM quotations').get().c,
      salesOrders: db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c,
      vendorPos: db.prepare('SELECT COUNT(*) c FROM vendor_pos').get().c,
      pendingApprovals: db.prepare(`SELECT COUNT(*) c FROM approvals WHERE status='pending'`).get().c,
    },
  });
}));

// ---------- WF1 ----------
app.post('/api/enquiries', wrap(async (req, res) => {
  const { sender, subject, body } = req.body;
  if (!sender || !body) throw new Error('sender and body are required');
  const id = wf1.intake({
    sourceMessageId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'email', sender, subject: subject || '', body,
  });
  const out = await wf1.process(id);
  res.json({ enquiryId: id, ...out });
}));
app.get('/api/enquiries', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM enquiries ORDER BY id DESC LIMIT 50').all()
    .map(e => ({ ...e, extracted: e.extracted ? JSON.parse(e.extracted) : null,
      lines: db.prepare('SELECT * FROM enquiry_lines WHERE enquiry_id=? ORDER BY line_no').all(e.id) }));
  res.json(rows);
}));

// ---------- approvals ----------
app.get('/api/approvals', wrap((req, res) => {
  res.json(approvals.pending().map(a => ({ ...a, payload: JSON.parse(a.payload) })));
}));
app.post('/api/approvals/:id/approve', wrap(async (req, res) => {
  const id = +req.params.id;
  const a = db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
  if (!a) throw new Error('approval not found');
  const user = req.body.user || 'reviewer';
  const edited = req.body.editedPayload || null;
  let result;
  if (a.kind === 'ack_email') result = wf1.sendApproved(id, user, edited);
  else { approvals.approve(id, user, edited); result = { approved: true }; }
  if (a.kind === 'quotation') db.prepare(`UPDATE quotations SET status='approved' WHERE id=?`).run(a.entity_id);
  if (a.kind === 'vendor_po') { db.prepare(`UPDATE vendor_pos SET status='ordered' WHERE id=?`).run(a.entity_id); }
  res.json(result);
}));
app.post('/api/approvals/:id/reject', wrap((req, res) => {
  approvals.reject(+req.params.id, req.body.user || 'reviewer', req.body.note || '');
  res.json({ rejected: true });
}));

// ---------- WF2 ----------
app.post('/api/quotations', wrap((req, res) => {
  const { enquiryId } = req.body;
  const enq = db.prepare('SELECT * FROM enquiries WHERE id=?').get(enquiryId);
  if (!enq) throw new Error('enquiry not found');
  const customer = (enq.extracted && JSON.parse(enq.extracted).customer?.value) || enq.sender;
  const quoteNo = `Q-${271000 + enquiryId}`;
  const out = wf2.buildQuotation(enquiryId, customer, quoteNo);
  res.json({ ...out, quoteNo });
}));
app.get('/api/quotations/:id', wrap((req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(+req.params.id);
  if (!q) throw new Error('quotation not found');
  const lines = db.prepare(
    `SELECT ql.*, i.sku, i.description AS item_desc FROM quotation_lines ql
     LEFT JOIN items i ON i.id = ql.item_id WHERE ql.quotation_id=? ORDER BY ql.line_no`
  ).all(q.id);
  res.json({ ...q, lines });
}));
app.get('/api/items', wrap((req, res) => res.json(db.prepare('SELECT * FROM items ORDER BY sku').all())));
app.post('/api/quotations/:id/lines/:no/resolve', wrap((req, res) => {
  wf2.resolveLine(+req.params.id, +req.params.no, +req.body.itemId, req.body.user || 'reviewer');
  res.json({ ok: true });
}));
app.post('/api/quotations/:id/lines/:no/price', wrap((req, res) => {
  wf2.finalisePrice(+req.params.id, +req.params.no, +req.body.price, req.body.user || 'commercial');
  res.json({ ok: true });
}));
app.post('/api/quotations/:id/request-approval', wrap((req, res) => {
  res.json({ approvalId: wf2.requestQuotationApproval(+req.params.id) });
}));

app.post('/api/salesorders', wrap(async (req, res) => {
  const { quotationId, customerPoNo, stockBySku = {} } = req.body;
  const soNo = `SO-${270900 + (+quotationId)}`;
  const out = await wf2.createSalesOrder({ quotationId: +quotationId, customerPoNo, soNo, stockBySku });
  res.json({ ...out, soNo });
}));
app.post('/api/salesorders/:soId/vendorpos', wrap(async (req, res) => {
  const groups = req.body.groups || [];
  groups.forEach((g, i) => { if (!g.vpoNo) g.vpoNo = `VPO-${88000 + Date.now() % 1000 + i}`; });
  res.json(await wf2.createVendorPos(+req.params.soId, groups));
}));
app.get('/api/salesorders/:soId/sopo', wrap((req, res) => res.json(sopo.rollup(+req.params.soId))));

// ---------- transparency ----------
app.get('/api/audit', wrap((req, res) => res.json(audit.recent(80))));
app.get('/api/exceptions', wrap((req, res) => res.json(db.prepare(`SELECT * FROM exceptions ORDER BY id DESC LIMIT 50`).all())));
app.get('/api/outbox', wrap((req, res) => res.json(db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 50').all())));

const PORT = process.env.PORT || 4577;
app.listen(PORT, () => console.log(`Techsol Automation WF1/WF2 running → http://localhost:${PORT}  (Zoho: ${zoho.mock ? 'MOCK' : 'LIVE'})`));
