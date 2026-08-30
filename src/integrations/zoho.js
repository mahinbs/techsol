'use strict';
/**
 * Zoho API client — OAuth2 self-client (refresh-token) flow.
 *
 * Credentials are read from environment (production: Windows Credential
 * Manager via the shell layer; never files/repo):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
 *   ZOHO_ACCOUNTS_BASE (default https://accounts.zoho.com)
 *   ZOHO_CRM_ORG=693482430, ZOHO_BOOKS_ORG=693483118
 *
 * MOCK MODE: until the client provisions the OAuth self-client, set
 * ZOHO_MOCK=1 — calls are recorded in-memory so workflows and tests run
 * end-to-end with identical code paths.
 */
const axios = require('axios');

class ZohoClient {
  constructor(opts = {}) {
    this.mock = opts.mock ?? process.env.ZOHO_MOCK === '1';
    this.accountsBase = opts.accountsBase || process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.com';
    this.clientId = opts.clientId || process.env.ZOHO_CLIENT_ID;
    this.clientSecret = opts.clientSecret || process.env.ZOHO_CLIENT_SECRET;
    this.refreshToken = opts.refreshToken || process.env.ZOHO_REFRESH_TOKEN;
    this.booksOrg = opts.booksOrg || process.env.ZOHO_BOOKS_ORG || '693483118';
    // Sandbox/test-environment support (client mandate: no production writes):
    //   ZOHO_CRM_BASE=https://crmsandbox.zoho.com  (sandbox "AI Automation", org 936249533)
    //   ZOHO_BOOKS_ORG=936351036                   ("Techsol Engineers – AI TEST")
    this.crmBase = (opts.crmBase || process.env.ZOHO_CRM_BASE || 'https://www.zohoapis.com').replace(/\/$/, '');
    this.apiBase = (opts.apiBase || process.env.ZOHO_API_BASE || 'https://www.zohoapis.com').replace(/\/$/, '');
    this._token = null;
    this._tokenExp = 0;
    this.mockStore = { calls: [], seq: 1000 };
  }

  /**
   * Re-point this client at a different Zoho configuration at runtime.
   * Mutates in place so WF1/WF2 keep working through the same reference,
   * and drops any cached token so the next call authenticates afresh.
   */
  configure(o = {}) {
    if ('mock' in o) this.mock = !!o.mock;
    if (o.accountsBase) this.accountsBase = o.accountsBase;
    if ('clientId' in o) this.clientId = o.clientId;
    if ('clientSecret' in o) this.clientSecret = o.clientSecret;
    if ('refreshToken' in o) this.refreshToken = o.refreshToken;
    if (o.booksOrg) this.booksOrg = String(o.booksOrg);
    if (o.crmBase) this.crmBase = String(o.crmBase).replace(/\/$/, '');
    if (o.apiBase) this.apiBase = String(o.apiBase).replace(/\/$/, '');
    this._token = null;
    this._tokenExp = 0;
    return this.describe();
  }

  /** Non-secret view of the current configuration, safe for the UI. */
  describe() {
    return {
      mode: this.mock ? 'MOCK' : 'LIVE',
      crmBase: this.crmBase,
      apiBase: this.apiBase,
      booksOrg: this.booksOrg,
      accountsBase: this.accountsBase,
      credentialsSet: !!(this.clientId && this.clientSecret && this.refreshToken),
      isSandboxCrm: /sandbox/i.test(this.crmBase || ''),
    };
  }

  /** Refresh the token and make one READ call. Never writes. */
  async testConnection() {
    if (this.mock) return { ok: false, error: 'Client is in MOCK mode — nothing is sent to Zoho.' };
    await this._accessToken();
    const out = { ok: true, tokenRefreshed: true };
    try {
      const m = await this.crmListModules();
      out.crmModules = (m?.modules || []).length;
    } catch (e) { out.crmError = e.response?.data?.message || e.message; }
    try {
      const c = await this.booksListContacts('');
      out.booksReachable = Array.isArray(c?.contacts);
      out.booksOrg = this.booksOrg;
    } catch (e) { out.booksError = e.response?.data?.message || e.message; }
    out.ok = !out.crmError || !out.booksError;
    return out;
  }

