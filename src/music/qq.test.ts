import { describe, it, expect, vi, beforeEach } from "vitest";

// All axios.create(...) instances in qq.ts (qqMusicuApi / qqSearchApi / qqFavApi
// and the per-instance api) share this single mock so the search test can
// inspect the outgoing params/body regardless of which client issued them.
const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock("axios", () => ({
  default: { create: () => ({ get: mockGet, post: mockPost }) },
}));

import {
  mapQqAlbums,
  mapQqSongs,
  parseQqTrial,
  QQMusicProvider,
  parseCookieString,
  serializeCookieMap,
  updateCookieKey,
  mergeCookies,
} from "./qq.js";

describe("QQ adapter", () => {
  it("mapQqSongs maps QQMusicApi-style song entries", () => {
    const out = mapQqSongs([
      {
        mid: "001abc",
        name: "Radar Song",
        singer: [{ name: "Singer A" }, { name: "Singer B" }],
        album: { name: "Album A", mid: "alb001" },
        interval: 243,
      },
    ]);

    expect(out).toEqual([
      {
        id: "001abc",
        name: "Radar Song",
        artist: "Singer A / Singer B",
        album: "Album A",
        duration: 243,
        coverUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000alb001.jpg",
        platform: "qq",
        vip: false,
      },
    ]);
  });

  it("mapQqSongs maps pay field to vip flag", () => {
    const out = mapQqSongs([
      { mid: "v1", name: "VIP playplay", singer: [], album: {}, interval: 100, pay: { payplay: 1, paytrackprice: 0 } },
      { mid: "v2", name: "VIP trackprice", singer: [], album: {}, interval: 100, pay: { payplay: 0, paytrackprice: 1 } },
      { mid: "f1", name: "Free", singer: [], album: {}, interval: 100, pay: { payplay: 0, paytrackprice: 0 } },
      { mid: "f2", name: "No pay field", singer: [], album: {}, interval: 100 },
    ]);
    expect(out[0].vip).toBe(true);
    expect(out[1].vip).toBe(true);
    expect(out[2].vip).toBe(false);
    expect(out[3].vip).toBe(false);
  });

  it("parseQqTrial maps isTryout/tryout to trial seconds", () => {
    // 非试听（VIP/免费）
    expect(parseQqTrial({ isTryout: 0 })).toBeUndefined();
    expect(parseQqTrial({})).toBeUndefined();
    // 试听（秒）
    expect(parseQqTrial({ isTryout: 1, tryBegin: 0, tryEnd: 30 })).toBe(30);
    expect(parseQqTrial({ tryout: true, begin: 0, end: 45 })).toBe(45);
    // 毫秒兜底
    expect(parseQqTrial({ isTryout: 1, tryBegin: 0, tryEnd: 30000 })).toBe(30);
    // 异常
    expect(parseQqTrial({ isTryout: 1, tryEnd: 0 })).toBeUndefined();
  });

  it("parseQqTrial does not mis-detect a deep clip in a long track as ms (P2-33)", () => {
    // start=1200s / end=1230s: 旧启发式 (end>1000) 会当成毫秒→0.03→0 秒。
    expect(parseQqTrial({ isTryout: 1, tryBegin: 1200, tryEnd: 1230 })).toBe(30);
    // 单位仍为秒的普通片段
    expect(parseQqTrial({ isTryout: 1, tryBegin: 0, tryEnd: 60 })).toBe(60);
  });

  it("mapQqSongs tolerates singer being an object instead of an array (P2-32)", () => {
    const out = mapQqSongs([
      { mid: "m1", name: "n", singer: { name: "Solo" } },
    ] as any);
    expect(out[0].artist).toBe("Solo");
  });

  it("mapQqAlbums maps albumMID-style raw entries", () => {
    const raw = [
      {
        albumMID: "abc",
        albumName: "Aero",
        singerName: "Singer A",
      },
      {
        albumMID: "xyz",
        albumName: "Beta",
        singer: [{ name: "Singer B" }, { name: "Singer C" }],
      },
    ];
    const out = mapQqAlbums(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "abc",
      name: "Aero",
      artist: "Singer A",
      platform: "qq",
    });
    expect(out[0].coverUrl).toContain("T002R300x300M000abc.jpg");
    expect(out[1].artist).toBe("Singer B / Singer C");
    expect(out[1].coverUrl).toContain("xyz");
  });

  it("mapQqAlbums returns [] for empty/null input", () => {
    expect(mapQqAlbums([])).toEqual([]);
    expect(mapQqAlbums(null as any)).toEqual([]);
    expect(mapQqAlbums(undefined as any)).toEqual([]);
  });

  it("mapQqAlbums falls back to albumPic when no albumMID", () => {
    const raw = [{ albumName: "C", albumPic: "https://x/p.jpg", singerName: "S" }];
    const out = mapQqAlbums(raw);
    expect(out[0].coverUrl).toBe("https://x/p.jpg");
    expect(out[0].id).toBe("");
  });
});

