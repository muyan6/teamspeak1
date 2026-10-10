import { describe, it, expect, vi } from "vitest";
import { BiliBiliProvider, isBilibiliCdnHost } from "./bilibili.js";

describe("BiliBiliProvider.search pagination", () => {
  function mockProvider() {
    const p = new BiliBiliProvider();
    const get = vi.fn().mockResolvedValue({ data: { data: { result: [] } } });
    // Short-circuit the buvid + wbi bootstrap so search only issues the
    // /search/type request we want to inspect.
    (p as any).buvidInitialized = true;
    (p as any).wbiMixinKey = "0".repeat(32);
    (p as any).wbiKeyFetchedAt = Date.now();
    (p as any).api = { get };
    return { p, get };
  }

  function searchParams(get: ReturnType<typeof vi.fn>) {
    const call = get.mock.calls.find(
      (c: any[]) => c[0] === "/x/web-interface/wbi/search/type"
    );
    expect(call, "expected a /search/type call").toBeTruthy();
    // signWbi stringifies every value.
    return call![1].params as Record<string, string>;
  }

  it("adds page (offset/limit+1) alongside page_size", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20, 20); // page 2
    const params = searchParams(get);
    expect(params.page).toBe("2");
    expect(params.page_size).toBe("20");
  });

  it("defaults offset to 0 → page 1 (backward compatible)", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20);
    expect(searchParams(get).page).toBe("1");
  });

  it("clamps page_size to B站's 50 cap (P2-29①)", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 100);
    expect(searchParams(get).page_size).toBe("50");
  });
});

describe("BiliBiliProvider.search degradation (P2-28)", () => {
  function failingProvider(delayMs = 0) {
    const p = new BiliBiliProvider();
    (p as any).buvidInitialized = true;
    (p as any).wbiMixinKey = "";
    (p as any).wbiKeyFetchedAt = 0;
    (p as any).wbiKeyFailedAt = 0;
    const get = vi.fn(async (_url: string) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      throw new Error("ECONNRESET");
    });
    (p as any).api = { get };
    return { p, get };
  }

  it("returns empty + error instead of throwing when wbi/network fails", async () => {
    const { p } = failingProvider();
    const res = await p.search("hello");
    expect(res.songs).toEqual([]);
    expect(res.error).toBeDefined();
  });

  it("backs off wbi key fetches after a failure (does not hammer nav)", async () => {
    const { p, get } = failingProvider();
    await p.search("hello");
    await p.search("hello");
    const navCalls = get.mock.calls.filter((c: any[]) => c[0] === "/x/web-interface/nav").length;
    expect(navCalls).toBe(1);
  });
});

describe("BiliBiliProvider.getSongUrl candidates (P2-29)", () => {
  it("prefers a known B站 CDN host among baseUrl/backupUrl candidates", async () => {
    const p = new BiliBiliProvider();
    (p as any).buvidInitialized = true;
    (p as any).cidCache.set("BV1", 123);
    (p as any).api = {
      get: vi.fn(async () => ({
        data: {
          data: {
            dash: {
              audio: [
                {
                  bandwidth: 100,
                  baseUrl: "https://cos.example-cdn.com/a.m4s",
                  backupUrl: ["https://upos-sz-mirrorcoso1.bilivideo.com/a.m4s"],
                },
              ],
            },
          },
        },
      })),
    };
    const res = await p.getSongUrl("BV1");
    expect(res?.url).toBe("https://upos-sz-mirrorcoso1.bilivideo.com/a.m4s");
  });

  it("falls back to baseUrl when no candidate is a known CDN host", async () => {
    const p = new BiliBiliProvider();
    (p as any).cidCache.set("BV2", 456);
    (p as any).api = {
      get: vi.fn(async () => ({
        data: { data: { dash: { audio: [{ bandwidth: 1, baseUrl: "https://cdn.unknown.test/a.m4s" }] } } },
      })),
    };
    const res = await p.getSongUrl("BV2");
    expect(res?.url).toBe("https://cdn.unknown.test/a.m4s");
  });
});

describe("isBilibiliCdnHost (P2-29③)", () => {
  it("matches by host suffix, not substring", () => {
    expect(isBilibiliCdnHost("upos-sz-mirrorcoso1.bilivideo.com")).toBe(true);
    expect(isBilibiliCdnHost("i0.hdslb.com")).toBe(true);
    expect(isBilibiliCdnHost("evil-bilivideo.attacker.com")).toBe(false);
    expect(isBilibiliCdnHost("notbilibili.com.evil.test")).toBe(false);
  });
});

