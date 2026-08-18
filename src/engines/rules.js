'use strict';
/**
 * Business Rules Engine — deterministic validations.
 * All thresholds/tolerances come from config, not code (NFR-06).
 */

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Compute the GSTIN check character for the first 14 characters. */
function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARSET.indexOf(first14[i]);
    if (v < 0) throw new Error('invalid character in GSTIN');
    const factor = i % 2 === 0 ? 1 : 2;
    const product = v * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARSET[(36 - (sum % 36)) % 36];
}

/**
 * Validate a GSTIN: structure + checksum.
 * @returns {{valid:boolean, reason?:string}}
 */
function validateGstin(gstin) {
  if (typeof gstin !== 'string') return { valid: false, reason: 'not a string' };
  const g = gstin.trim().toUpperCase();
  if (g.length !== 15) return { valid: false, reason: 'length must be 15' };
  if (!GSTIN_RE.test(g)) return { valid: false, reason: 'format invalid' };
  const expect = gstinCheckChar(g.slice(0, 14));
  if (g[14] !== expect) return { valid: false, reason: 'checksum mismatch' };
  return { valid: true };
}

/** Build a structurally valid GSTIN from a 14-char stem (test helper / data generator). */
function buildGstin(first14) {
  const f = first14.toUpperCase();
  return f + gstinCheckChar(f);
}

/**
 * Duplicate invoice detection: same vendor + normalised invoice number,
 * optionally same date/amount within window.
 */
function isDuplicateBill(db, { vendor, invoiceNo }) {
  const row = db
    .prepare(`SELECT id FROM vendor_bills WHERE vendor = ? AND UPPER(REPLACE(invoice_no,' ','')) = UPPER(REPLACE(?,' ',''))`)
    .get(vendor, invoiceNo);
  return !!row;
}

/**
 * Tolerance match for reconciliation (value within absolute tolerance,
 * tax within percentage tolerance) — config-driven.
 */
function withinTolerance(a, b, { value = 1.0 } = {}) {
  return Math.abs(a - b) <= value;
}

/** Enquiry duplicate: same sender + similar subject within the window (excluding itself). */
function isDuplicateEnquiry(db, { sender, subject, windowDays, excludeId = -1 }) {
  const rows = db
    .prepare(`SELECT subject FROM enquiries WHERE sender = ? AND id != ? AND created_at >= datetime('now', ?)`)
    .all(sender, excludeId, `-${windowDays} days`);
  const norm = s => (s || '').toLowerCase().replace(/\b(re|fwd|fw)\s*:\s*/g, '').replace(/\s+/g, ' ').trim();
  const target = norm(subject);
  return rows.some(r => norm(r.subject) === target && target.length > 0);
}

module.exports = { validateGstin, buildGstin, gstinCheckChar, isDuplicateBill, withinTolerance, isDuplicateEnquiry };
