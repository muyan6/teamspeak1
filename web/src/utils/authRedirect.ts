/**
 * Recovers the "session is no longer valid" story without statically importing
 * the router here: useWebSocket/useSession are pulled in by the (node) unit
 * tests, and importing router/index.js would execute createWebHistory() against
 * an undefined `window` at module load. main.ts registers the live router once.
 */
interface RouterLike {
  currentRoute: { value: { name?: unknown; fullPath: string } };
  replace(to: { name: string; query?: Record<string, string> }): unknown;
}

let routerRef: RouterLike | null = null;

/** Called once from main.ts with the app router. */
export function registerAuthRouter(router: RouterLike): void {
  routerRef = router;
}

/**
 * Reuse the exact open-redirect guard Login.vue applies to `?next`: only a
 * same-site absolute path is accepted. A protocol-relative value (`//evil.com`)
 * or an absolute URL (`https://evil.com`) must never survive into the login
 * page's `router.replace(next)`.
 */
export function safeNextPath(raw: unknown): string | null {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : null;
}

/**
 * Shared "session is no longer valid" reaction: send the user to /login once,
 * preserving the current page as `?next` (validated by safeNextPath). Used by the
 * REST 401 handler, the WebSocket policy-close path and the session poll so an
 * expired cookie can no longer leave the app silently dead until the next manual
 * API call happens to 401.
 */
export function redirectToLogin(fullPath?: string): void {
  const router = routerRef;
  if (!router) return; // not wired yet (e.g., unit tests) — nothing to navigate
  const current = router.currentRoute.value;
  // Already on an auth screen (or before the router resolved a name) — don't
  // bounce, or a boot-time 401 would fight the guard's own redirect.
  if (current.name === 'login' || current.name === 'first-run') return;
  const next = safeNextPath(fullPath ?? current.fullPath);
  router.replace(next ? { name: 'login', query: { next } } : { name: 'login' });
}
