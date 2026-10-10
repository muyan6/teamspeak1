import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface AvatarStore {
  /** Returns the relative path written (e.g. "bot-1.png"). */
  write(botId: string, mime: string, buffer: Buffer): string;
  read(relPath: string): Buffer | null;
  remove(relPath: string): void;
  getDir(): string;
}

export function createAvatarStore(dir: string): AvatarStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const root = resolve(dir);

  /**
   * Resolve `name` under the avatar dir, refusing anything that escapes it.
   * `botId` arrives from a route param (Express percent-decodes `%2F` into `/`)
   * and `relPath` comes from the DB, so a `../` in either turned read/remove
   * into an arbitrary-file operation. Callers happen to be protected today by
   * an exists-as-a-real-bot check, but the store must not rely on that.
   */
  function contained(name: string): string | null {
    const full = resolve(root, name);
    if (full !== root && !full.startsWith(root + sep)) return null;
    return full;
  }

  return {
    write(botId, mime, buffer) {
      const ext = MIME_TO_EXT[mime];
      if (!ext) throw new Error(`unsupported avatar MIME: ${mime}`);
      const rel = `${botId}.${ext}`;
      const target = contained(rel);
      if (!target) throw new Error("invalid avatar path");
      // P2-8: write to a sibling temp file and rename into place. A crash or a
      // full disk mid-write used to leave a TRUNCATED file at the final path —
      // served to browsers, which cache it by name, with no way to roll back.
      // rename(2) is atomic within a directory, so the final path is either the
      // old image or the new one, never a partial one.
      const tmp = contained(`${rel}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
      if (!tmp) throw new Error("invalid avatar path");
      writeFileSync(tmp, buffer);
      try {
        renameSync(tmp, target);
      } catch (err) {
        try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw err;
      }
      // Remove any avatar this bot left under a DIFFERENT extension (the MIME can
      // change between uploads). Probing the three known extensions is O(1);
      // the previous readdirSync listed the ENTIRE directory on every write.
      for (const otherExt of Object.values(MIME_TO_EXT)) {
        if (otherExt === ext) continue;
        const stale = contained(`${botId}.${otherExt}`);
        if (stale) rmSync(stale, { force: true });
      }
      return rel;
    },
    read(relPath) {
      const full = contained(relPath);
      if (!full || !existsSync(full)) return null;
      return readFileSync(full);
    },
    remove(relPath) {
      const full = contained(relPath);
      if (full) rmSync(full, { force: true });
    },
    getDir() {
      return root;
    },
  };
}
