import router from '../router/index.js';
import { useSession } from '../composables/useSession.js';
import axios from 'axios';

let installed = false;
const nativeFetch: typeof window.fetch = window.fetch.bind(window);

/**
 * Shared 401 handler. Redirects to /login after refreshing the session.
 * Exported so both the fetch wrapper and the axios interceptor use one path.
 */
async function handleUnauthorized(): Promise<void> {
  const session = useSession();
  await session.refresh();
  const current = router.currentRoute.value;
  if (current.name !== 'login' && current.name !== 'first-run') {
    await router.replace({ name: 'login', query: { next: current.fullPath } });
  }
}

/**
 * Wraps fetch so every call:
 *   - sends cookies (`credentials: 'same-origin'`)
 *   - on 401 from /api/*: clear local session, redirect to /login
 *
 * Always uses the captured native fetch, never the (possibly wrapped) global.
 */
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const merged: RequestInit = {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.headers ?? {}) },
  };
  return nativeFetch(input, merged).then(async (res) => {
    if (res.status === 401 && shouldTriggerRefresh(input)) {
      await handleUnauthorized();
    }
    return res;
  });
}

function shouldTriggerRefresh(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return url.startsWith('/api/') && !url.startsWith('/api/session/');
}

/**
 * Replaces window.fetch with apiFetch so existing call sites do not need to be touched.
 * Call once at app startup.
 */
export function installApiClient(): void {
  if (installed) return;
  installed = true;

  // The app makes ~150 axios calls and only ~19 fetch calls. Wrapping
  // window.fetch alone therefore missed almost every API request: axios uses
  // the XHR adapter in browsers, so an expired session produced silent 401s
  // instead of a redirect to /login. Install a response interceptor on the
  // shared axios default so both transports behave identically.
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const status = error?.response?.status;
      const url: string = error?.config?.url ?? '';
      if (status === 401 && shouldTriggerRefresh(url)) {
        await handleUnauthorized();
      }
      return Promise.reject(error);
    },
  );

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return apiFetch(input, init ?? {});
  }) as typeof window.fetch;
  (window as unknown as { __originalFetch?: typeof fetch }).__originalFetch = nativeFetch;
}
