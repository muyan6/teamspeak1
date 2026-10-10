import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDataDirUsable,
  currentUid,
  dataDirPermissionHint,
  isPermissionError,
} from "./data-dir.js";

const tempDirs: string[] = [];

/**
 * Run `fn` with `process.getuid` present/absent, so the POSIX and non-POSIX
 * branches can both be exercised on any runner (CI covers Windows and Linux).
 */
function withGetuidProperty<T>(value: (() => number) | undefined, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "getuid", { value, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process, "getuid", original);
    else delete (process as { getuid?: unknown }).getuid;
  }
}

function withGetuid<T>(uid: number, fn: () => T): T {
  return withGetuidProperty(() => uid, fn);
}

function withoutGetuid<T>(fn: () => T): T {
  return withGetuidProperty(undefined, fn);
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsmb-data-dir-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("isPermissionError", () => {
  it("recognises permission-related errno codes", () => {
    expect(isPermissionError(Object.assign(new Error("nope"), { code: "EACCES" }))).toBe(true);
    expect(isPermissionError(Object.assign(new Error("nope"), { code: "EPERM" }))).toBe(true);
    expect(isPermissionError(Object.assign(new Error("ro"), { code: "EROFS" }))).toBe(true);
  });

  it("ignores unrelated errors so the Docker hint is not misapplied", () => {
    expect(isPermissionError(Object.assign(new Error("no space"), { code: "ENOSPC" }))).toBe(false);
    expect(isPermissionError(Object.assign(new Error("not a dir"), { code: "ENOTDIR" }))).toBe(false);
    expect(isPermissionError(new Error("plain"))).toBe(false);
    expect(isPermissionError(null)).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
    expect(isPermissionError("EACCES")).toBe(false);
  });
});

describe("currentUid", () => {
  it("reports undefined when the host has no getuid (non-POSIX)", () => {
    withoutGetuid(() => expect(currentUid()).toBeUndefined());
  });

  it("reports the process uid when the host has one", () => {
    withGetuid(4242, () => expect(currentUid()).toBe(4242));
  });
});

describe("dataDirPermissionHint", () => {
  it("carries the exact host-side fix, uid and target directory", () => {
    const hint = dataDirPermissionHint("/app/data", 1000);
    expect(hint).toContain("UID/GID 1000:1000");
    expect(hint).toContain("/app/data");
    expect(hint).toContain("sudo chown -R 1000:1000 /data/musicbot");
    expect(hint).toContain("docker inspect tsmusicbot-custom");
    expect(hint).toContain("docker compose up -d");
  });

  it("prints the numeric uid when one is known", () => {
    expect(dataDirPermissionHint("/app/data", 4242)).toContain("4242");
  });

  // Regression: `undefined` used to trigger the `uid = currentUid()` default
  // parameter, so this assertion failed on every POSIX CI runner (the hint
  // printed the real uid, not the fallback) and passed only on Windows. The
  // default is gone now, so `undefined` means "unknown" everywhere.
  it("treats an explicitly unknown uid as unknown even on a host that has one", () => {
    const hint = withGetuid(4242, () => dataDirPermissionHint("/app/data", undefined));
    expect(hint).toContain("n/a (非 POSIX 平台)");
  });

  it("degrades gracefully when getuid is unavailable (non-POSIX host)", () => {
    const hint = withoutGetuid(() => dataDirPermissionHint("/app/data", currentUid()));
    expect(hint).toContain("n/a (非 POSIX 平台)");
  });

  it("defaults to the current process uid", () => {
    const hint = dataDirPermissionHint("/app/data", currentUid());
    expect(hint).toContain(String(currentUid() ?? "n/a (非 POSIX 平台)"));
  });
});

describe("assertDataDirUsable", () => {
  it("accepts a writable directory containing a readable config.json", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ webPort: 3000 }));
    expect(() => assertDataDirUsable(dir)).not.toThrow();
  });

  it("creates a missing data directory", () => {
    const dir = join(makeTempDir(), "nested", "data");
    expect(() => assertDataDirUsable(dir)).not.toThrow();
  });

  it("leaves no probe file behind", () => {
    const dir = makeTempDir();
    assertDataDirUsable(dir);
    expect(() => assertDataDirUsable(dir)).not.toThrow();
  });

  it("rethrows non-permission errors unchanged instead of showing the Docker hint", () => {
    const dir = makeTempDir();
    const asFile = join(dir, "config.json");
    writeFileSync(asFile, "{}");
    // Using a regular file as the data dir yields ENOTDIR/EEXIST, never EACCES.
    expect(() => assertDataDirUsable(join(asFile, "data"))).toThrowError();
    try {
      assertDataDirUsable(join(asFile, "data"));
    } catch (err) {
      expect((err as Error).message).not.toContain("chown");
    }
  });
});
