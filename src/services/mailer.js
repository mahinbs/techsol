'use strict';
/**
 * Outbound mail (WF1) — the piece that actually sends the acknowledgement.
 *
 * Until now "Approve & send" only wrote a row to the outbox and called it sent;
 * nothing left the building. This service is the real SMTP transport, and it is
 * deliberately conservative:
 *   - It sends ONLY when it is configured (host, user, password) AND explicitly
 *     switched on. A demo install, or one where SMTP was never set up, sends
 *     nothing — the acknowledgement is recorded as a draft, never falsely
 *     marked "sent".
 *   - The password is stored on this machine and never returned to the browser.
 *   - "Send acknowledgement replies automatically" is a separate switch. With it
 *     on, an arriving RFQ is acknowledged without anyone approving; with it off,
 *     the acknowledgement waits in the approval queue as before.
 *
 * transportFactory is a test seam: production leaves it undefined and nodemailer
 * is used; tests inject a fake so no real mail is sent.
 */

const DEFAULTS = {
  auto_send: 0,                         // auto-acknowledge arriving RFQs
  host: 'smtpout.secureserver.net',
  port: 465,
  secure: 1,
  user: '',
  pass: '',
  from_name: 'Techsol Engineers',
  from_addr: '',                        // defaults to the username if blank
};

class Mailer {
  constructor({ db, audit, transportFactory } = {}) {
    this.db = db;
    this.audit = audit;
    this._transportFactory = transportFactory || null;
    this.lastError = null;
    this.lastSentAt = null;
    this.sentCount = 0;
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS smtp_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        auto_send INTEGER NOT NULL DEFAULT 0,
        host TEXT, port INTEGER, secure INTEGER NOT NULL DEFAULT 1,
        user TEXT, pass TEXT, from_name TEXT, from_addr TEXT,
        updated_at TEXT
      );
    `);
    if (!this.db.prepare('SELECT id FROM smtp_settings WHERE id=1').get()) {
      this.db.prepare(
        `INSERT INTO smtp_settings (id, auto_send, host, port, secure, user, pass, from_name, from_addr, updated_at)
         VALUES (1,?,?,?,?,?,?,?,?,datetime('now'))`
      ).run(DEFAULTS.auto_send, DEFAULTS.host, DEFAULTS.port, DEFAULTS.secure,
            DEFAULTS.user, DEFAULTS.pass, DEFAULTS.from_name, DEFAULTS.from_addr);
    }
  }

  _row() {
    return this.db.prepare('SELECT * FROM smtp_settings WHERE id=1').get() || { ...DEFAULTS };
  }

  /** Enough to actually send: a host, a login, and a password. */
  isReady() {
    const s = this._row();
    return !!(s.host && s.user && s.pass);
  }

  /** Sending is only automatic when it is both configured and switched on. */
  autoSendOn() {
    return !!this._row().auto_send && this.isReady();
  }

  /** Never returns the password. */
  status() {
    const s = this._row();
    return {
      autoSend: !!s.auto_send,
      host: s.host || '',
      port: s.port || 465,
      secure: !!s.secure,
      user: s.user || '',
      fromName: s.from_name || '',
      fromAddr: s.from_addr || s.user || '',
      passwordSet: !!(s.pass && s.pass.length),
      ready: this.isReady(),
      sending: this.autoSendOn(),
      lastError: this.lastError,
      lastSentAt: this.lastSentAt,
      sentCount: this.sentCount,
    };
  }

  /** Blank password means "keep the stored one". */
  saveSettings(p = {}) {
    const cur = this._row();
    const next = {
      auto_send: p.autoSend === undefined ? cur.auto_send : (p.autoSend ? 1 : 0),
      host: (p.host ?? cur.host ?? DEFAULTS.host).trim(),
      port: Number(p.port ?? cur.port) || 465,
      secure: p.secure === undefined ? cur.secure : (p.secure ? 1 : 0),
      user: (p.user ?? cur.user ?? '').trim(),
      pass: (p.password && String(p.password).length) ? String(p.password) : cur.pass,
      from_name: (p.fromName ?? cur.from_name ?? DEFAULTS.from_name).trim(),
      from_addr: (p.fromAddr ?? cur.from_addr ?? '').trim(),
    };
    if (next.auto_send && !(next.host && next.user && next.pass)) {
      throw new Error('Enter the mailbox, host and password before turning on automatic sending.');
    }
    this.db.prepare(
      `UPDATE smtp_settings SET auto_send=?, host=?, port=?, secure=?, user=?, pass=?, from_name=?, from_addr=?,
       updated_at=datetime('now') WHERE id=1`
    ).run(next.auto_send, next.host, next.port, next.secure, next.user, next.pass,
          next.from_name, next.from_addr);
    this.audit.log({
      workflow: 'WF1', action: 'smtp.settings.updated', entityType: 'mailbox',
      entityId: next.user || null, outcome: 'ok',
      detail: { host: next.host, autoSend: !!next.auto_send },
    });
    return this.status();
  }

  _transport(over = null) {
    const s = over || this._row();
    const opts = {
      host: s.host, port: Number(s.port) || 465, secure: !!s.secure,
    };
    if (s.user) opts.auth = { user: s.user, pass: s.pass };
    if (this._transportFactory) return this._transportFactory(opts);
    return require('nodemailer').createTransport(opts);
  }

  /** Verify the login without sending anything. */
  async testConnection(p = {}) {
    const cur = this._row();
    const s = {
      host: (p.host || cur.host || '').trim(),
      port: Number(p.port || cur.port) || 465,
      secure: p.secure === undefined ? cur.secure : (p.secure ? 1 : 0),
      user: (p.user || cur.user || '').trim(),
      pass: (p.password && String(p.password).length) ? String(p.password) : cur.pass,
    };
    if (!s.host || !s.user || !s.pass) return { ok: false, error: 'Mailbox, host and password are all required.' };
    try {
      const tx = this._transport(s);
      await tx.verify();
      this.audit.log({ workflow: 'WF1', action: 'smtp.connection.tested', entityType: 'mailbox',
        entityId: s.user, outcome: 'ok' });
      return { ok: true, user: s.user, host: s.host };
    } catch (e) {
      this.audit.log({ workflow: 'WF1', action: 'smtp.connection.tested', entityType: 'mailbox',
        entityId: s.user, outcome: 'failed', detail: { error: e.message } });
      const hint = /auth|535|credential|password/i.test(e.message)
        ? 'The mailbox rejected the login. Check the password; if this is Microsoft 365, basic SMTP auth may be disabled.'
        : 'Check the host and port, and that outbound SMTP is allowed for this mailbox.';
      return { ok: false, error: e.message, hint };
    }
  }

  /**
   * Send one message. Throws on failure so callers can leave the item unsent
   * and retryable. Never called unless isReady().
   */
  async send({ to, subject, body, html, attachments }) {
    const s = this._row();
    const from = s.from_name
      ? `"${s.from_name}" <${s.from_addr || s.user}>`
      : (s.from_addr || s.user);
    const tx = this._transport(s);
    try {
      // Send multipart when an HTML body is supplied: the plain text is the
      // fallback for clients that do not render HTML.
      const msg = { from, to, subject, text: body };
      if (html) msg.html = html;
      if (attachments && attachments.length) msg.attachments = attachments;
      const info = await tx.sendMail(msg);
      this.lastSentAt = new Date().toISOString();
      this.sentCount++;
      this.lastError = null;
      return { ok: true, messageId: info.messageId || null };
    } catch (e) {
      this.lastError = e.message;
      throw e;
    }
  }
}

module.exports = { Mailer, SMTP_DEFAULTS: DEFAULTS };
