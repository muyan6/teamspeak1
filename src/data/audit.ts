import type Database from "better-sqlite3";

export type AuditAction =
  | "admin.first_created"
  | "user.created"
  | "user.deleted"
  | "user.password_reset"
  | "user.password_changed"
  | "user.role_changed"
  | "user.permissions_changed";

export interface AuditEntry {
  id: number;
  timestamp: number;
  actorId: string | null;
  actorUsername: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  action: AuditAction;
}

export interface AuditRecordInput {
  actorId: string | null;
  actorUsername: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  action: AuditAction;
}

export interface AuditStore {
  record(input: AuditRecordInput): void;
  list(limit: number, offset: number): AuditEntry[];
}

/** Hard ceiling on one page of audit history. */
export const AUDIT_MAX_LIMIT = 200;

export function createAuditStore(db: Database.Database): AuditStore {
  const insertStmt = db.prepare(
    "INSERT INTO user_audit (timestamp, actorId, actorUsername, targetUserId, targetUsername, action) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const listStmt = db.prepare(
    "SELECT id, timestamp, actorId, actorUsername, targetUserId, targetUsername, action FROM user_audit ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?"
  );

  return {
    record(input) {
      insertStmt.run(
        Date.now(),
        input.actorId,
        input.actorUsername,
        input.targetUserId,
        input.targetUsername,
        input.action
      );
    },
    list(limit, offset) {
      // P2-9: clamp HERE, not only in the route. SQLite treats a negative LIMIT
      // as "no limit", so a future caller passing -1 would dump the entire audit
      // table; a negative OFFSET is silently ignored. Normalise both so the
      // store's contract holds regardless of who calls it.
      const safeLimit = Number.isFinite(limit)
        ? Math.min(AUDIT_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
        : AUDIT_MAX_LIMIT;
      const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
      return listStmt.all(safeLimit, safeOffset) as AuditEntry[];
    },
  };
}
