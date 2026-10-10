import { describe, it, expect } from "vitest";
import { publicCoverUrl, normalizeSong, InvalidMediaInput } from "./media-dto.js";

describe("publicCoverUrl", () => {
  it("keeps absolute http(s) covers", () => {
    expect(publicCoverUrl("https://y.gtimg.cn/music/photo/x.jpg")).toBe(
      "https://y.gtimg.cn/music/photo/x.jpg"
    );
    expect(publicCoverUrl("http://p1.music.126.net/a.jpg")).toBe("http://p1.music.126.net/a.jpg");
  });

  it("rejects protocol-relative URLs (P2-37)", () => {
    // `//evil.com/x` parses with protocol "http:" against the dummy base, so the
    // old protocol check let it through. It must be rejected outright.
    expect(publicCoverUrl("//evil.com/x.jpg")).toBe("");
    expect(publicCoverUrl("//evil.com")).toBe("");
  });

  it("rejects non-http(s) schemes and empty input", () => {
    expect(publicCoverUrl("javascript:alert(1)")).toBe("");
    expect(publicCoverUrl("data:image/png;base64,AAAA")).toBe("");
    expect(publicCoverUrl("")).toBe("");
  });

  it("keeps the internal jellyfin cover resource path", () => {
    expect(publicCoverUrl("/api/music/jellyfin/cover/abc?tag=t")).toBe(
      "/api/music/jellyfin/cover/abc?tag=t"
    );
  });

  it("rewrites a Jellyfin cover carrying api_key into the internal resource path", () => {
    expect(
      publicCoverUrl("https://jf.local/Items/abc123/Images/Primary?api_key=SECRET&tag=t1")
    ).toBe("/api/music/jellyfin/cover/abc123?tag=t1");
  });
});

describe("normalizeSong id validation (P2-38)", () => {
  const base = { platform: "jellyfin", name: "n", artist: "", album: "", duration: 0 };

  it("accepts a normal id", () => {
    expect(normalizeSong({ ...base, id: "abc-123_XYZ" }).id).toBe("abc-123_XYZ");
  });

  it.each(["/", "\\", "?", "#", "\u0000", "\u001f", ".."])(
    "rejects an id containing %j",
    (bad) => {
      expect(() => normalizeSong({ ...base, id: `a${bad}b` })).toThrow(InvalidMediaInput);
    }
  );

  it("rejects an over-long id", () => {
    expect(() => normalizeSong({ ...base, id: "a".repeat(513) })).toThrow(InvalidMediaInput);
  });
});
