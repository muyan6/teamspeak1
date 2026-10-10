import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { GUEST_USER_ID } from "./users.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const GUEST_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day — guests are short-lived
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const MAX_SESSIONS_PER_USER = 10;
/**
 * P2-25: absolute session lifetime, independent of activity.
 *
 * Every expiry above is SLIDING — `validateAndTouch` pushes `expiresAt` forward
 * on each touch — so a stolen cookie that is used (or simply refreshed) more
 * often than once an hour stays valid forever. An absolute cap makes the session
 * die after a fixed window no matter what, forcing a real re-authentication.
 * Sized deliberately long so it is invisible to normal users.
 */
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const GUEST_SESSION_ABSOLUTE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
/**
 * Cap for the SHARED guest principal. Guests are login-less and all share one
 * synthetic userId, so the per-user cap cannot apply (it would evict other
 * people's sessions). Without any cap, though, a guest-login loop grew the
 * table without bound until the hourly cleanup ran.
 */
export const MAX_GUEST_SESSIONS = 1000;

export interface SessionValidation {
  userId: string;
  username: string;
  role: "admin" | "member" | "guest";
  /**
   * Server-side expiry for this session (epoch ms). Lets the HTTP layer set the
   * cookie's own maxAge to the SAME deadline instead of blindly re-issuing a
   * fresh 7-day cookie on every request — which decoupled the browser cookie's
   * lifetime from the server session and from the absolute cap.
   */
  expiresAt?: number;
}

export interface SessionStore {
  createSession(userId: string, opts?: { ttlMs?: number; skipCap?: boolean }): { token: string; expiresAt: number };
  validateAndTouch(rawToken: string): SessionValidation | null;
  /** Read-only validation for long-lived sockets; checking must not renew TTL. */
  validate(rawToken: string): SessionValidation | null;
  deleteSession(rawToken: string): void;
  deleteAllForUser(userId: string, exceptToken?: string): void;
  cleanupExpired(): void;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionStore(db: Database.Database): SessionStore {
  const insertStmt = db.prepare(
    "INSERT INTO sessions (id, userId, createdAt, expiresAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)"
  );
  const selectStmt = db.prepare(`
    SELECT s.id, s.userId, s.createdAt, s.expiresAt, s.lastSeenAt, u.username, u.role
    FROM sessions s INNER JOIN users u ON u.id = s.userId
    WHERE s.id = ?
  `);
  const deleteByIdStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
  const touchStmt = db.prepare(
    "UPDATE sessions SET lastSeenAt = ?, expiresAt = ? WHERE id = ?"
  );
  const deleteAllForUserStmt = db.prepare("DELETE FROM sessions WHERE userId = ?");
  const deleteAllForUserExceptStmt = db.prepare(
    "DELETE FROM sessions WHERE userId = ? AND id != ?"
  );
  const cleanupStmt = db.prepare("DELETE FROM sessions WHERE expiresAt < ?");
  const countForUserStmt = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE userId = ?");
  const deleteOldestForUserStmt = db.prepare(
    "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE userId = ? ORDER BY createdAt ASC LIMIT ?)"
  );

  return {
    validate(rawToken) {
      if (!rawToken) return null;
      const row = selectStmt.get(hashToken(rawToken)) as (SessionValidation & { userId: string; username: string; role: SessionValidation['role']; createdAt: number; expiresAt: number }) | undefined;
      if (!row || row.expiresAt <= Date.now()) return null;
      // Absolute lifetime applies to the read-only path too: a long-lived
      // WebSocket must not outlive the session it was opened with.
      const absoluteTtl = row.role === "guest" ? GUEST_SESSION_ABSOLUTE_TTL_MS : SESSION_ABSOLUTE_TTL_MS;
      if (Date.now() - row.createdAt > absoluteTtl) return null;
      return { userId: row.userId, username: row.username, role: row.role, expiresAt: row.expiresAt };
    },
    createSession(userId, opts) {
      // Cap concurrent sessions per user — oldest gets evicted on overflow.
      // Wrap the count → delete → insert in a transaction so concurrent logins
      // for the same user can't both pass the cap check and both insert,
      // ending up 1 over cap (race window between count and insert).
      const token = randomBytes(32).toString("base64url");
      const id = hashToken(token);
      const now = Date.now();
      const expiresAt = now + (opts?.ttlMs ?? SESSION_TTL_MS);
      const tx = db.transaction(() => {
        // Guests all share one synthetic principal, so `skipCap` still applies
        // the per-user cap semantics to a DIFFERENT limit: evicting another
        // guest's session is harmless (they can re-enter), whereas letting the
        // count grow without bound is not.
        const cap = userId === GUEST_USER_ID && opts?.skipCap
          ? MAX_GUEST_SESSIONS
          : MAX_SESSIONS_PER_USER;
        const exempt = userId !== GUEST_USER_ID && opts?.skipCap;
        if (!exempt) {
          const existing = (countForUserStmt.get(userId) as { n: number }).n;
          if (existing >= cap) {
            deleteOldestForUserStmt.run(userId, existing - cap + 1);
          }
        }
        insertStmt.run(id, userId, now, expiresAt, now);
      });
      tx();
      return { token, expiresAt };
    },

    validateAndTouch(rawToken) {
      if (!rawToken) return null;
      const id = hashToken(rawToken);
      const row = selectStmt.get(id) as
        | { id: string; userId: string; createdAt: number; expiresAt: number; lastSeenAt: number; username: string; role: string }
        | undefined;
      if (!row) return null;
      const now = Date.now();
      if (row.expiresAt < now) {
        deleteByIdStmt.run(id);
        return null;
      }
      // P2-25: absolute cap. Sliding renewal below would otherwise keep a stolen
      // token alive indefinitely; past this window the session is destroyed
      // rather than renewed, so the holder has to authenticate again.
      const absoluteTtl = row.role === "guest" ? GUEST_SESSION_ABSOLUTE_TTL_MS : SESSION_ABSOLUTE_TTL_MS;
      if (now - row.createdAt > absoluteTtl) {
        deleteByIdStmt.run(id);
        return null;
      }
      if (now - row.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
        // Refresh against the role's own TTL — guests are short-lived (1d) and
        // must NOT be bumped to the member/admin 7d window on touch. Capped at
        // the absolute deadline so a touch can never extend past it.
        const ttl = row.role === "guest" ? GUEST_SESSION_TTL_MS : SESSION_TTL_MS;
        const deadline = row.createdAt + absoluteTtl;
        const nextExpiry = Math.min(now + ttl, deadline);
        touchStmt.run(now, nextExpiry, id);
        return {
          userId: row.userId,
          username: row.username,
          role: row.role as "admin" | "member" | "guest",
          expiresAt: nextExpiry,
        };
      }
      return {
        userId: row.userId,
        username: row.username,
        role: row.role as "admin" | "member" | "guest",
        expiresAt: row.expiresAt,
      };
    },

    deleteSession(rawToken) {
      deleteByIdStmt.run(hashToken(rawToken));
    },

    deleteAllForUser(userId, exceptToken) {
      if (exceptToken) {
        deleteAllForUserExceptStmt.run(userId, hashToken(exceptToken));
      } else {
        deleteAllForUserStmt.run(userId);
      }
    },

    cleanupExpired() {
      cleanupStmt.run(Date.now());
    },
  };
}
