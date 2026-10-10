import { defineConfig } from "vitest/config";

/**
 * Explicit include/exclude so a bare `npx vitest` can never pick up stale
 * COMPILED test files from dist/ or web/dist/. The package.json scripts pass
 * --exclude flags for the same reason, but relying on every invocation to
 * remember them is fragile: `tsc` emits src/**\/*.test.js into dist/, and a
 * bare run would execute those copies against stale code.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "web/dist/**"],
    // Installs a stub Opus encoder ONLY when the native addon cannot be loaded
    // (Node-ABI mismatch), so the suite stays runnable locally without weakening
    // CI, where the real addon is present.
    setupFiles: ["src/vitest.setup.ts"],
  },
});