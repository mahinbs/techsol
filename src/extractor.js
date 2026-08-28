'use strict';
/**
 * Heuristic enquiry extractor — the deterministic baseline provider.
 * Parses free-text enquiry bodies for line items and customer hints.
 * The OCR/LLM provider replaces this behind the SAME contract once wired;
 * confidence reflects parse certainty so the review-gating behaves correctly.
 */

// Canonical unit vocabulary. Keys are matched case-insensitively; the value is
// the normalised UOM stored against the line. Longest alternatives must be
// listed before their prefixes (MT before M, MTRS before MTR) so the regex
// alternation does not match the shorter form first.
const UOM_MAP = [
    [['METERS', 'METRES', 'METER', 'METRE', 'MTRS', 'MTR', 'RMT', 'RM', 'M'], 'MTR'],
    [['TONNES', 'TONNE', 'TONS', 'TON', 'MT'], 'MT'],
    [['KILOGRAMS', 'KILOGRAM', 'KGS', 'KG'], 'KG'],
    [['LITRES', 'LITERS', 'LITRE', 'LITER', 'LTRS', 'LTR', 'L'], 'LTR'],
    [['SQMTR', 'SQM', 'SQ.M'], 'SQM'],
    [['NUMBERS', 'NUMBER', 'PIECES', 'PIECE', 'UNITS', 'UNIT', 'NOS', 'NO', 'PCS', 'PC', 'EA'], 'EA'],
    [['SETS', 'SET'], 'SET'],
    [['BOXES', 'BOX'], 'BOX'],
    [['ROLLS', 'ROLL'], 'ROLL'],
    [['PAIRS', 'PAIR'], 'PAIR'],
    [['BAGS', 'BAG'], 'BAG'],
    [['DRUMS', 'DRUM'], 'DRUM'],
    [['LOTS', 'LOT'], 'LOT'],
  ];

const UOM_LOOKUP = new Map();
for (const [forms, canon] of UOM_MAP) for (const f of forms) UOM_LOOKUP.set(f, canon);

// Sorted longest-first so e.g. METERS wins over M.
const UOM_ALTS = [...UOM_LOOKUP.keys()]
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace('.', '\\.'))
  .join('|');

// Quantities may be decimal ("2.5 MT") — the previous \d{1,6} silently
// captured only the fractional digits of such values.
const NUM = '\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,3})?|\\d{1,7}(?:[.,]\\d{1,2})?|\\d{1,7}';
const QTY_RE = new RegExp(`(${'$'}{NUM})\\s*(${'$'}{UOM_ALTS})\\b`, 'i');
const LEAD_QTY_RE = new RegExp(`^(${'$'}{NUM})\\s*[x×]?\\s+(.+)${'$'}`, 'i');

/** "2,500" -> 2500 ; "2.5" -> 2.5 ; a comma before exactly three digits is a
 *  thousands separator, never a decimal point. */
function parseQty(raw) {
  const s = String(raw);
  if (/^\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?${'$'}/.test(s)) return parseFloat(s.replace(/,/g, ''));
  return parseFloat(s.replace(',', '.'));
}

// A line that carried a list marker is a candidate item line even if it does
// not parse. Those must never be dropped silently — see extractLines.
const LIST_MARKER_RE = /^(?:[-*•]+\s*|\d{1,3}[.)]\s+)/;

function canonUom(raw) {
    return UOM_LOOKUP.get(String(raw || '').toUpperCase().replace(/\.$/, '')) || null;
}

function extractLines(body) {
    const lines = [];
    for (const raw of (body || '').split(/\r?\n/)) {
          const trimmed = raw.trim();
          const wasListed = LIST_MARKER_RE.test(trimmed);
          // strip bullets and numbered-list markers ("1." / "2)") but never a bare leading quantity
      const text = trimmed.replace(LIST_MARKER_RE, '');
          if (text.length < 6) continue;

      let qty = null, uom = null, desc = null, conf = 0.55;
          const m1 = text.match(QTY_RE);
          const m2 = text.match(LEAD_QTY_RE);
          if (m1) {
                  qty = parseQty(m1[1]);
                  uom = canonUom(m1[2]);
                  desc = text.replace(QTY_RE, '').replace(/\s{2,}/g, ' ').replace(/[,:-]\s*$/, '').trim();
                  conf = 0.93;
          } else if (m2) {
                  qty = parseQty(m2[1]);
                  uom = 'EA';
                  desc = m2[2].trim();
                  conf = 0.88;
          }

      if (qty && desc && desc.length >= 4) {
              lines.push({ description: desc, qty, uom: uom || 'EA', confidence: conf });
      } else if (wasListed && text.length >= 8) {
              // Enumerated but unparseable — e.g. "Suitable fasteners for the above
            // flange joints, please suggest sizes". The system must not guess a
            // quantity and must not discard the line: it is surfaced with a null
            // quantity and low confidence so a human resolves it.
            lines.push({ description: text, qty: null, uom: null, confidence: 0.3, needsReview: true });
      }
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

  // The low-confidence gate in WF1 inspects fields, not lines, so an
  // unparseable line is promoted to a field to raise the exception.
  const unresolved = lines.filter((l) => l.needsReview).length;
    if (unresolved) {
          fields.linesNeedingReview = {
                  value: `${unresolved} line(s) could not be parsed and need manual review`,
                  confidence: 0.3,
          };
    }
    return { fields, lines };
}

module.exports = { heuristicExtractor, extractLines };
