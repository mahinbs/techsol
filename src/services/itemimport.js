'use strict';
/**
 * Import items into the local catalogue from an uploaded CSV or Excel (.xlsx)
 * file. Columns are matched by header name (case/space/underscore-insensitive)
 * so a Zoho export, the app's own "Download items" file, or a hand-made sheet
 * all work. Upsert is keyed on SKU: an existing SKU is refreshed, a new one is
 * added; nothing is ever deleted. Rows without a name or SKU are skipped and
 * reported (both are NOT NULL in the items table).
 */
const XLSX = require('xlsx');

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[_\s]+/g, ' ').trim();

// Header candidates, in priority order where it matters (price).
const NAME_KEYS  = ['item name', 'name', 'description', 'item description'];
const SKU_KEYS   = ['sku', 'item sku', 'code', 'part no', 'part number'];
// 'item price' is last on purpose — in Zoho exports it is a pack/MOQ figure,
// not the selling rate ('pricelist rate' / 'rate' are the real price).
const PRICE_KEYS = ['pricelist rate', 'rate', 'list price', 'selling price', 'unit price', 'price', 'item price'];
const SPEC_KEYS  = ['spec', 'material'];
const UOM_KEYS   = ['uom', 'unit', 'usage unit'];

function pick(m, keys) {
  for (const k of keys) {
    if (k in m && m[k] != null && String(m[k]).trim() !== '') return m[k];
  }
  return null;
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} db  the app database handle
 * @param {Buffer} buffer  raw uploaded file bytes (xlsx or csv)
 * @returns {{total,inserted,updated,skipped,catalogueTotal,withPrice}}
 */
function importItemsFromBuffer(db, buffer) {
  if (!buffer || !buffer.length) throw new Error('No file was received.');
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer' }); }
  catch { throw new Error('Could not read the file — upload a .csv or .xlsx exported from Excel/Numbers.'); }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no sheets.');
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  if (!rows.length) throw new Error('The file has a header but no data rows.');

  // Confirm the sheet actually has a name and SKU column, else the mapping is wrong.
  const headerNorm = new Set(Object.keys(rows[0]).map(norm));
  const hasName = NAME_KEYS.some(k => headerNorm.has(k));
  const hasSku  = SKU_KEYS.some(k => headerNorm.has(k));
  if (!hasName || !hasSku) {
    throw new Error('Could not find a Name and SKU column. Expected headers like "Item Name" and "SKU".');
  }

  const exists = db.prepare('SELECT 1 AS x FROM items WHERE sku = ?');
  const upsert = db.prepare(
    `INSERT INTO items (sku, description, spec, uom, list_price)
     VALUES (@sku, @description, @spec, @uom, @list_price)
     ON CONFLICT(sku) DO UPDATE SET
       description = excluded.description,
       spec        = COALESCE(excluded.spec, items.spec),
       uom         = COALESCE(excluded.uom, items.uom),
       list_price  = excluded.list_price`
  );

  let inserted = 0, updated = 0, skipped = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const m = {};
      for (const key of Object.keys(r)) m[norm(key)] = r[key];
      const name = pick(m, NAME_KEYS);
      const sku  = pick(m, SKU_KEYS);
      if (!name || !sku) { skipped++; continue; }
      const specVal = pick(m, SPEC_KEYS);
      const uomVal  = pick(m, UOM_KEYS);
      const rec = {
        sku: String(sku).trim(),
        description: String(name).trim(),
        spec: specVal ? String(specVal).trim() : null,
        uom: uomVal ? String(uomVal).trim() : 'EA',
        list_price: toNumber(pick(m, PRICE_KEYS)),
      };
      const had = exists.get(rec.sku);
      upsert.run(rec);
      if (had) updated++; else inserted++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const catalogueTotal = db.prepare('SELECT COUNT(*) c FROM items').get().c;
  const withPrice = db.prepare('SELECT COUNT(*) c FROM items WHERE list_price IS NOT NULL').get().c;
  return { total: rows.length, inserted, updated, skipped, catalogueTotal, withPrice };
}

module.exports = { importItemsFromBuffer };
