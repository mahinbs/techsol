'use strict';
/**
 * SO–PO Mapping Engine — the traceability backbone.
 * One Sales Order → many Vendor POs. Downstream artefacts (GRN, vendor bill,
 * BOE, payment, bank txn) attach to a VPO; everything resolves back to the SO.
 */
class SoPoEngine {
  constructor(db, audit) {
    this.db = db;
    this.audit = audit;
  }

  /** Link a Vendor PO to its parent Sales Order (called at VPO creation, WF2). */
  link(soId, vpoId) {
    const so = this.db.prepare('SELECT id FROM sales_orders WHERE id = ?').get(soId);
    const vpo = this.db.prepare('SELECT id FROM vendor_pos WHERE id = ?').get(vpoId);
    if (!so) throw new Error(`SO ${soId} not found`);
    if (!vpo) throw new Error(`VPO ${vpoId} not found`);
    const existing = this.db.prepare('SELECT so_id FROM so_po_map WHERE vpo_id = ?').get(vpoId);
    if (existing) {
      if (existing.so_id === soId) return { linked: true, already: true };
      throw new Error(`VPO ${vpoId} already linked to SO ${existing.so_id} — reference integrity`);
    }
    this.db.prepare('INSERT INTO so_po_map (so_id, vpo_id) VALUES (?, ?)').run(soId, vpoId);
    this.audit.log({ workflow: 'core', action: 'sopo.link', entityType: 'vpo', entityId: String(vpoId), outcome: 'ok', detail: { soId } });
    return { linked: true };
  }

  /** All Vendor POs for a Sales Order with status. */
  posForSo(soId) {
    return this.db.prepare(
      `SELECT v.* FROM vendor_pos v JOIN so_po_map m ON m.vpo_id = v.id WHERE m.so_id = ? ORDER BY v.id`
    ).all(soId);
  }

  /** Attach a downstream reference (grn | vendor_bill | boe | payment | bank_txn) to a VPO. */
  attachRef(vpoId, refType, refId) {
    const linked = this.db.prepare('SELECT so_id FROM so_po_map WHERE vpo_id = ?').get(vpoId);
    if (!linked) throw new Error(`VPO ${vpoId} is not linked to any SO — link before attaching references`);
    this.db.prepare(
      'INSERT OR IGNORE INTO so_po_refs (vpo_id, ref_type, ref_id) VALUES (?, ?, ?)'
    ).run(vpoId, refType, String(refId));
    return { soId: linked.so_id };
  }

  /** Resolve any downstream reference back to its Sales Order (the traceability promise). */
  traceToSo(refType, refId) {
    const row = this.db.prepare(
      `SELECT m.so_id AS soId, r.vpo_id AS vpoId FROM so_po_refs r JOIN so_po_map m ON m.vpo_id = r.vpo_id
       WHERE r.ref_type = ? AND r.ref_id = ?`
    ).get(refType, String(refId));
    return row || null;
  }

  /** Update procurement status of a VPO (ordered | supplied | received | billed). */
  setStatus(vpoId, status) {
    const allowed = ['draft', 'approved', 'ordered', 'supplied', 'received', 'billed'];
    if (!allowed.includes(status)) throw new Error(`invalid status ${status}`);
    this.db.prepare('UPDATE vendor_pos SET status = ? WHERE id = ?').run(status, vpoId);
    this.audit.log({ workflow: 'core', action: 'sopo.status', entityType: 'vpo', entityId: String(vpoId), outcome: 'ok', detail: { status } });
  }

  /** Procurement rollup for an SO: every PO and its refs. */
  rollup(soId) {
    const pos = this.posForSo(soId);
    return pos.map(p => ({
      ...p,
      refs: this.db.prepare('SELECT ref_type, ref_id FROM so_po_refs WHERE vpo_id = ?').all(p.id),
    }));
  }
}

module.exports = { SoPoEngine };
