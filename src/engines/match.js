'use strict';
/**
 * Line-item matching + pricing recommendation (WF2).
 * Exact + token-based fuzzy matching now; semantic (embedding) matching plugs
 * into `semanticScore` when the AI provider is wired in Phase 2.0.
 */

function normalise(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Dice coefficient over token bigrams — robust for part descriptions. */
function similarity(a, b) {
  const ta = normalise(a).split(' ');
  const tb = normalise(b).split(' ');
  if (!ta.length || !tb.length) return 0;
  const setA = new Set(ta), setB = new Set(tb);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return (2 * inter) / (setA.size + setB.size);
}

class Matcher {
  constructor(db, cfg) { this.db = db; this.cfg = cfg.matching; }

  /**
   * Match one RFQ description against the item master.
   * @returns {{method:'exact'|'fuzzy'|'ambiguous'|'unmatched', item?:object, candidates?:object[], confidence?:number}}
   */
  match(rfqDescription) {
    const items = this.db.prepare('SELECT * FROM items').all();
    const scored = items
      .map(it => ({ item: it, score: Math.max(similarity(rfqDescription, it.description), similarity(rfqDescription, it.sku)) }))
      .sort((x, y) => y.score - x.score);
    if (!scored.length) return { method: 'unmatched' };
    const [best, second] = scored;
    if (best.score >= this.cfg.exactThreshold) return { method: 'exact', item: best.item, confidence: best.score };
    if (best.score >= this.cfg.fuzzyThreshold) {
      if (second && best.score - second.score < this.cfg.ambiguousGap) {
        return { method: 'ambiguous', candidates: [best.item, second.item], confidence: best.score };
      }
      return { method: 'fuzzy', item: best.item, confidence: best.score };
    }
    return { method: 'unmatched', confidence: best.score };
  }

  /**
   * Recommend a price. NEVER final — human sets final_price (WF2-03).
   * Uses last quoted price to this customer, uplifted per config; else list price.
   */
  recommendPrice(itemId, customer, cfgPricing) {
    const last = this.db.prepare(
      `SELECT ql.final_price FROM quotation_lines ql JOIN quotations q ON q.id = ql.quotation_id
       WHERE ql.item_id = ? AND q.customer = ? AND ql.final_price IS NOT NULL ORDER BY ql.id DESC LIMIT 1`
    ).get(itemId, customer);
    if (last && last.final_price) {
      return +(last.final_price * (1 + cfgPricing.upliftOverLastQuotePct / 100)).toFixed(2);
    }
    const item = this.db.prepare('SELECT list_price FROM items WHERE id = ?').get(itemId);
    return item && item.list_price != null ? item.list_price : null;
  }
}

module.exports = { Matcher, similarity, normalise };