describe("QQMusicProvider.search pagination", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  /** musicu.fcg returns one song → primary path succeeds. */
  function musicuOk() {
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/cgi-bin/musicu.fcg") {
        return {
          data: {
            req_0: { data: { body: { song: { list: [{ mid: "m1", name: "S", singer: [], album: {}, interval: 100 }] } } } },
            req_album: { data: { body: { album: { list: [] } } } },
            req_playlist: { data: { body: { songlist: { list: [] } } } },
          },
        };
      }
      return { data: {} };
    });
  }

  function musicuReqData() {
    const call = mockGet.mock.calls.find((c: any[]) => c[0] === "/cgi-bin/musicu.fcg");
    expect(call, "expected a musicu.fcg call").toBeTruthy();
    return JSON.parse(call![1].params.data);
  }

  it("adds page_num (offset/limit+1) and limit-driven num_per_page for songs/albums/playlists", async () => {
    musicuOk();
    const p = new QQMusicProvider("http://x");
    await p.search("hello", 20, 20); // page 2

    const d = musicuReqData();
    expect(d.req_0.param.page_num).toBe(2);
    expect(d.req_0.param.num_per_page).toBe(20);
    // Albums/playlists: num_per_page must be limit-driven (NOT hardcoded 10).
    expect(d.req_album.param.page_num).toBe(2);
    expect(d.req_album.param.num_per_page).toBe(20);
    expect(d.req_playlist.param.page_num).toBe(2);
    expect(d.req_playlist.param.num_per_page).toBe(20);
  });

  it("defaults offset to 0 → page_num 1 (backward compatible)", async () => {
    musicuOk();
    const p = new QQMusicProvider("http://x");
    await p.search("hello", 20);
    const d = musicuReqData();
    expect(d.req_0.param.page_num).toBe(1);
  });

  it("fallback client_search_cp sets p to the page cursor", async () => {
    // musicu returns no songs → primary returns null → fallback runs.
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/cgi-bin/musicu.fcg") {
        return { data: { req_0: { data: { body: { song: { list: [] } } } } } };
      }
      // client_search_cp
      return { data: { data: { song: { list: [] }, album: { list: [] } } } };
    });
    const p = new QQMusicProvider("http://x");
    await p.search("hello", 20, 20); // page 2

    const songCall = mockGet.mock.calls.find(
      (c: any[]) => c[0] === "/soso/fcgi-bin/client_search_cp" && c[1]?.params?.type === 0
    );
    expect(songCall, "expected a client_search_cp song call").toBeTruthy();
    expect(songCall![1].params.p).toBe(2);
  });

  it("setQuality validates against QQ_QUALITY_LEVELS", () => {
    const p = new QQMusicProvider("http://x");
    expect(p.getQuality()).toBe("exhigh");
    p.setQuality("lossless");
    expect(p.getQuality()).toBe("lossless");
    p.setQuality("direct"); // foreign value
    expect(p.getQuality()).toBe("lossless"); // unchanged
  });
});

