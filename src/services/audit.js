'use strict';
/** Append-only audit trail — every write and communication is recorded (NFR-02). */
class Audit {
  constructor(db) { this.db = db; }
  log({ actor = 'system', workflow, action, entityType = null, entityId = null, outcome, detail = null }) {
    this.db.prepare(
      `INSERT INTO audit_log (actor, workflow, action, entity_type, entity_id, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(actor, workflow, action, entityType, entityId, outcome, detail ? JSON.stringify(detail) : null);
  }
  recent(limit = 50) {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  }
}
module.exports = { Audit };