  /**
   * Exchange a one-time authorization (grant) code for a long-lived refresh
   * token. This is the step that has no home otherwise: the app stores a
   * refresh token but a self-client only ever hands you a grant code, which
   * expires in minutes and is single-use. Run this once, right after
   * generating the code, and the returned refresh_token is what the app keeps.
   */
  async exchangeCode({ accountsBase, clientId, clientSecret, code, redirectUri }) {
    const base = (accountsBase || this.accountsBase || 'https://accounts.zoho.com').replace(/\/$/, '');
    if (!clientId || !clientSecret || !code) {
      throw new Error('Client ID, client secret and the authorization code are all required.');
    }
    const params = { grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code };
    if (redirectUri) params.redirect_uri = redirectUri;
    const { data } = await axios.post(`${base}/oauth/v2/token`, null, { params });
    if (!data || !data.refresh_token) {
      // Zoho returns { error: "invalid_code" } etc. with HTTP 200, so surface it.
      const why = data && data.error ? data.error : JSON.stringify(data);
      throw new Error(`Zoho did not return a refresh token: ${why}. `
        + `Codes expire in ~2 minutes and are single-use — generate a fresh one. `
        + `If your Zoho is on the India data centre, use accounts.zoho.in.`);
    }
    return { refreshToken: data.refresh_token, apiDomain: data.api_domain || null };
  }

  async _accessToken() {
    if (this.mock) return 'mock-token';
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      throw new Error('Zoho OAuth credentials not configured — provision the self-client (see handoff doc §2)');
    }
    if (this._token && Date.now() < this._tokenExp - 60_000) return this._token;
    const { data } = await axios.post(`${this.accountsBase}/oauth/v2/token`, null, {
      params: { grant_type: 'refresh_token', client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.refreshToken },
    });
    if (!data.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
    this._token = data.access_token;
    this._tokenExp = Date.now() + (data.expires_in ? data.expires_in * 1000 : 3300_000);
    return this._token;
  }

  async _request(method, url, { params = {}, body = null, retries = 3 } = {}) {
    if (this.mock) {
      const id = String(++this.mockStore.seq);
      this.mockStore.calls.push({ method, url, params, body });
      return { id, mock: true };
    }
    const token = await this._accessToken();
    for (let attempt = 1; ; attempt++) {
      try {
        const { data } = await axios({ method, url, params, data: body, headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout: 30_000 });
        return data;
      } catch (err) {
        const status = err.response?.status;
        const retriable = status === 429 || (status >= 500 && status < 600) || err.code === 'ECONNRESET';
        if (!retriable || attempt >= retries) throw err;
        await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); // exponential backoff
      }
    }
  }

  // ---- CRM (WF1) ----
  crmCreateDeal(deal) {
    // Granted scope is READ+CREATE (no UPDATE), so plain insert — not upsert.
    return this._request('post', `${this.crmBase}/crm/v3/Deals`, { body: { data: [deal] } });
  }
  crmUpsertDeal(deal) { return this.crmCreateDeal(deal); }
  crmSearchDeals(criteria) {
    return this._request('get', `${this.crmBase}/crm/v3/Deals/search`, { params: { criteria } });
  }
  crmAddNote(dealId, note) {
    return this._request('post', `${this.crmBase}/crm/v3/Deals/${dealId}/Notes`, { body: { data: [{ Note_Content: note }] } });
  }
  crmListModules() {
    return this._request('get', `${this.crmBase}/crm/v3/settings/modules`, {});
  }

  // ---- Books (WF2/WF4) ----
  booksListContacts(search) {
    return this._request('get', `${this.apiBase}/books/v3/contacts`, { params: { organization_id: this.booksOrg, search_text: search || '' } });
  }
  booksCreateContact(contact) {
    return this._request('post', `${this.apiBase}/books/v3/contacts`, { params: { organization_id: this.booksOrg }, body: contact });
  }
  booksCreateEstimate(est) {
    return this._request('post', `${this.apiBase}/books/v3/estimates`, { params: { organization_id: this.booksOrg }, body: est });
  }
  booksCreateSalesOrder(so) {
    return this._request('post', `${this.apiBase}/books/v3/salesorders`, { params: { organization_id: this.booksOrg }, body: so });
  }
  booksCreatePurchaseOrder(po) {
    return this._request('post', `${this.apiBase}/books/v3/purchaseorders`, { params: { organization_id: this.booksOrg }, body: po });
  }
  booksCreateBill(bill) {
    return this._request('post', `${this.apiBase}/books/v3/bills`, { params: { organization_id: this.booksOrg }, body: bill });
  }
  booksListItems(search) {
    return this._request('get', `${this.apiBase}/books/v3/items`, { params: { organization_id: this.booksOrg, search_text: search || '' } });
  }

  // ---- Inventory (WF2/WF3) ----
  inventoryStock(sku) {
    return this._request('get', `${this.apiBase}/inventory/v1/items`, { params: { organization_id: this.booksOrg, search_text: sku } });
  }
}

module.exports = { ZohoClient };
