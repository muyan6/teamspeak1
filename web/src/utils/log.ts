/**
 * Dev-only logging helpers.
 *
 * `console.log` / `console.warn` calls that merely narrate happy-path activity
 * ("WebSocket connected", "failed to load avatar") shipped into the production
 * bundle and spammed every visitor's browser console. Route them through these
 * so `vite build` strips them at runtime while `vite dev` keeps them.
 *
 * `console.error` is deliberately NOT wrapped: an error log marks a real
 * failure worth surfacing in production too.
 */

const isDev = (() => {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
})();

export function devLog(...args: unknown[]): void {
  if (isDev) console.log(...args);
}

export function devWarn(...args: unknown[]): void {
  if (isDev) console.warn(...args);
}
