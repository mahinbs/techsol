'use strict';
/**
 * Approval service — the human-in-the-loop gate (PLT-02).
 * Nothing customer-facing sends and nothing posts to Zoho except via an
 * approved approval record. Approvers may edit the payload before approving.
 */
class Approvals {
  constructor(db, audit) { this.db = db; this.audit = audit; }

  request({ workflow, kind, entityType, entityId, payload }) {
    const r = this.db.prepare(
      `INSERT INTO approvals (workflow, kind, entity_type, entity_id, payload) VALUES (?, ?, ?, ?, ?)`
    ).run(workflow, kind, entityType, String(entityId), JSON.stringify(payload));
    this.audit.log({ workflow, action: `approval.requested:${kind}`, entityType, entityId: String(entityId), outcome: 'ok' });
    return r.lastInsertRowid;
  }

  pending(workflow = null) {
    return workflow
      ? this.db.prepare(`SELECT * FROM approvals WHERE status='pending' AND workflow=? ORDER BY id`).all(workflow)
      : this.db.prepare(`SELECT * FROM approvals WHERE status='pending' ORDER BY id`).all();
  }

  /** Approve; optionally with an edited payload. Returns the effective payload to execute. */
  approve(id, userId, editedPayload = null) {
    const a = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    if (!a) throw new Error(`approval ${id} not found`);
    if (a.status !== 'pending') throw new Error(`approval ${id} already ${a.status}`);
    this.db.prepare(
      `UPDATE approvals SET status='approved', decided_by=?, decided_at=datetime('now'), edited_payload=? WHERE id=?`
    ).run(userId, editedPayload ? JSON.stringify(editedPayload) : null, id);
    this.audit.log({ actor: userId, workflow: a.workflow, action: `approval.approved:${a.kind}`, entityType: a.entity_type, entityId: a.entity_id, outcome: 'ok', detail: { edited: !!editedPayload } });
    return editedPayload || JSON.parse(a.payload);
  }

  reject(id, userId, note = '') {
    const a = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    if (!a) throw new Error(`approval ${id} not found`);
    if (a.status !== 'pending') throw new Error(`approval ${id} already ${a.status}`);
    this.db.prepare(
      `UPDATE approvals SET status='rejected', decided_by=?, decided_at=datetime('now'), decision_note=? WHERE id=?`
    ).run(userId, note, id);
    this.audit.log({ actor: userId, workflow: a.workflow, action: `approval.rejected:${a.kind}`, entityType: a.entity_type, entityId: a.entity_id, outcome: 'rejected', detail: { note } });
  }
}
module.exports = { Approvals };
