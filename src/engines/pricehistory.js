'use strict';

/**
 * Customer pricing history from Zoho (#5 / #7).
 *
 * For a given Books customer, pull their recent INVOICES and SALES ORDERS, read
 * the line items, and index them by Zoho item_id. That lets the quotation screen
 * show — per line — what this customer actually paid before: the last price, the
 * last discount, the average and the full trail. It is used to SUGGEST pricing
 * for review; the final figure is always set by a person.
 *
 * Bounded and best-effort: it fetches only a handful of recent documents, and any
 * Zoho error yields an empty index instead of throwing.
 */

/** Line-level discount as a percent, falling back to the document discount. */
function lineDiscountPct(li, docPct) {
  const d = li && li.discount;
  if (d != null && d !== '') {
    const s = String(d);
    if (s.includes('%')) return parseFloat(s) || 0;
    const amt = parseFloat(s) || 0;
    const gross = (Number(li.rate) || 0) * (Number(li.quantity) || 0);
    if (gross > 0 && amt > 0) return +((amt / gross) * 100).toFixed(2);
  }
  return docPct || 0;
}

/** Document-level discount as a percent (Zoho gives "10%" or an amount). */
function docDiscountPct(doc) {
  const d = doc && doc.discount;
  if (d == null || d === '') return 0;
  const s = String(d);
  if (s.includes('%')) return parseFloat(s) || 0;
  const sub = Number(doc.sub_total) || 0;
  const amt = parseFloat(s) || 0;
  return sub > 0 && amt > 0 ? +((amt / sub) * 100).toFixed(2) : 0;
}

async function fetchDocsWithLines(list, getOne, key, max) {
  const out = [];
  for (const id of (list || []).slice(0, max).map((d) => d[key]).filter(Boolean)) {
    try { out.push(await getOne(id)); } catch { /* skip unreadable document */ }
  }
  return out;
}

/**
 * Build an index  zoho_item_id -> [{source, ref, date, rate, discountPct}]  (newest first).
 * @returns {Promise<{index:Map<string,object[]>, invoices:number, salesOrders:number}>}
 */
async function customerItemHistory(zoho, customerId, { maxDocs = 8 } = {}) {
  const index = new Map();
  let invoices = 0, salesOrders = 0;
  if (!customerId) return { index, invoices, salesOrders };

  const add = (itemId, entry) => {
    if (itemId == null) return;
    const k = String(itemId);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(entry);
  };

  try {
    const inv = await zoho.booksListInvoices(customerId, 1, maxDocs);
    const list = inv && Array.isArray(inv.invoices) ? inv.invoices : [];
    const full = await fetchDocsWithLines(list, (id) => zoho.booksGetInvoice(id).then((r) => r.invoice || r), 'invoice_id', maxDocs);
    for (const doc of full) {
      invoices++;
      const dpct = docDiscountPct(doc);
      for (const li of doc.line_items || []) {
        add(li.item_id, { source: 'invoice', ref: doc.invoice_number || doc.invoice_id, date: doc.date, rate: Number(li.rate) || 0, discountPct: lineDiscountPct(li, dpct) });
      }
    }
  } catch { /* invoices unavailable — still try SOs */ }

  try {
    const so = await zoho.booksListSalesOrders(customerId, 1, maxDocs);
    const list = so && Array.isArray(so.salesorders) ? so.salesorders : [];
    const full = await fetchDocsWithLines(list, (id) => zoho.booksGetSalesOrder(id).then((r) => r.salesorder || r), 'salesorder_id', maxDocs);
    for (const doc of full) {
      salesOrders++;
      const dpct = docDiscountPct(doc);
      for (const li of doc.line_items || []) {
        add(li.item_id, { source: 'so', ref: doc.salesorder_number || doc.salesorder_id, date: doc.date, rate: Number(li.rate) || 0, discountPct: lineDiscountPct(li, dpct) });
      }
    }
  } catch { /* sales orders unavailable */ }

  for (const arr of index.values()) arr.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { index, invoices, salesOrders };
}

/** Summarise one item's history entries into a review suggestion. */
function summariseItem(entries) {
  if (!entries || !entries.length) return null;
  const rates = entries.map((e) => e.rate).filter((n) => n > 0);
  const last = entries[0];
  const avg = rates.length ? +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2) : null;
  return {
    lastPrice: last.rate,
    lastDiscountPct: last.discountPct,
    lastSource: last.source,
    lastRef: last.ref,
    lastDate: last.date,
    avgPrice: avg,
    min: rates.length ? Math.min(...rates) : null,
    max: rates.length ? Math.max(...rates) : null,
    count: entries.length,
    history: entries.slice(0, 10),
  };
}

module.exports = { customerItemHistory, summariseItem, docDiscountPct, lineDiscountPct };
