'use strict';
/**
 * Zoho connection settings — stored in the database and edited from the UI,
 * so the desktop app can be connected without environment variables.
 *
 * SAFETY. The Zoho client's own defaults point at PRODUCTION (zohoapis.com and
 * Books org 693483118). That is the wrong default for this engagement: the
 * agreement is that nothing touches production until the client gives written
 * go-live approval. So this layer:
 *   - defaults every new install to the SANDBOX CRM and the AI TEST Books org;
 *   - refuses to go LIVE against a non-sandbox CRM host or the production Books
 *     org unless allowProduction is explicitly set, which the UI surfaces as a
 *     separate, deliberate confirmation rather than a silent fallback;
 *   - never returns the client secret or refresh token to the browser.
 */

const SANDBOX_CRM = 'https://crmsandbox.zoho.com';
const TEST_BOOKS_ORG = '936351036';
const PROD_BOOKS_ORG = '693483118';

const DEFAULTS = {
  mode: 'MOCK',                       // MOCK | LIVE
  accounts_base: 'https://accounts.zoho.com',
  client_id: '',
  client_secret: '',
  refresh_token: '',
  crm_base: SANDBOX_CRM,
  api_base: 'https://www.zohoapis.com',
  books_org: TEST_BOOKS_ORG,
  allow_production: 0,
};

class ZohoSettings {
  constructor({ db, audit, zoho }) {
    this.db = db;
    this.audit = audit;
    this.zoho = zoho;
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zoho_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT, accounts_base TEXT,
        client_id TEXT, client_secret TEXT, refresh_token TEXT,
        crm_base TEXT, api_base TEXT, books_org TEXT,
        allow_production INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );
    `);
    if (!this.db.prepare('SELECT id FROM zoho_settings WHERE id=1').get()) {
      this.db.prepare(
        `INSERT INTO zoho_settings (id, mode, accounts_base, client_id, client_secret, refresh_token,
          crm_base, api_base, books_org, allow_production, updated_at)
         VALUES (1,?,?,?,?,?,?,?,?,?,datetime('now'))`
      ).run(DEFAULTS.mode, DEFAULTS.accounts_base, DEFAULTS.client_id, DEFAULTS.client_secret,
            DEFAULTS.refresh_token, DEFAULTS.crm_base, DEFAULTS.api_base, DEFAULTS.books_org,
            DEFAULTS.allow_production);
    }
  }

  _row() {
    return this.db.prepare('SELECT * FROM zoho_settings WHERE id=1').get() || { ...DEFAULTS };
  }

  /** Push the stored settings into the live client. Called on boot and on save. */
  apply() {
    const s = this._row();
    const live = s.mode === 'LIVE' && s.client_id && s.client_secret && s.refresh_token;
    this.zoho.configure({
      mock: !live,
      accountsBase: s.accounts_base,
      clientId: s.client_id,
      clientSecret: s.client_secret,
      refreshToken: s.refresh_token,
      crmBase: s.crm_base,
      apiBase: s.api_base,
      booksOrg: s.books_org,
    });
    return this.status();
  }

  /** Never exposes the secret or refresh token. */
  status() {
    const s = this._row();
    const d = this.zoho.describe();
    return {
      mode: d.mode,
      requestedMode: s.mode,
      clientId: s.client_id ? s.client_id.slice(0, 6) + '…' + s.client_id.slice(-4) : '',
      secretSet: !!s.client_secret,
      refreshTokenSet: !!s.refresh_token,
      accountsBase: s.accounts_base,
      crmBase: s.crm_base,
      apiBase: s.api_base,
      booksOrg: s.books_org,
      allowProduction: !!s.allow_production,
      isSandboxCrm: d.isSandboxCrm,
      isTestBooksOrg: String(s.books_org) === TEST_BOOKS_ORG,
      credentialsSet: d.credentialsSet,
    };
  }

  /** Blank secret / refresh token means "keep what is stored". */
  save(p = {}) {
    const cur = this._row();
    const next = {
      mode: (p.mode || cur.mode || 'MOCK').toUpperCase() === 'LIVE' ? 'LIVE' : 'MOCK',
      accounts_base: p.accountsBase || cur.accounts_base || DEFAULTS.accounts_base,
      client_id: p.clientId ?? cur.client_id,
      client_secret: (p.clientSecret && String(p.clientSecret).length) ? String(p.clientSecret) : cur.client_secret,
      refresh_token: (p.refreshToken && String(p.refreshToken).length) ? String(p.refreshToken) : cur.refresh_token,
      crm_base: (p.crmBase || cur.crm_base || SANDBOX_CRM).replace(/\/$/, ''),
      api_base: (p.apiBase || cur.api_base || DEFAULTS.api_base).replace(/\/$/, ''),
      books_org: String(p.booksOrg ?? cur.books_org ?? TEST_BOOKS_ORG).trim(),
      allow_production: p.allowProduction ? 1 : 0,
    };

    if (next.mode === 'LIVE') {
      if (!next.client_id || !next.client_secret || !next.refresh_token) {
        throw new Error('Client ID, client secret and refresh token are all required to go LIVE.');
      }
      const crmIsProd = !/sandbox/i.test(next.crm_base);
      const booksIsProd = next.books_org === PROD_BOOKS_ORG;
      if ((crmIsProd || booksIsProd) && !next.allow_production) {
        throw new Error(
          `Refusing to connect to production. CRM host is "${next.crm_base}" and Books org is ` +
          `${next.books_org}. Use ${SANDBOX_CRM} and org ${TEST_BOOKS_ORG}, or tick ` +
          `"I have written go-live approval" to override.`
        );
      }
    }

    this.db.prepare(
      `UPDATE zoho_settings SET mode=?, accounts_base=?, client_id=?, client_secret=?, refresh_token=?,
       crm_base=?, api_base=?, books_org=?, allow_production=?, updated_at=datetime('now') WHERE id=1`
    ).run(next.mode, next.accounts_base, next.client_id, next.client_secret, next.refresh_token,
          next.crm_base, next.api_base, next.books_org, next.allow_production);

    this.audit.log({
      workflow: 'SYS', action: 'zoho.settings.updated', entityType: 'zoho', entityId: next.books_org,
      outcome: 'ok',
      detail: { mode: next.mode, crmBase: next.crm_base, booksOrg: next.books_org,
                productionOverride: !!next.allow_production },
    });
    return this.apply();
  }

  async test() {
    const r = await this.zoho.testConnection();
    this.audit.log({
      workflow: 'SYS', action: 'zoho.connection.tested', entityType: 'zoho',
      entityId: this._row().books_org, outcome: r.ok ? 'ok' : 'failed',
      detail: { crmModules: r.crmModules, crmError: r.crmError, booksError: r.booksError },
    });
    return r;
  }
}

module.exports = { ZohoSettings, SANDBOX_CRM, TEST_BOOKS_ORG, PROD_BOOKS_ORG };
