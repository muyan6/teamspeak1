import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Logger } from "../../logger.js";
import type { UserStore } from "../../data/users.js";
import type { SessionStore } from "../../data/sessions.js";
import type { AuditStore } from "../../data/audit.js";
import { resolvePermissionContext, type PermissionStore } from "../../data/permissions.js";
import { SESSION_TTL_MS, GUEST_SESSION_TTL_MS } from "../../data/sessions.js";
import { GUEST_USER_ID, GUEST_USERNAME, DUMMY_PASSWORD_HASH } from "../../data/users.js";
import type { GuestModeConfig } from "../../data/config.js";
import { SESSION_COOKIE_NAME, validateSessionFromHeaders, extractSessionToken } from "../auth/validateSession.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

const FAILED_LOGIN_DELAY_MS = 250;

function setSessionCookie(res: Response, token: string, maxAgeMs = SESSION_TTL_MS): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: res.req.secure,
    path: "/",
    maxAge: maxAgeMs,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidUsername(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_\-.]{3,32}$/.test(v);
}

function isValidPassword(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && v.length <= 200;
}

export function createSessionRouter(
  users: UserStore,
  sessions: SessionStore,
  audit: AuditStore,
  logger: Logger,
  permissions: PermissionStore,
  getGuestConfig: () => GuestModeConfig,
  /** Wired by the web server so a logout also drops that user's WS sockets. */
  onSessionsRevoked?: (userId: string) => void
): Router {
  const router = Router();

  const requireAuthInline = (req: Request, res: Response, next: NextFunction) => {
    const result = validateSessionFromHeaders(req.headers.cookie, sessions);
    if (!result) {
      clearSessionCookie(res);
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    // A guest session is only valid while guest mode is enabled. Disabling it
    // immediately invalidates any in-flight guest sessions (mirrors createRequireAuth).
    if (result.role === "guest" && !getGuestConfig().enabled) {
      clearSessionCookie(res);
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    req.user = { id: result.userId, username: result.username, role: result.role };
    const token = extractSessionToken(req.headers.cookie);
    if (token) setSessionCookie(res, token);
    next();
  };

  router.get("/needs-setup", (_req, res) => {
    res.json({ needsSetup: users.countUsers() === 0, guestAllowed: getGuestConfig().enabled });
  });

  router.post("/setup", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (users.countUsers() !== 0) {
      res.status(409).json({ error: "already initialized" });
      return;
    }
    if (!isValidUsername(username) || !isValidPassword(password)) {
      res.status(400).json({ error: "invalid username or password" });
      return;
    }
    try {
      const user = await users.createFirstUser(username, password);
      if (!user) {
        res.status(409).json({ error: "already initialized" });
        return;
      }
      const { token } = sessions.createSession(user.id);
      setSessionCookie(res, token);
      try {
        audit.record({
          actorId: user.id, actorUsername: user.username,
          targetUserId: user.id, targetUsername: user.username,
          action: "admin.first_created",
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, action: "admin.first_created" }, "audit insert failed");
      }
      logger.info({ userId: user.id, username }, "First admin created");
      res.json({ id: user.id, username: user.username, role: user.role });
    } catch (err) {
      logger.error({ err }, "setup failed");
      res.status(500).json({ error: "internal" });
    }
  });

  router.post("/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const user = users.findByUsername(username);
    // Always run exactly one bcrypt comparison — even for an unknown username —
    // so response time does not reveal whether the account exists.
    const ok = await users.verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) {
      await delay(FAILED_LOGIN_DELAY_MS);
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const { token } = sessions.createSession(user.id);
    setSessionCookie(res, token);
    res.json({ id: user.id, username: user.username, role: user.role });
  });

  router.post("/guest", (_req, res) => {
    const cfg = getGuestConfig();
    if (!cfg.enabled) {
      res.status(403).json({ error: "guest mode disabled" });
      return;
    }
    let token: string;
    try {
      // If the reserved guest row is somehow missing, the session FK would
      // throw; surface a clean 503 rather than letting it become a 500.
      ({ token } = sessions.createSession(GUEST_USER_ID, { ttlMs: GUEST_SESSION_TTL_MS, skipCap: true }));
    } catch (err) {
      logger.error({ err }, "guest session creation failed");
      res.status(503).json({ error: "guest unavailable" });
      return;
    }
    setSessionCookie(res, token, GUEST_SESSION_TTL_MS);
    res.json({ id: GUEST_USER_ID, username: GUEST_USERNAME, role: "guest" });
  });

  router.post("/logout", (req, res) => {
    const token = extractSessionToken(req.headers.cookie);
    if (token) {
      // Resolve the owner BEFORE deleting so the socket sweep can target them:
      // a WebSocket authenticated at upgrade keeps streaming until it is closed
      // explicitly, even after the session row is gone.
      const owner = validateSessionFromHeaders(req.headers.cookie, sessions);
      sessions.deleteSession(token);
      if (owner) {
        try {
          onSessionsRevoked?.(owner.userId);
        } catch (err) {
          logger.warn({ err }, "failed to close user sockets on logout");
        }
      }
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get("/me", requireAuthInline, (req, res) => {
    const user = req.user!;
    const cfg = getGuestConfig();
    const ctx = resolvePermissionContext(
      user.role,
      user.id,
      permissions,
      user.role === "guest" ? { bots: cfg.bots, permissions: cfg.permissions } : undefined
    );
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      capabilities: [...ctx.capabilities],
      bots: ctx.bots === "all" ? "all" : [...ctx.bots],
      guest: ctx.guest ?? null,
    });
  });

  router.post("/change-password", requireAuthInline, requireNotGuest, async (req, res) => {
    const { oldPassword, newPassword } = req.body ?? {};
    if (typeof oldPassword !== "string") {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const u = users.findById(req.user!.id);
    if (!u || !(await users.verifyPassword(oldPassword, u.passwordHash))) {
      await delay(FAILED_LOGIN_DELAY_MS);
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    if (!isValidPassword(newPassword)) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    await users.changePassword(u.id, newPassword);
    const currentToken = extractSessionToken(req.headers.cookie);
    sessions.deleteAllForUser(u.id, currentToken ?? undefined);
    try {
      audit.record({
        actorId: u.id, actorUsername: u.username,
        targetUserId: u.id, targetUsername: u.username,
        action: "user.password_changed",
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr, action: "user.password_changed" }, "audit insert failed");
    }
    res.status(204).end();
  });

  return router;
}
