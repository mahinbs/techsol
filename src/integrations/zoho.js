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
    this._token = null;
    this._tokenExp = 0;
    this.mockStore = { calls: [], seq: 1000 };
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
  crmUpsertDeal(deal) {
    return this._request('post', 'https://www.zohoapis.com/crm/v2/Deals/upsert', { body: { data: [deal] } });
  }
  crmAddNote(dealId, note) {
    return this._request('post', `https://www.zohoapis.com/crm/v2/Deals/${dealId}/Notes`, { body: { data: [{ Note_Content: note }] } });
  }

  // ---- Books (WF2/WF4) ----
  booksCreateSalesOrder(so) {
    return this._request('post', 'https://www.zohoapis.com/books/v3/salesorders', { params: { organization_id: this.booksOrg }, body: so });
  }
  booksCreatePurchaseOrder(po) {
    return this._request('post', 'https://www.zohoapis.com/books/v3/purchaseorders', { params: { organization_id: this.booksOrg }, body: po });
  }
  booksCreateBill(bill) {
    return this._request('post', 'https://www.zohoapis.com/books/v3/bills', { params: { organization_id: this.booksOrg }, body: bill });
  }

  // ---- Inventory (WF2/WF3) ----
  inventoryStock(sku) {
    return this._request('get', 'https://www.zohoapis.com/inventory/v1/items', { params: { organization_id: this.booksOrg, search_text: sku } });
  }
}

module.exports = { ZohoClient };
