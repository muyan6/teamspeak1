import { Router } from "express";
import type { Logger } from "../../logger.js";
import type { UserStore } from "../../data/users.js";
import { UsernameTakenError, GUEST_USER_ID } from "../../data/users.js";
import type { SessionStore } from "../../data/sessions.js";
import type { AuditStore } from "../../data/audit.js";
import { isCapability, BASIC_TIER_CAPABILITIES, type PermissionStore } from "../../data/permissions.js";
import { extractSessionToken } from "../auth/validateSession.js";

function isValidUsername(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_\-.]{3,32}$/.test(v);
}

function isValidPassword(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && v.length <= 200;
}

export function createUsersRouter(
  users: UserStore,
  sessions: SessionStore,
  audit: AuditStore,
  logger: Logger,
  permissions: PermissionStore,
  /**
   * Called after an operation that invalidates a user's authorisation. A
   * WebSocket authenticates ONCE at upgrade and stamps the member's bot scope
   * at that moment, so without this a revoked bot kept streaming state to the
   * still-open socket until the client happened to reconnect.
   */
  onAccessRevoked?: (userId: string) => void
): Router {
  const router = Router();

  const revoke = (userId: string): void => {
    try {
      onAccessRevoked?.(userId);
    } catch (err) {
      logger.warn({ err, userId }, "failed to close revoked user sockets");
    }
  };

  router.get("/", (_req, res) => {
    res.json({ users: users.listUsers() });
  });

  router.post("/", async (req, res) => {
    const { username, password, role: roleInput } = req.body ?? {};
    if (!isValidUsername(username) || !isValidPassword(password)) {
      res.status(400).json({ error: "invalid username or password" });
      return;
    }
    const role: "admin" | "member" = roleInput === "admin" ? "admin" : "member";
    try {
      const u = await users.createUser(username, password, role);
      if (u.role === "member") {
        permissions.setPermissions(u.id, { capabilities: BASIC_TIER_CAPABILITIES, bots: "all" });
      }
      try {
        audit.record({
          actorId: req.user!.id, actorUsername: req.user!.username,
          targetUserId: u.id, targetUsername: u.username,
          action: "user.created",
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, action: "user.created" }, "audit insert failed");
      }
      logger.info({ createdBy: req.user!.id, newUserId: u.id, username, role }, "User created");
      res.status(201).json({ id: u.id, username: u.username, role: u.role });
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        res.status(409).json({ error: "username taken" });
        return;
      }
      logger.error({ err }, "createUser failed");
      res.status(500).json({ error: "internal" });
    }
  });

  router.delete("/:id", (req, res) => {
    const targetId = req.params.id;
    if (targetId === GUEST_USER_ID) { res.status(404).json({ error: "not found" }); return; }
    // Snapshot target's username BEFORE deletion for audit
    const target = users.findById(targetId);
    if (!target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (targetId === req.user!.id) {
      res.status(400).json({ error: "cannot delete self" });
      return;
    }
    const result = users.deleteUserIfNotLastAdmin(targetId);
    if (result === "not_found") {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (result === "would_orphan") {
      res.status(400).json({ error: "cannot delete last admin" });
      return;
    }
    // FK CASCADE removes sessions; explicit call is belt-and-suspenders
    sessions.deleteAllForUser(targetId);
    revoke(targetId);
    try {
      audit.record({
        actorId: req.user!.id, actorUsername: req.user!.username,
        targetUserId: target.id, targetUsername: target.username,
        action: "user.deleted",
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr, action: "user.deleted" }, "audit insert failed");
    }
    logger.info({ deletedBy: req.user!.id, deletedUserId: targetId }, "User deleted");
    res.status(204).end();
  });

  router.post("/:id/reset-password", async (req, res) => {
    const { newPassword } = req.body ?? {};
    if (!isValidPassword(newPassword)) {
      res.status(400).json({ error: "invalid password" });
      return;
    }
    const targetId = req.params.id;
    if (targetId === GUEST_USER_ID) { res.status(404).json({ error: "not found" }); return; }
    const target = users.findById(targetId);
    if (!target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    await users.changePassword(targetId, newPassword);
    // Invalidate all sessions for the target user (except current actor's if it's the same user)
    const exceptToken = targetId === req.user!.id
      ? (extractSessionToken(req.headers.cookie) ?? undefined)
      : undefined;
    sessions.deleteAllForUser(targetId, exceptToken);
    if (targetId !== req.user!.id) revoke(targetId);
    try {
      audit.record({
        actorId: req.user!.id, actorUsername: req.user!.username,
        targetUserId: target.id, targetUsername: target.username,
        action: "user.password_reset",
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr, action: "user.password_reset" }, "audit insert failed");
    }
    logger.info({ resetBy: req.user!.id, targetUserId: targetId }, "Password reset");
    res.status(204).end();
  });

  router.patch("/:id/role", (req, res) => {
    const targetId = req.params.id;
    if (targetId === GUEST_USER_ID) { res.status(404).json({ error: "not found" }); return; }
    const { role: newRole } = req.body ?? {};
    if (newRole !== "admin" && newRole !== "member") {
      res.status(400).json({ error: "invalid role" });
      return;
    }
    // Snapshot the target's old role and username for audit (BEFORE the atomic update,
    // so we record what actually changed; if the user is gone we'll skip audit).
    const targetBefore = users.findById(targetId);
    if (!targetBefore) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const result = users.setRoleIfNotLastAdmin(targetId, newRole);
    if (result === "not_found") {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (result === "would_orphan") {
      res.status(400).json({ error: "cannot demote last admin" });
      return;
    }
    // Only audit when the role actually changed
    if (targetBefore.role !== newRole) {
      try {
        audit.record({
          actorId: req.user!.id, actorUsername: req.user!.username,
          targetUserId: targetBefore.id, targetUsername: targetBefore.username,
          action: "user.role_changed",
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, action: "user.role_changed" }, "audit insert failed");
      }
      logger.info({ actorId: req.user!.id, targetId, newRole }, "User role changed");
    }
    res.status(204).end();
  });

  router.get("/:id/permissions", (req, res) => {
    if (req.params.id === GUEST_USER_ID) { res.status(404).json({ error: "not found" }); return; }
    const user = users.findById(req.params.id);
    if (!user) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      capabilities: permissions.getCapabilities(user.id),
      bots: permissions.getBotAccess(user.id),
    });
  });

  router.put("/:id/permissions", (req, res) => {
    if (req.params.id === GUEST_USER_ID) { res.status(404).json({ error: "not found" }); return; }
    const user = users.findById(req.params.id);
    if (!user) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = req.body ?? {};
    const caps: string[] = Array.isArray(body.capabilities)
      ? body.capabilities.filter(isCapability)
      : [];
    // Cap the array and de-duplicate: setPermissions inserts one row per entry
    // inside a transaction, so an unbounded body was a cheap write amplification
    // / DB-bloat vector. 500 is far above any realistic bot count.
    const MAX_BOT_GRANTS = 500;
    const requestedBots: unknown[] = Array.isArray(body.bots) ? (body.bots as unknown[]) : [];
    const bots: "all" | string[] =
      body.bots === "all"
        ? "all"
        : Array.isArray(body.bots)
          ? [
              ...new Set(
                requestedBots
                  .filter((b): b is string => typeof b === "string")
                  .map((b) => b.trim())
                  .filter((b) => b.length > 0),
              ),
            ].slice(0, MAX_BOT_GRANTS)
          : [];
    permissions.setPermissions(user.id, { capabilities: caps, bots });
    // The member's open sockets still carry the scope resolved at upgrade.
    // Closing them forces a reconnect that re-resolves from the new grants.
    revoke(user.id);
    try {
      audit.record({
        actorId: req.user!.id, actorUsername: req.user!.username,
        targetUserId: user.id, targetUsername: user.username,
        action: "user.permissions_changed",
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr, action: "user.permissions_changed" }, "audit insert failed");
    }
    logger.info({ actorId: req.user!.id, targetUserId: user.id }, "User permissions changed");
    res.json({ success: true });
  });

  return router;
}
