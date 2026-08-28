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
const { MailWatcher } = require('./src/services/mailwatcher');
const { Mailer } = require('./src/services/mailer');
const { DemoData } = require('./src/services/demodata');
const { WhatsAppWatcher } = require('./src/services/whatsappwatcher');
const { ZohoSettings } = require('./src/services/zohosettings');
const cfg = require('./config/rules.json');

const db = openDb(process.env.DB_PATH || path.join(__dirname, 'data', 'techsol.db'));
const audit = new Audit(db);
const approvals = new Approvals(db, audit);
const zoho = new ZohoClient({ mock: process.env.ZOHO_MOCK !== '0' });
const sopo = new SoPoEngine(db, audit);
const matcher = new Matcher(db, cfg);
const mailer = new Mailer({ db, audit });
const wf1 = new WF1({ db, audit, approvals, zoho, cfg, extractor: heuristicExtractor, mailer });
const wf2 = new WF2({ db, audit, approvals, zoho, sopo, matcher, cfg });

// Mail intake runs inside the app: configuration lives in the database and is
// edited from the UI, so there is no environment variable and no side process.
const mail = new MailWatcher({
  db, audit,
  onMail: async ({ sender, subject, body, sourceMessageId, receivedOn, receivedAt }) => {
    const id = wf1.intake({ sourceMessageId, source: 'email', sender, subject: subject || '', body });
    if (!id) return null;                       // already ingested — WF1 dedupes too
    audit.log({
      workflow: 'WF1', action: 'mail.enquiry.received', entityType: 'enquiry',
      entityId: String(id), outcome: 'ok',
      detail: { channel: 'email', sourceAddress: sender, receivedOn, sourceMessageId, receivedAt },
    });
    await wf1.process(id);
    // Acknowledge automatically when the operator has switched that on; a no-op
    // otherwise, so the acknowledgement simply waits in the approval queue.
    try { await wf1.autoAcknowledge(id); } catch (e) { console.warn('auto-ack failed:', e.message); }
    return id;
  },
});

// WhatsApp intake — same contract as mail, different transport. Kapso is
// polled rather than webhooked so the desktop app needs no public address.
const wa = new WhatsAppWatcher({
  db, audit,
  onMessage: async ({ sender, senderName, subject, body, sourceMessageId, receivedOn, receivedAt, hasMedia, messageType }) => {
    const id = wf1.intake({ sourceMessageId, source: 'whatsapp', sender, subject: subject || '', body });
    if (!id) return null;
    audit.log({
      workflow: 'WF1', action: 'whatsapp.enquiry.received', entityType: 'enquiry',
      entityId: String(id), outcome: 'ok',
      detail: { channel: 'whatsapp', sourceAddress: sender, contactName: senderName,
                receivedOn, sourceMessageId, receivedAt, messageType, hasMedia },
    });
    await wf1.process(id);
    try { await wf1.autoAcknowledge(id); } catch (e) { console.warn('auto-ack failed:', e.message); }
    return id;
  },
});

// Zoho connection settings live in the database and are edited from the UI.
const zohoSettings = new ZohoSettings({ db, audit, zoho });
zohoSettings.apply();

// Demo dataset. `demo.seedOnFirstRun` in config/rules.json decides whether a
// brand-new install comes up with sample work already in it — that is what a
// client should see when they open the app for the first time, instead of empty
// panels asking for credentials they do not have. It only ever fires when the
// database is completely untouched.
const demo = new DemoData({ db, audit, wf1, wf2, sopo });
demo.seedItems();

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
    zohoMode: zoho.mock
      ? 'MOCK (awaiting client OAuth credentials)'
      : `LIVE · ${zoho.describe().isSandboxCrm ? 'sandbox' : 'PRODUCTION'} · Books ${zoho.booksOrg}`,
    demo: demo.status(),
    counts: {
      enquiries: db.prepare('SELECT COUNT(*) c FROM enquiries').get().c,
      quotations: db.prepare('SELECT COUNT(*) c FROM quotations').get().c,
      salesOrders: db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c,
      vendorPos: db.prepare('SELECT COUNT(*) c FROM vendor_pos').get().c,
      pendingApprovals: db.prepare(`SELECT COUNT(*) c FROM approvals WHERE status='pending'`).get().c,
    },
  });
}));

// ---------- demo data ----------
app.get('/api/demo', wrap((req, res) => res.json(demo.status())));
app.post('/api/demo/seed', wrap(async (req, res) => res.json(await demo.seed({ force: !!req.body?.force }))));
app.post('/api/demo/reset', wrap((req, res) => res.json(demo.reset())));

// ---------- WF1 ----------
app.post('/api/enquiries', wrap(async (req, res) => {
  const { sender, subject, body } = req.body;
  if (!sender || !body) throw new Error('sender and body are required');
  const id = wf1.intake({
    sourceMessageId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'email', sender, subject: subject || '', body,
  });
  const out = await wf1.process(id);
  const auto = await wf1.autoAcknowledge(id);
  res.json({ enquiryId: id, ...out, autoAck: auto });
}));
// ---------- mail intake ----------
app.get('/api/mail/settings', wrap((req, res) => res.json(mail.status())));
app.post('/api/mail/settings', wrap((req, res) => res.json(mail.saveSettings(req.body || {}))));
app.post('/api/mail/test', wrap(async (req, res) => res.json(await mail.testConnection(req.body || {}))));
app.post('/api/mail/poll', wrap(async (req, res) => {
  const out = await mail.pollOnce();
  res.json({ ...out, status: mail.status() });
}));