describe("QQ cookie helpers", () => {
  it("parseCookieString parses raw cookie header correctly", () => {
    const parsed = parseCookieString("uin=123456; qqmusic_key=abc123xyz; p_skey=pskey_val; ");
    expect(parsed).toEqual({
      uin: "123456",
      qqmusic_key: "abc123xyz",
      p_skey: "pskey_val",
    });
  });

  it("parseCookieString handles empty or invalid cookies", () => {
    expect(parseCookieString("")).toEqual({});
    expect(parseCookieString("flag; key=val")).toEqual({
      flag: "",
      key: "val",
    });
  });

  it("serializeCookieMap converts map back to string", () => {
    const s = serializeCookieMap({ uin: "123", key: "abc" });
    expect(s).toBe("uin=123; key=abc");
  });

  it("updateCookieKey replaces or inserts a specific key", () => {
    const original = "uin=123; qqmusic_key=old_key";
    const updated = updateCookieKey(original, "qqmusic_key", "new_key");
    expect(updated).toBe("uin=123; qqmusic_key=new_key");

    const inserted = updateCookieKey(original, "musickey", "m_val");
    expect(inserted).toBe("uin=123; qqmusic_key=old_key; musickey=m_val");
  });

  it("mergeCookies merges single or multiple set-cookie lines", () => {
    const base = "uin=123; qqmusic_key=old";
    const merged = mergeCookies(base, [
      "qqmusic_key=renewed; Path=/; Domain=.qq.com; HttpOnly",
      "p_skey=new_pskey; Path=/",
    ]);
    expect(merged).toContain("uin=123");
    expect(merged).toContain("qqmusic_key=renewed");
    expect(merged).toContain("p_skey=new_pskey");
  });
});

describe("QQMusicProvider.refreshSession & keepAlive", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it("returns { success: false, refreshed: false } when no cookie set", async () => {
    const p = new QQMusicProvider("http://x");
    const res = await p.refreshSession();
    expect(res).toEqual({ success: false, refreshed: false });
  });

  it("renews token via musicu.fcg when psrf_qqrefresh_token is present", async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        req: {
          data: {
            musickey: "new_musickey_val",
            qqmusic_key: "new_qqmusic_key_val",
          },
        },
      },
    });

    const p = new QQMusicProvider("http://x");
    let persistedCookie = "";
    p.setPersist((cookie) => {
      persistedCookie = cookie;
    });

    p.setCookie("uin=10001; psrf_qqrefresh_token=mock_refresh_token; psrf_qqopenid=mock_openid; qqmusic_key=old_key");

    const res = await p.refreshSession();
    expect(res).toEqual({ success: true, refreshed: true });
    expect(mockPost).toHaveBeenCalledWith(
      "/cgi-bin/musicu.fcg",
      expect.objectContaining({
        req: {
          module: "QQConnectLogin.LoginServer",
          method: "QQLogin",
          param: expect.objectContaining({
            musicid: 10001,
            refresh_token: "mock_refresh_token",
            openid: "mock_openid",
          }),
        },
      }),
      expect.anything()
    );

    expect(p.getCookie()).toContain("qqmusic_key=new_qqmusic_key_val");
    expect(p.getCookie()).toContain("musickey=new_musickey_val");
    expect(persistedCookie).toBe(p.getCookie());
  });

  it("falls back to keep-alive ping when only basic web cookies exist", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        response: { code: 0 },
      },
      headers: {
        "set-cookie": ["qqmusic_key=ping_renewed; Path=/; Domain=.qq.com"],
      },
    });

    const p = new QQMusicProvider("http://x");
    let persistedCookie = "";
    p.setPersist((cookie) => {
      persistedCookie = cookie;
    });

    p.setCookie("uin=20002; p_skey=some_pskey; qqmusic_key=web_key");

    const res = await p.refreshSession();
    expect(res).toEqual({ success: true, refreshed: false });
    expect(mockGet).toHaveBeenCalledWith(
      "/user/getUserPlaylists",
      expect.objectContaining({
        params: expect.objectContaining({ uin: "20002" }),
      })
    );

    expect(p.getCookie()).toContain("qqmusic_key=ping_renewed");
    expect(persistedCookie).toContain("qqmusic_key=ping_renewed");
  });

  it("starts and stops keep-alive timer cleanly", () => {
    const p = new QQMusicProvider("http://x");
    p.startKeepAlive(60000);
    p.stopKeepAlive();
    // Verify calling stopKeepAlive repeatedly is safe
    expect(() => p.stopKeepAlive()).not.toThrow();
  });
});

