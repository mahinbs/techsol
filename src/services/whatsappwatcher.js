'use strict';
/**
 * WhatsApp intake service (WF1-01) — polls Kapso for inbound messages on one
 * nominated business number and feeds them into WF1.
 *
 * WHY POLLING RATHER THAN A WEBHOOK. WhatsApp delivery is normally push: Meta
 * or Kapso POSTs to a public HTTPS endpoint. A desktop application behind an
 * office router has no public address, so a webhook would require a permanent
 * tunnel or a hosted relay — one more thing to run and to break. Kapso exposes
 * a list endpoint that accepts direction=inbound plus a `since` timestamp and
 * cursor paging, so the app can dial out on a timer exactly as the mail watcher
 * does. No inbound port, no tunnel, survives restarts and network changes.
 *
 *   GET {base}/{phone_number_id}/messages?direction=inbound&since=…&limit=…
 *   X-API-Key: <project key>
 *
 * The same rules as mail intake apply: one nominated source, a keyword filter,
 * provenance recorded against every enquiry, dedupe on the WhatsApp message id,
 * and nothing is ever deleted or modified at the provider.
 */

const DEFAULTS = {
  enabled: 1,   // a fresh install watches as soon as credentials are saved; start() still refuses to run without them
  api_base: 'https://api.kapso.ai/meta/whatsapp/v24.0',
  api_key: '',
  phone_number_id: '',
  keyword_filter: '',          // blank = accept every inbound message
  poll_seconds: 20,
  lookback_minutes: 60,        // how far back the first poll reaches
};