// ---------- outbound mail (SMTP) ----------
app.get('/api/smtp/settings', wrap((req, res) => res.json(mailer.status())));
app.post('/api/smtp/settings', wrap((req, res) => res.json(mailer.saveSettings(req.body || {}))));
app.post('/api/smtp/test', wrap(async (req, res) => res.json(await mailer.testConnection(req.body || {}))));

// ---------- whatsapp intake ----------
app.get('/api/whatsapp/settings', wrap((req, res) => res.json(wa.status())));
app.post('/api/whatsapp/settings', wrap((req, res) => res.json(wa.saveSettings(req.body || {}))));
app.post('/api/whatsapp/test', wrap(async (req, res) => res.json(await wa.testConnection(req.body || {}))));
app.post('/api/whatsapp/poll', wrap(async (req, res) => {
  const out = await wa.pollOnce();
  res.json({ ...out, status: wa.status() });
}));

// ---------- zoho connection ----------
app.get('/api/zoho/settings', wrap((req, res) => res.json(zohoSettings.status())));
app.post('/api/zoho/settings', wrap((req, res) => res.json(zohoSettings.save(req.body || {}))));
app.post('/api/zoho/test', wrap(async (req, res) => res.json(await zohoSettings.test())));

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
  if (a.kind === 'ack_email') result = await wf1.sendApproved(id, user, edited);
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
/** Every enquiry that could be quoted, whatever channel it arrived on. */
app.get('/api/quotations', wrap((req, res) => {
  res.json(db.prepare(
    `SELECT q.id, q.quote_no, q.customer, q.status, q.total, q.enquiry_id, q.created_at,
            (SELECT COUNT(*) FROM quotation_lines ql WHERE ql.quotation_id = q.id) AS line_count
       FROM quotations q ORDER BY q.id DESC LIMIT 50`
  ).all());
}));

app.post('/api/quotations', wrap((req, res) => {
  const { enquiryId } = req.body;
  const enq = db.prepare('SELECT * FROM enquiries WHERE id=?').get(enquiryId);
  if (!enq) throw new Error('enquiry not found');
  // One quotation per enquiry. Asking again opens the one that exists rather
  // than failing on the duplicate quote number or quietly making a second.
  const already = db.prepare('SELECT id, quote_no FROM quotations WHERE enquiry_id=?').get(enquiryId);
  if (already) return res.json({ quotationId: already.id, quoteNo: already.quote_no, issues: [], existing: true });
  // The extracted customer is a guess off the signature or the sender address —
  // "GMAIL" for a personal mailbox — and it ends up on the quotation. Whatever
  // the operator typed wins over the guess.
  const guessed = (enq.extracted && JSON.parse(enq.extracted).customer?.value) || enq.sender;
  const customer = (typeof req.body.customer === 'string' && req.body.customer.trim())
    ? req.body.customer.trim()
    : guessed;
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
app.get('/api/exceptions', wrap((req, res) => {
  // Carry the human-readable reference (Q-271002, not "quotation #2") so the
  // queue tells a reviewer which document to open.
  res.json(db.prepare(
    `SELECT e.*,
            q.quote_no AS quotation_ref,
            en.subject AS enquiry_ref
       FROM exceptions e
       LEFT JOIN quotations q ON e.entity_type='quotation' AND q.id = CAST(e.entity_id AS INTEGER)
       LEFT JOIN enquiries en ON e.entity_type='enquiry'  AND en.id = CAST(e.entity_id AS INTEGER)
      ORDER BY e.id DESC LIMIT 50`
  ).all());
}));
app.get('/api/outbox', wrap((req, res) => res.json(db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 50').all())));

const PORT = process.env.PORT || 4577;
app.listen(PORT, () => {
  console.log(`Techsol Automation WF1/WF2 running → http://localhost:${PORT}  (Zoho: ${zoho.mock ? 'MOCK' : 'LIVE'})`);
  // Resume mail intake if it was left enabled — the app must come back up in
  // the state the user left it, without anyone re-entering credentials.
  try {
    if (mail.start()) console.log(`Mail intake: watching ${mail.getSettings().user}`);
  } catch (e) { console.warn('Mail intake not started:', e.message); }
  try {
    if (wa.start()) console.log(`WhatsApp intake: watching ${wa.getSettings().phoneNumberId}`);
  } catch (e) { console.warn('WhatsApp intake not started:', e.message); }
  // First run on a demo build: fill the app with sample work so it opens on
  // something to look at. Never runs again, and never over real enquiries.
  if (cfg.demo?.seedOnFirstRun && demo.isEmpty()) {
    demo.seed()
      .then(r => console.log(`Demo data loaded: ${r.enquiries.length} enquiries, quotation ${r.quoteNo}`))
      .catch(e => console.warn('Demo data not loaded:', e.message));
  }
});
