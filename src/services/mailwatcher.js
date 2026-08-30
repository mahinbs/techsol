'use strict';
/**
 * Mail intake service (WF1-01) - polls a nominated mailbox and feeds enquiries
  * into WF1. Runs inside the application process; configuration is stored in the
   * database and edited from the UI, so there are no environment variables and no
    * separate terminal process to babysit.
     *
      * Design rules, all deliberate:
       *   - ONE nominated mailbox, and only messages whose subject matches the
        *     configured filter. Nothing else is read, logged, or ingested.
         *   - Provenance (channel, sender, receiving mailbox, RFC 5322 Message-ID,
          *     original timestamp) is recorded against every enquiry, so any Deal can be
           *     traced back to the exact message that produced it.
            *   - Dedupe is on Message-ID, persisted, so a restart or a reconnect can never
             *     create the same enquiry twice.
              *   - Reads the tail of the mailbox by position rather than relying on the
               *     Seen flag: mail clients mark messages read behind our back.
                *   - Mail is never deleted or modified. The mail server stays an independent
                 *     audit trail.
                  */

                  const DEFAULTS = {
                  enabled: 1,   // a fresh install watches as soon as credentials are saved; start() still refuses to run without them
                  host: 'imap.secureserver.net',
                  port: 993,
                  user: '',
                  pass: '',
                  folder: 'INBOX',
                  subject_filter: 'RFQ',
                  poll_seconds: 15,
                  tail: 30,
                  };

                  class MailWatcher {
                  constructor({ db, audit, onMail }) {
                  this.db = db;
                  this.audit = audit;
                  this.onMail = onMail;
                  this.timer = null;
                  this.running = false;
                  this.lastError = null;
                  this.lastPollAt = null;
                  this.ingestedCount = 0;
                  this._migrate();
                  }

                  _migrate() {
                  this.db.exec(`
                  CREATE TABLE IF NOT EXISTS mail_settings (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  enabled INTEGER NOT NULL DEFAULT 0,
                  host TEXT, port INTEGER, user TEXT, pass TEXT,
                  folder TEXT, subject_filter TEXT,
                  poll_seconds INTEGER, tail INTEGER,
                  updated_at TEXT
                  );
                  CREATE TABLE IF NOT EXISTS mail_seen (
                  message_id TEXT PRIMARY KEY,
                  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                  ingested INTEGER NOT NULL DEFAULT 0
                  );
                  `);
                  const row = this.db.prepare('SELECT id FROM mail_settings WHERE id=1').get();
                  if (!row) {
                  this.db.prepare(
                  `INSERT INTO mail_settings (id, enabled, host, port, user, pass, folder, subject_filter, poll_seconds, tail, updated_at)
                  VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
                  ).run(DEFAULTS.enabled, DEFAULTS.host, DEFAULTS.port, DEFAULTS.user, DEFAULTS.pass,
                  DEFAULTS.folder, DEFAULTS.subject_filter, DEFAULTS.poll_seconds, DEFAULTS.tail);
                  }
                  }

                  _settings() {
                  return this.db.prepare('SELECT * FROM mail_settings WHERE id=1').get() || { ...DEFAULTS };
                  }

                  getSettings() {
                  const s = this._settings();
                  return {
                  enabled: !!s.enabled,
                  host: s.host || '',
                  port: s.port || 993,
                  user: s.user || '',
                  passwordSet: !!(s.pass && s.pass.length),
                  folder: s.folder || 'INBOX',
                  subjectFilter: s.subject_filter || 'RFQ',
                  pollSeconds: s.poll_seconds || 15,
                  };
                  }

                  saveSettings(p = {}) {
                  const cur = this._settings();
                  const next = {
                  enabled: p.enabled === undefined ? cur.enabled : (p.enabled ? 1 : 0),
                  host: p.host ?? cur.host,
                  port: Number(p.port ?? cur.port) || 993,
                  user: p.user ?? cur.user,
                  pass: (p.password && String(p.password).length) ? String(p.password) : cur.pass,
                  folder: p.folder ?? cur.folder ?? 'INBOX',
                  subject_filter: p.subjectFilter ?? cur.subject_filter ?? 'RFQ',
                  poll_seconds: Number(p.pollSeconds ?? cur.poll_seconds) || 15,
                  tail: Number(p.tail ?? cur.tail) || 30,
                  };
                  if (/^inbox$/i.test(next.folder) && !String(next.subject_filter).trim()) {
                  throw new Error('A subject filter is required when watching INBOX, so unrelated mail is never read.');
                  }
                  this.db.prepare(
                  `UPDATE mail_settings SET enabled=?, host=?, port=?, user=?, pass=?, folder=?, subject_filter=?,
                  poll_seconds=?, tail=?, updated_at=datetime('now') WHERE id=1`
                  ).run(next.enabled, next.host, next.port, next.user, next.pass, next.folder,
                  next.subject_filter, next.poll_seconds, next.tail);

                  this.audit.log({
                  workflow: 'WF1', action: 'mail.settings.updated', entityType: 'mailbox',
                  entityId: next.user || null, outcome: 'ok',
                  detail: { folder: next.folder, subjectFilter: next.subject_filter, enabled: !!next.enabled },
                  });

                  this.stop();
                  if (next.enabled) this.start();
                  return this.getSettings();
                  }

                  status() {
                  const s = this.getSettings();
                  return {
                  ...s,
                  running: this.running,
                  lastPollAt: this.lastPollAt,
                  lastError: this.lastError,
                  ingestedCount: this.ingestedCount,
                  };
                  }

                  async _connect(over = null) {
                  const { ImapFlow } = require('imapflow');
                  const s = over || this._settings();
                  if (!s.host || !s.user || !s.pass) throw new Error('Mailbox, host and password are all required.');
                  const client = new ImapFlow({
                  host: s.host, port: Number(s.port) || 993, secure: true,
                  auth: { user: s.user, pass: s.pass }, logger: false,
                  // Fail fast and cleanly instead of letting a dropped or idle TLS
                  // socket sit until the OS kills it. These bound every phase of the
                  // connection so a network hiccup ends inside the awaited call.
                  connectionTimeout: 15000,
                  greetingTimeout: 10000,
                  socketTimeout: 60000,
                  });
                  // ImapFlow is an EventEmitter. A socket 'error' or timeout can be
                  // emitted AFTER the awaited call already returned (e.g. the idle
                  // TLS connection drops between polls). With no 'error' listener,
                  // Node re-throws it as an uncaught exception and Electron kills the
                  // whole app with the "A JavaScript error occurred in the main
                  // process" dialog. Swallow it into lastError — the poll loop opens a
                  // fresh connection on the next tick, so nothing is lost.
                  client.on('error', (err) => {
                  this.lastError = err && err.message ? err.message : String(err);
                  });
                  await client.connect();
                  return client;
                  }

                  async testConnection(p = {}) {
                  const cur = this._settings();
                  const s = {
                  host: p.host || cur.host, port: p.port || cur.port, user: p.user || cur.user,
                  pass: (p.password && String(p.password).length) ? String(p.password) : cur.pass,
                  folder: p.folder || cur.folder || 'INBOX',
                  subject_filter: p.subjectFilter || cur.subject_filter || 'RFQ',
                  tail: Number(p.tail || cur.tail) || 30,
                  };
                  let client;
                  try {
                  client = await this._connect(s);
                  const folders = (await client.list()).map((b) => b.path);
                  let matching = 0, scanned = 0;
                  if (folders.includes(s.folder)) {
                  const lock = await client.getMailboxLock(s.folder);
                  try {
                  const total = client.mailbox?.exists || 0;
                  if (total) {
                  const from = Math.max(1, total - (s.tail - 1));
                  const re = new RegExp(s.subject_filter, 'i');
                  for await (const m of client.fetch(`${from}:*`, { envelope: true })) {
                  scanned++;
                  if (re.test(m.envelope?.subject || '')) matching++;
                  }
                  }
                  } finally { lock.release(); }
                  }
                  await client.logout();
                  this.audit.log({ workflow: 'WF1', action: 'mail.connection.tested', entityType: 'mailbox',
                  entityId: s.user, outcome: 'ok', detail: { folder: s.folder, matching } });
                  return { ok: true, user: s.user, folders: folders.slice(0, 25), scanned, matching,
                  folderExists: folders.includes(s.folder) };
                  } catch (e) {
                  try { if (client) await client.logout(); } catch { /* ignore */ }
                  this.audit.log({ workflow: 'WF1', action: 'mail.connection.tested', entityType: 'mailbox',
                  entityId: s.user, outcome: 'failed', detail: { error: e.message } });
                  const hint = /auth/i.test(e.message)
                  ? 'Check the password. If this mailbox is Microsoft 365, imap.secureserver.net is the wrong host and basic authentication is disabled.'
                  : 'Check the host and port, and that IMAP is enabled for this mailbox.';
                  return { ok: false, error: e.message, hint };
                  }
                  }

                  _isSeen(id) {
                  return !!this.db.prepare('SELECT message_id FROM mail_seen WHERE message_id=?').get(id);
                  }
                  _markSeen(id, ingested) {
                  this.db.prepare('INSERT OR IGNORE INTO mail_seen (message_id, ingested) VALUES (?, ?)')
                  .run(id, ingested ? 1 : 0);
                  }

                  async pollOnce() {
                  const { simpleParser } = require('mailparser');
                  const s = this._settings();
                  let client, ingested = 0, skipped = 0, ingestError = null;
                  this.lastPollAt = new Date().toISOString();
                  try {
                  client = await this._connect(s);
                  const lock = await client.getMailboxLock(s.folder || 'INBOX');
                  try {
                  const total = client.mailbox?.exists || 0;
                  if (total) {
                  const tail = Number(s.tail) || 30;
                  const from = Math.max(1, total - (tail - 1));
                  const re = s.subject_filter ? new RegExp(s.subject_filter, 'i') : null;

                  for await (const msg of client.fetch(`${from}:*`, { source: true })) {
                  const mail = await simpleParser(msg.source);
                  const id = mail.messageId;
                  if (!id || this._isSeen(id)) continue;

                  if (re && !re.test(mail.subject || '')) {
                  // Not an enquiry. Remembered so it is skipped cheaply, and the
                  // subject is deliberately never logged.
                  this._markSeen(id, false);
                  skipped++;
                  continue;
                  }

                  const from_ = (mail.from?.value || [])[0]?.address || null;
                  const deliveredTo = this._headerAddress(mail.headers.get('delivered-to'))
                  || this._headerAddress(mail.headers.get('x-original-to'))
                  || (mail.to?.value || [])[0]?.address || s.user;

                  try {
                  await this.onMail({
                  sender: from_,
                  subject: mail.subject || '(no subject)',
                  body: (mail.text || '').slice(0, 20000),
                  sourceMessageId: id,
                  receivedOn: String(deliveredTo).toLowerCase(),
                  receivedAt: mail.date ? new Date(mail.date).toISOString() : null,
                  });
                  this._markSeen(id, true);
                  ingested++;
                  this.ingestedCount++;
                  } catch (e) {
                  // Not marked seen - an enquiry must never be lost silently, and
                  // the error must survive to the end of the pass so the UI shows it.
                  ingestError = `ingest failed: ${e.message}`;
                  }
                  }
                  }
                  } finally { lock.release(); }
                  await client.logout();
                  this.lastError = ingestError;
                  } catch (e) {
                  this.lastError = e.message;
                  try { if (client) await client.logout(); } catch { /* ignore */ }
                  throw e;
                  }
                  return { ingested, skipped };
                  }

                  _headerAddress(h) {
                  if (!h) return null;
                  if (typeof h === 'string') return h.trim();
                  if (Array.isArray(h)) return this._headerAddress(h[0]);
                  if (h.value?.length) return h.value[0].address || null;
                  if (typeof h.text === 'string') return h.text.trim();
                  return null;
                  }

                  start() {
                  const s = this._settings();
                  if (!s.enabled || !s.host || !s.user || !s.pass) return false;
                  if (this.timer) return true;
                  this.running = true;
                  const every = (Number(s.poll_seconds) || 15) * 1000;
                  const tick = async () => {
                  try { await this.pollOnce(); }
                  catch (e) { this.lastError = e.message; }
                  };
                  tick();
                  this.timer = setInterval(tick, every);
                  if (this.timer.unref) this.timer.unref();
                  this.audit.log({ workflow: 'WF1', action: 'mail.watcher.started', entityType: 'mailbox',
                  entityId: s.user, outcome: 'ok', detail: { folder: s.folder, pollSeconds: s.poll_seconds } });
                  return true;
                  }

                  stop() {
                  if (this.timer) { clearInterval(this.timer); this.timer = null; }
                  if (this.running) {
                  this.running = false;
                  this.audit.log({ workflow: 'WF1', action: 'mail.watcher.stopped', entityType: 'mailbox',
                  entityId: this._settings().user || null, outcome: 'ok' });
                  }
                  }
                  }

                  module.exports = { MailWatcher, MAIL_DEFAULTS: DEFAULTS };
                  
