'use strict';

/**
 * Central failure notifier (requirement #18).
 *
 * Any critical failure — a Zoho API write, an email send, and later the WMS
 * stock check — is (1) written to the audit trail, (2) raised in the exceptions
 * queue so it shows in "Needs attention", and (3) emailed to a configured ops
 * address so a person is actually told, rather than the failure sitting silent.
 *
 * The operations that call this already stop safely BEFORE the failure point
 * (e.g. the local Sales Order row is only written after Zoho succeeds), so an
 * alert never means a half-written or duplicated record — it means the step was
 * abandoned cleanly and needs a human.
 *
 * Emails are rate-limited per context so a flapping integration cannot flood the
 * inbox, and notify() never throws — alerting must not break the caller.
 */
class Alerter {
  constructor({ db, audit, mailer, cfg } = {}) {
    this.db = db;
    this.audit = audit;
    this.mailer = mailer || null;
    this.opts = (cfg && cfg.alerts) || {};
    this._lastSent = new Map(); // context -> epoch ms of last email
  }

  /** Where alerts go: explicit config, else the address the app already sends from. */
  recipient() {
    const explicit = this.opts.email && String(this.opts.email).trim();
    if (explicit) return explicit;
    try {
      const s = this.mailer && this.mailer.status ? this.mailer.status() : null;
      return (s && (s.fromAddr || s.user)) || '';
    } catch { return ''; }
  }

  /**
   * Record and (rate-limited) email a failure.
   * @returns {Promise<{emailed:boolean, to?:string, reason?:string}>}
   */
  async notify({ context, error, workflow = 'core', entityType = null, entityId = null, detail = {} } = {}) {
    const message = (error && error.message) || String(error || 'unknown error');
    const eid = entityId != null ? String(entityId) : null;

    // 1) Audit + exceptions queue — always, even with no mailbox configured.
    try {
      this.audit.log({ workflow, action: `alert.${context}`, entityType, entityId: eid, outcome: 'error', detail: { message, ...detail } });
    } catch { /* audit must never break alerting */ }
    try {
      this.db.prepare(
        `INSERT INTO exceptions (workflow, entity_type, entity_id, reason, detail) VALUES (?, ?, ?, ?, ?)`
      ).run(workflow, entityType, eid, `failure:${context}`, JSON.stringify({ message, ...detail }));
    } catch { /* best-effort */ }

    // 2) Rate-limited alert email.
    const to = this.recipient();
    if (!to || !this.mailer) return { emailed: false, reason: 'no recipient or mailer configured' };
    const minMs = (this.opts.minIntervalMinutes ?? 10) * 60000;
    const last = this._lastSent.get(context) || 0;
    if (Date.now() - last < minMs) return { emailed: false, reason: 'rate-limited' };

    const subject = `⚠️ Techsol Automation — ${context} failed`;
    const body =
      `A step in Techsol Automation failed and needs attention.\n\n` +
      `Where:  ${workflow} · ${context}\n` +
      (entityType ? `Record: ${entityType} #${eid}\n` : '') +
      `When:   ${new Date().toISOString()}\n\n` +
      `Error:\n${message}\n\n` +
      `No record was duplicated — the operation stopped safely before writing. ` +
      `Please open the app's "Needs attention" panel and Audit trail to review and retry.`;

    try {
      await this.mailer.send({ to, subject, body });
      this._lastSent.set(context, Date.now());
      try { this.audit.log({ workflow, action: `alert.${context}.notified`, outcome: 'ok', detail: { to } }); } catch {}
      return { emailed: true, to };
    } catch (e) {
      // If the alert email itself fails, record it but never recurse or throw.
      try { this.audit.log({ workflow, action: `alert.${context}.notify_failed`, outcome: 'error', detail: { message: e.message } }); } catch {}
      return { emailed: false, reason: e.message };
    }
  }
}

module.exports = { Alerter };
