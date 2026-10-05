import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { hashPassword, verifyPassword } from './passwords.js';
import { createPermissionStore, type BotAccess } from './permissions.js';
export { DUMMY_PASSWORD_HASH } from './passwords.js';

export type UserRole = "admin" | "member" | "guest";

/** Reserved synthetic principal for login-less guest sessions. The username is
 *  non-ASCII so it can never collide with an API-created account (which is
 *  validated against ^[A-Za-z0-9_\-.]{3,32}$). */
export const GUEST_USER_ID = "__guest__";
export const GUEST_USERNAME = "游客";

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
  role: UserRole;
}

export interface UserStore {
  countUsers(): number;
  countAdmins(): number;
  createUser(username: string, password: string, role: UserRole, initialPermissions?: { capabilities: string[]; bots: BotAccess }): Promise<UserRow>;
  createFirstUser(username: string, password: string): Promise<UserRow | null>;
  findByUsername(username: string): UserRow | null;
  findById(id: string): UserRow | null;
  verifyPassword(plain: string, hash: string): Promise<boolean>;
  changePassword(userId: string, newPassword: string, expectedHash?: string): Promise<void>;
  setRole(userId: string, role: UserRole): boolean;
  setRoleIfNotLastAdmin(id: string, newRole: UserRole): "ok" | "not_found" | "would_orphan";
  deleteUser(id: string): boolean;
  deleteUserIfNotLastAdmin(id: string): "ok" | "not_found" | "would_orphan";
  listUsers(): Array<{ id: string; username: string; createdAt: number; role: UserRole }>;
}

export class CredentialsChangedError extends Error {
  readonly status = 409;
  constructor() { super('Credentials changed; authenticate again'); }
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username taken: ${username}`);
    this.name = "UsernameTakenError";
  }
}

export function createUserStore(db: Database.Database): UserStore {
  const permissions = createPermissionStore(db);
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role != 'guest'");
  const countAdminsStmt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
  const insertStmt = db.prepare(
    "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const findByUsernameStmt = db.prepare(
    "SELECT id, username, passwordHash, createdAt, updatedAt, role FROM users WHERE username = ? COLLATE NOCASE"
  );
  const findByIdStmt = db.prepare(
    "SELECT id, username, passwordHash, createdAt, updatedAt, role FROM users WHERE id = ?"
  );
  const updatePasswordStmt = db.prepare(
    "UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?"
  );
  const compareAndSetPasswordStmt = db.prepare(
    "UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ? AND passwordHash = ?"
  );
  const updateRoleStmt = db.prepare(
    "UPDATE users SET role = ?, updatedAt = ? WHERE id = ?"
  );
  const listUsersStmt = db.prepare(
    "SELECT id, username, createdAt, role FROM users WHERE role != 'guest' ORDER BY createdAt ASC"
  );
  const deleteUserStmt = db.prepare("DELETE FROM users WHERE id = ?");

  return {
    countUsers() {
      return (countStmt.get() as { n: number }).n;
    },

    countAdmins() {
      return (countAdminsStmt.get() as { n: number }).n;
    },

    async createUser(username, password, role, initialPermissions) {
      const hash = await hashPassword(password);
      const id = randomUUID();
      const now = Date.now();
      try {
        db.transaction(() => {
          insertStmt.run(id, username, hash, now, now, role);
          if (role === 'member') {
            permissions.setPermissions(id, initialPermissions ?? { capabilities: [], bots: [] });
          }
        })();
      } catch (err) {
        if (err && typeof err === "object" && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new UsernameTakenError(username);
        }
        throw err;
      }
      return { id, username, passwordHash: hash, createdAt: now, updatedAt: now, role };
    },

    async createFirstUser(username, password) {
      const hash = await hashPassword(password);
      const id = randomUUID();
      const now = Date.now();
      const run = db.transaction(() => {
        const count = (countStmt.get() as { n: number }).n;
        if (count !== 0) return null;
        try {
          insertStmt.run(id, username, hash, now, now, "admin");
        } catch (err) {
          if (err && typeof err === "object" && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
            return null;
          }
          throw err;
        }
        return { id, username, passwordHash: hash, createdAt: now, updatedAt: now, role: "admin" } as UserRow;
      });
      return run();
    },

    findByUsername(username) {
      return (findByUsernameStmt.get(username) as UserRow | undefined) ?? null;
    },

    findById(id) {
      return (findByIdStmt.get(id) as UserRow | undefined) ?? null;
    },

    verifyPassword(plain, hash) {
      return verifyPassword(plain, hash);
    },

    async changePassword(userId, newPassword, expectedHash) {
      const hash = await hashPassword(newPassword);
      const result = expectedHash === undefined
        ? updatePasswordStmt.run(hash, Date.now(), userId)
        : compareAndSetPasswordStmt.run(hash, Date.now(), userId, expectedHash);
      if (!result.changes) throw new CredentialsChangedError();
    },

    setRole(userId, role) {
      const result = updateRoleStmt.run(role, Date.now(), userId);
      return result.changes > 0;
    },

    setRoleIfNotLastAdmin(id, newRole) {
      const tx = db.transaction(() => {
        const row = findByIdStmt.get(id) as UserRow | undefined;
        if (!row) return "not_found" as const;
        if (row.role === "guest") return "not_found" as const; // reserved synthetic principal
        if (row.role === newRole) return "ok" as const; // no-op
        if (row.role === "admin" && newRole === "member") {
          const adminCount = (countAdminsStmt.get() as { n: number }).n;
          if (adminCount <= 1) return "would_orphan" as const;
        }
        updateRoleStmt.run(newRole, Date.now(), id);
        return "ok" as const;
      });
      return tx();
    },

    listUsers() {
      return listUsersStmt.all() as Array<{ id: string; username: string; createdAt: number; role: UserRole }>;
    },

    deleteUser(id) {
      const result = deleteUserStmt.run(id);
      return result.changes > 0;
    },

    deleteUserIfNotLastAdmin(id) {
      const tx = db.transaction(() => {
        const row = findByIdStmt.get(id) as UserRow | undefined;
        if (!row) return "not_found" as const;
        if (row.role === "guest") return "not_found" as const; // reserved synthetic principal
        if (row.role === "admin") {
          const adminCount = (countAdminsStmt.get() as { n: number }).n;
          if (adminCount <= 1) return "would_orphan" as const;
        }
        deleteUserStmt.run(id);
        return "ok" as const;
      });
      return tx();
    },
  };
}
