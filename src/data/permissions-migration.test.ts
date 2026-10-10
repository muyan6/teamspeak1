import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, backfillMemberPermissions, LEGACY_MEMBER_CAPABILITIES, type BotDatabase } from "./database.js";
import { createPermissionStore } from "./permissions.js";

describe("backfillMemberPermissions", () => {
  let dbFile: string;
  let db: BotDatabase;
  function fresh() {
    dbFile = path.join(os.tmpdir(), `mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createDatabase(dbFile);
  }
  afterEach(() => {
    db.close();
    for (const s of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(dbFile + s, { force: true });
      } catch {}
    }
  });

  it("grants existing members full access + bots.all, skips admins, once", () => {
    fresh();
    // simulate a pre-feature DB: clear the marker that createDatabase set, add users, no perm rows
    db.db.prepare("DELETE FROM schema_meta WHERE key = 'perm_backfill_done'").run();
    const now = Date.now();
    const ins = db.db.prepare(
      "INSERT INTO users (id,username,passwordHash,createdAt,updatedAt,role) VALUES (?,?,?,?,?,?)"
    );
    ins.run("m1", "mem", "x", now, now, "member");
    ins.run("a1", "adm", "x", now, now, "admin");

    backfillMemberPermissions(db.db);

    const store = createPermissionStore(db.db);
    // P2-6: the backfill grants the LEGACY tier plus bots.all — NOT every entry
    // in CAPABILITIES. bot.create / platform.auth / quality were split out after
    // this backfill was written, and handing them to every existing member on
    // upgrade would be a silent privilege escalation.
    expect(store.getCapabilities("m1").sort()).toEqual([...LEGACY_MEMBER_CAPABILITIES].sort());
    expect(store.getCapabilities("m1")).not.toContain("bot.create");
    expect(store.getCapabilities("m1")).not.toContain("platform.auth");
    expect(store.getCapabilities("m1")).not.toContain("quality");
    expect(store.getBotAccess("m1")).toBe("all");
    expect(store.getCapabilities("a1")).toEqual([]);
    expect(store.getBotAccess("a1")).toEqual([]);
  });

  it("is idempotent — running again does not change or re-grant", () => {
    fresh();
    db.db.prepare("DELETE FROM schema_meta WHERE key = 'perm_backfill_done'").run();
    const now = Date.now();
    db.db
      .prepare("INSERT INTO users (id,username,passwordHash,createdAt,updatedAt,role) VALUES (?,?,?,?,?,?)")
      .run("m1", "mem", "x", now, now, "member");
    backfillMemberPermissions(db.db);
    // member restricted afterwards
    createPermissionStore(db.db).setPermissions("m1", { capabilities: [], bots: [] });
    // second run must NOT re-grant (marker present)
    backfillMemberPermissions(db.db);
    expect(createPermissionStore(db.db).getCapabilities("m1")).toEqual([]);
  });
});