describe("QQMusicProvider.getSongUrl fallback (P2-27)", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it("retries with songid when the songmid call is 200 but has no url", async () => {
    mockGet.mockImplementation(async (_url: string, opts: any) => {
      if (opts.params.songmid) return { data: { data: { playUrl: { s1: {} } } } };
      if (opts.params.songid) return { data: { data: { playUrl: { s1: { url: "u:via-songid" } } } } };
      return { data: {} };
    });
    const p = new QQMusicProvider("http://x");
    expect(await p.getSongUrl("s1")).toEqual({ url: "u:via-songid", trialDuration: undefined });
  });

  it("uses the songmid result directly when a url is present", async () => {
    mockGet.mockImplementation(async (_url: string, opts: any) => {
      if (opts.params.songmid) return { data: { data: { playUrl: { s1: { url: "u:via-songmid" } } } } };
      return { data: {} };
    });
    const p = new QQMusicProvider("http://x");
    expect(await p.getSongUrl("s1")).toEqual({ url: "u:via-songmid", trialDuration: undefined });
  });
});

describe("QQMusicProvider.getPlayableSongIds chunk semantics (P2-26)", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  const ids = (n: number, prefix = "m") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("returns a Set (not null) when only SOME chunks fail", async () => {
    // 101 ids → 两个 chunk：[m0..m99] 与 [last]。第二个 chunk 失败。
    mockGet.mockImplementation(async (_url: string, opts: any) => {
      if (opts.params.songmid === "last") throw new Error("transient");
      return { data: { data: { playUrl: { first: { url: "u:first" } } } } };
    });
    const p = new QQMusicProvider("http://x");
    const res = await p.getPlayableSongIds(["first", ...ids(99), "last"]);
    // 只有“所有 chunk 都失败”才回退为 null（旧行为：任一失败即 null）。
    expect(res).toEqual(new Set(["first"]));
  });

  it("returns null only when EVERY chunk fails", async () => {
    mockGet.mockRejectedValue(new Error("down"));
    const p = new QQMusicProvider("http://x");
    expect(await p.getPlayableSongIds(ids(101))).toBeNull();
  });

  it("treats a chunk with no playUrl map as a failure without poisoning others", async () => {
    mockGet.mockImplementation(async (_url: string, opts: any) => {
      if (opts.params.songmid.includes("m0")) return { data: { data: {} } }; // no playUrl map
      return { data: { data: { playUrl: { later: { url: "u:later" } } } } };
    });
    const p = new QQMusicProvider("http://x");
    const res = await p.getPlayableSongIds([...ids(100), "later"]);
    expect(res).toEqual(new Set(["later"]));
  });
});

describe("QQMusicProvider.search degradation (P2-32)", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it("returns empty + error when the mapping stage throws", async () => {
    const evil = [{ mid: "m", name: "n", singer: [{ get name(): string { throw new Error("boom"); } }] }];
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/cgi-bin/musicu.fcg") {
        // primary returns nothing → search() falls back to client_search_cp
        return { data: { req_0: { data: { body: { song: { list: [] } } } } } };
      }
      // fallback path maps this song list → throws in the mapping stage
      return { data: { data: { song: { list: evil }, album: { list: [] } } } };
    });
    const p = new QQMusicProvider("http://x");
    const res = await p.search("q");
    expect(res.songs).toEqual([]);
    expect(res.error?.message).toBe("boom");
  });
});

