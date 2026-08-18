'use strict';
/**
 * Heuristic enquiry extractor — the deterministic baseline provider.
 * Parses free-text enquiry bodies for line items and customer hints.
 * The OCR/LLM provider replaces this behind the SAME contract once wired;
 * confidence reflects parse certainty so the review-gating behaves correctly.
 */

const QTY_RE = /(\d{1,6})\s*(EA|NOS?|PCS?|SETS?|MTRS?|KGS?|UNITS?)\b/i;
const LEAD_QTY_RE = /^(\d{1,6})\s*[x×]?\s+(.+)$/i;

function extractLines(body) {
  const lines = [];
  for (const raw of (body || '').split(/\r?\n/)) {
    // strip bullets and numbered-list markers ("1." / "2)") but never a bare leading quantity
    const text = raw.trim().replace(/^(?:[-*•]+\s*|\d{1,3}[.)]\s+)/, '');
    if (text.length < 6) continue;
    let qty = null, desc = null, conf = 0.55;
    const m1 = text.match(QTY_RE);
    const m2 = text.match(LEAD_QTY_RE);
    if (m1) {
      qty = parseInt(m1[1], 10);
      desc = text.replace(QTY_RE, '').replace(/\s{2,}/g, ' ').replace(/[,:-]\s*$/, '').trim();
      conf = 0.93;
    } else if (m2) {
      qty = parseInt(m2[1], 10);
      desc = m2[2].trim();
      conf = 0.88;
    }
    if (qty && desc && desc.length >= 4) lines.push({ description: desc, qty, uom: 'EA', confidence: conf });
  }
  return lines;
}

function extractCustomer(sender, body) {
  const m = (body || '').match(/regards[,\s]*\n?([A-Za-z .&()-]{3,60})/i);
  if (m) return { value: m[1].trim(), confidence: 0.8 };
  const domain = (sender || '').split('@')[1] || '';
  const org = domain.split('.')[0];
  if (org) return { value: org.toUpperCase(), confidence: 0.7 };
  return { value: sender || 'Unknown', confidence: 0.4 };
}

async function heuristicExtractor(enq) {
  const lines = extractLines(enq.body);
  const fields = {
    customer: extractCustomer(enq.sender, enq.body),
    subject: { value: enq.subject || '', confidence: 0.99 },
  };
  if (!lines.length) fields.lines = { value: 'none-detected', confidence: 0.3 }; // triggers review
  return { fields, lines };
}

module.exports = { heuristicExtractor, extractLines };
