/** Shared cancellation/generation fence for search, lyrics and other views. */
export function createLatestRequest() {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    start() {
      controller?.abort(); controller = new AbortController();
      const current = ++generation;
      return { signal: controller.signal, isCurrent: () => current === generation };
    },
    cancel() { generation++; controller?.abort(); controller = null; },
  };
}