class WhatsAppWatcher {
  constructor({ db, audit, onMessage }) {
    this.db = db;
    this.audit = audit;
    this.onMessage = onMessage;
    this.timer = null;
    this.running = false;
    this.lastError = null;
    this.lastPollAt = null;
    this.ingestedCount = 0;
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wa_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        api_base TEXT, api_key TEXT, phone_number_id TEXT,
        keyword_filter TEXT, poll_seconds INTEGER, lookback_minutes INTEGER,
        cursor_since TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS wa_seen (
        wamid TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        ingested INTEGER NOT NULL DEFAULT 0
      );
    `);
    if (!this.db.prepare('SELECT id FROM wa_settings WHERE id=1').get()) {
      this.db.prepare(
        `INSERT INTO wa_settings (id, enabled, api_base, api_key, phone_number_id,
           keyword_filter, poll_seconds, lookback_minutes, updated_at)
         VALUES (1,?,?,?,?,?,?,?,datetime('now'))`
      ).run(DEFAULTS.enabled, DEFAULTS.api_base, DEFAULTS.api_key, DEFAULTS.phone_number_id,
            DEFAULTS.keyword_filter, DEFAULTS.poll_seconds, DEFAULTS.lookback_minutes);
    }
  }

  _settings() {
    return this.db.prepare('SELECT * FROM wa_settings WHERE id=1').get() || { ...DEFAULTS };
  }

  /** The API key is never returned to the browser. */
  getSettings() {
    const s = this._settings();
    return {
      enabled: !!s.enabled,
      apiBase: s.api_base || DEFAULTS.api_base,
      apiKeySet: !!(s.api_key && s.api_key.length),
      phoneNumberId: s.phone_number_id || '',
      keywordFilter: s.keyword_filter || '',
      pollSeconds: s.poll_seconds || 20,
      lookbackMinutes: s.lookback_minutes || 60,
    };
  }

  status() {
    return {
      ...this.getSettings(),
      running: this.running,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      ingestedCount: this.ingestedCount,
    };
  }

  /** A blank API key means "keep the stored one". */
  saveSettings(p = {}) {
    const cur = this._settings();
    const next = {
      enabled: p.enabled === undefined ? cur.enabled : (p.enabled ? 1 : 0),
      api_base: (p.apiBase || cur.api_base || DEFAULTS.api_base).replace(/\/$/, ''),
      api_key: (p.apiKey && String(p.apiKey).length) ? String(p.apiKey) : cur.api_key,
      phone_number_id: String(p.phoneNumberId ?? cur.phone_number_id ?? '').trim(),
      keyword_filter: p.keywordFilter ?? cur.keyword_filter ?? '',
      poll_seconds: Math.max(10, Number(p.pollSeconds ?? cur.poll_seconds) || 20),
      lookback_minutes: Math.max(1, Number(p.lookbackMinutes ?? cur.lookback_minutes) || 60),
    };
    if (next.enabled && (!next.api_key || !next.phone_number_id)) {
      throw new Error('API key and WhatsApp phone number ID are both required to start watching.');
    }
    this.db.prepare(
      `UPDATE wa_settings SET enabled=?, api_base=?, api_key=?, phone_number_id=?, keyword_filter=?,
       poll_seconds=?, lookback_minutes=?, updated_at=datetime('now') WHERE id=1`
    ).run(next.enabled, next.api_base, next.api_key, next.phone_number_id,
          next.keyword_filter, next.poll_seconds, next.lookback_minutes);

    this.audit.log({
      workflow: 'WF1', action: 'whatsapp.settings.updated', entityType: 'whatsapp',
      entityId: next.phone_number_id || null, outcome: 'ok',
      detail: { keywordFilter: next.keyword_filter, enabled: !!next.enabled, pollSeconds: next.poll_seconds },
    });

    this.stop();
    if (next.enabled) this.start();
    return this.status();
  }

  _isSeen(id) {
    return !!this.db.prepare('SELECT wamid FROM wa_seen WHERE wamid=?').get(id);
  }
  _markSeen(id, ingested) {
    this.db.prepare('INSERT OR IGNORE INTO wa_seen (wamid, ingested) VALUES (?, ?)').run(id, ingested ? 1 : 0);
  }

  async _fetchInbound(s, sinceIso, limit = 100) {
    const url = `${s.api_base}/${encodeURIComponent(s.phone_number_id)}/messages`;
    const params = new URLSearchParams({ direction: 'inbound', limit: String(limit) });
    if (sinceIso) params.set('since', sinceIso);
    const res = await fetch(`${url}?${params}`, {
      headers: { 'X-API-Key': s.api_key, accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch { /* keep raw */ }
      throw new Error(`Kapso ${res.status}: ${msg}`);
    }
    let j;
    try { j = JSON.parse(text); } catch { throw new Error('Kapso returned a non-JSON response'); }
    return Array.isArray(j.data) ? j.data : [];
  }

  /** Text of a message regardless of type; media is referenced, never invented. */
  _bodyOf(m) {
    return m.text?.body
      ?? m.kapso?.content
      ?? m.interactive?.list_reply?.title
      ?? m.interactive?.button_reply?.title
      ?? m.button?.text
      ?? m[m.type]?.caption
      ?? '';
  }

  /** Verify credentials without ingesting. */
  async testConnection(p = {}) {
    const cur = this._settings();
    const s = {
      api_base: (p.apiBase || cur.api_base || DEFAULTS.api_base).replace(/\/$/, ''),
      api_key: (p.apiKey && String(p.apiKey).length) ? String(p.apiKey) : cur.api_key,
      phone_number_id: String(p.phoneNumberId || cur.phone_number_id || '').trim(),
    };
    if (!s.api_key || !s.phone_number_id) {
      return { ok: false, error: 'API key and phone number ID are required.' };
    }
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const msgs = await this._fetchInbound(s, since, 25);
      const filter = (p.keywordFilter ?? cur.keyword_filter ?? '').trim();
      const re = filter ? new RegExp(filter, 'i') : null;
      const matching = re ? msgs.filter((m) => re.test(this._bodyOf(m))).length : msgs.length;
      this.audit.log({ workflow: 'WF1', action: 'whatsapp.connection.tested', entityType: 'whatsapp',
        entityId: s.phone_number_id, outcome: 'ok', detail: { scanned: msgs.length, matching } });
      return { ok: true, phoneNumberId: s.phone_number_id, scanned: msgs.length, matching,
        windowHours: 24 };
    } catch (e) {
      this.audit.log({ workflow: 'WF1', action: 'whatsapp.connection.tested', entityType: 'whatsapp',
        entityId: s.phone_number_id, outcome: 'failed', detail: { error: e.message } });
      const hint = /401|403|unauthor/i.test(e.message)
        ? 'Check the API key, and that it belongs to the project owning this phone number.'
        : /404/.test(e.message)
          ? 'Check the phone number ID — Kapso did not recognise it.'
          : 'Check the API base URL and that this machine can reach api.kapso.ai.';
      return { ok: false, error: e.message, hint };
    }
  }

  /** One pass. Returns {ingested, skipped}. Safe to call by hand. */
  async pollOnce() {
    const s = this._settings();
    if (!s.api_key || !s.phone_number_id) throw new Error('WhatsApp is not configured.');
    this.lastPollAt = new Date().toISOString();

    const since = s.cursor_since
      || new Date(Date.now() - (Number(s.lookback_minutes) || 60) * 60_000).toISOString();
    const msgs = await this._fetchInbound(s, since);

    const re = (s.keyword_filter || '').trim() ? new RegExp(s.keyword_filter.trim(), 'i') : null;
    let ingested = 0, skipped = 0, ingestError = null, newest = since;

    for (const m of msgs) {
      const id = m.id;
      if (!id) continue;
      const ts = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null;
      if (ts && ts > newest) newest = ts;

      if (this._isSeen(id)) continue;
      // Outbound echoes should not appear given direction=inbound, but the
      // provider is not this app's to trust — check anyway.
      if (m.kapso?.direction && m.kapso.direction !== 'inbound') { this._markSeen(id, false); continue; }

      const body = this._bodyOf(m);
      if (re && !re.test(body)) {
        // Not an enquiry. Remembered so it is skipped cheaply; the content is
        // deliberately never logged.
        this._markSeen(id, false);
        skipped++;
        continue;
      }

      const from = m.from || m.kapso?.phone_number || null;
      const name = m.kapso?.contact_name || null;
      try {
        await this.onMessage({
          sender: from ? `+${String(from).replace(/^\+/, '')}` : null,
          senderName: name,
          subject: `WhatsApp enquiry from ${name || from || 'unknown'}`,
          body,
          sourceMessageId: id,
          receivedOn: s.phone_number_id,
          receivedAt: ts,
          hasMedia: !!m.kapso?.has_media,
          messageType: m.type || 'text',
        });
        this._markSeen(id, true);
        ingested++;
        this.ingestedCount++;
      } catch (e) {
        // Not marked seen — an enquiry must never be lost silently, and the
        // error must survive to the end of the pass so the UI shows it.
        ingestError = `ingest failed: ${e.message}`;
      }
    }

    // Advance the window only over messages we actually processed.
    if (!ingestError && newest !== since) {
      this.db.prepare('UPDATE wa_settings SET cursor_since=? WHERE id=1').run(newest);
    }
    this.lastError = ingestError;
    return { ingested, skipped, scanned: msgs.length };
  }

  start() {
    const s = this._settings();
    if (!s.enabled || !s.api_key || !s.phone_number_id) return false;
    if (this.timer) return true;
    this.running = true;
    const every = (Number(s.poll_seconds) || 20) * 1000;
    const tick = async () => {
      try { await this.pollOnce(); }
      catch (e) { this.lastError = e.message; }
    };
    tick();
    this.timer = setInterval(tick, every);
    if (this.timer.unref) this.timer.unref();
    this.audit.log({ workflow: 'WF1', action: 'whatsapp.watcher.started', entityType: 'whatsapp',
      entityId: s.phone_number_id, outcome: 'ok', detail: { pollSeconds: s.poll_seconds } });
    return true;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.running) {
      this.running = false;
      this.audit.log({ workflow: 'WF1', action: 'whatsapp.watcher.stopped', entityType: 'whatsapp',
        entityId: this._settings().phone_number_id || null, outcome: 'ok' });
    }
  }
}

module.exports = { WhatsAppWatcher };
