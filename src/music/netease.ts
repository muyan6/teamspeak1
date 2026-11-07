import axios, { type AxiosInstance } from "axios";
import type {
  MusicProvider,
  Song,
  SongUrlResult,
  Playlist,
  PlaylistDetail,
  LyricLine,
  SearchResult,
  QrCodeResult,
  AuthStatus,
  Album,
  SearchType,
} from "./provider.js";

export function parseLyrics(lrc: string, tlyric?: string): LyricLine[] {
  if (!lrc) return [];

  const timeTagRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?\]/g;
  const isMeta = /^(作词|作曲|编曲|制作|混音|母带)\s*[:：]/;

  const parseAllLines = (text: string): Array<{ time: number; text: string }> => {
    const result: Array<{ time: number; text: string }> = [];
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      const timestamps: number[] = [];
      let match: RegExpExecArray | null;
      timeTagRegex.lastIndex = 0;
      while ((match = timeTagRegex.exec(line)) !== null) {
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        const ms = match[3] ? parseInt(match[3].padEnd(3, "0").slice(0, 3), 10) : 0;
        timestamps.push(minutes * 60 + seconds + ms / 1000);
      }

      if (timestamps.length === 0) continue;

      const lyricText = line.replace(timeTagRegex, "").trim();
      if (isMeta.test(lyricText)) continue;

      for (const t of timestamps) {
        result.push({ time: t, text: lyricText });
      }
    }
    return result;
  };

  const parsedBase = parseAllLines(lrc);
  const translationMap = new Map<number, string>();

  if (tlyric) {
    for (const item of parseAllLines(tlyric)) {
      if (item.text) {
        translationMap.set(Math.round(item.time * 100), item.text);
      }
    }
  }

  const lines: LyricLine[] = [];
  for (const item of parsedBase) {
    if (!item.text) continue;
    const timeKey = Math.round(item.time * 100);
    lines.push({
      time: item.time,
      text: item.text,
      translation: translationMap.get(timeKey),
    });
  }

  return lines.sort((a, b) => a.time - b.time);
}

/** Join artist names into "A / B", tolerating upstream shape changes. `ar` /
 *  `artists` is normally an array, but a reshaped payload can deliver an object
 *  (or scalar); a bare `.map` on that would throw and 500 the whole search. */
function joinArtists(raw: any): string {
  const list: any[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw)
      : [];
  return list
    .map((x: any) => (x && typeof x === "object" ? x.name ?? "" : x == null ? "" : String(x)))
    .filter(Boolean)
    .join(" / ");
}

export function mapNeteaseAlbums(raw: any[] | null | undefined): Album[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => ({
    id: String(a.id),
    name: a.name ?? "",
    artist: joinArtists(a.artists),
    coverUrl: a.picUrl ?? "",
    songCount: a.size ?? 0,
    platform: "netease",
  }));
}

export function mapNeteaseSongs(raw: any[] | null | undefined): Song[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: any) => ({
    id: String(s.id),
    name: s.name,
    artist: joinArtists(s.ar ?? s.artists),
    album: s.al?.name ?? s.album?.name ?? "",
    duration: Math.round((s.dt ?? s.duration ?? 0) / 1000),
    coverUrl: s.al?.picUrl ?? s.album?.picUrl ?? "",
    platform: "netease",
    // fee: 0=free, 1=VIP, 4=album-only, 8=free low-quality (plays in full, NOT vip)
    vip: s.fee === 1 || s.fee === 4,
  }));
}

/** 解析网易云 freeTrialInfo → 试听秒数；无片段（VIP/免费）返回 undefined。
 *  真实字段 {start,end} 单位秒；容忍 begin/trialBegin 别名 + 毫秒兜底。
 *
 *  单位判定（P2-33）：旧的 `start >= 1000` 启发式会把“长曲中段的试听”
 *  （start=1200 秒/end=1230 秒）误判成毫秒 → 时长被压成 0，nearEnd 立即切歌。
 *  改为与起点无关的“片段长度”量级判断：正常试听片段只有几十秒，span ≥ 1000
 *  只可能是毫秒；同时用上游给出的整曲时长（秒）作佐证——end 明显超过整曲
 *  时长时也判定为毫秒。 */
export function parseNeteaseTrial(item: any): number | undefined {
  const t = item?.freeTrialInfo;
  if (!t || typeof t !== "object") return undefined;
  const start = Number(t.start ?? t.begin ?? t.trialBegin ?? 0);
  const end = Number(t.end ?? t.trialEnd);
  if (!Number.isFinite(end) || end <= start) return undefined;
  const span = end - start;
  const totalSecs = Number(item?.duration ?? 0);
  const isMs = span >= 1000 || (Number.isFinite(totalSecs) && totalSecs > 0 && end > totalSecs + 1);
  const secs = isMs ? span / 1000 : span;
  return Math.round(secs);
}

/**
 * 取流失败后的退避重试序列（毫秒）。
 *
 * 侧车返回 `-460 检测到您的网络环境存在风险` 是瞬时风控，同一首歌隔一会儿
 * 再请求就能拿到地址；单次失败就判定"这首歌不能放"会让 `playNext` 直接跳歌，
 * 连跳几首就把队列跳空、播放器停在 idle（前端表现为"等待播放"）。两次退避
 * 重试足以覆盖绝大部分抖动，又不会让一次真正的换歌卡太久（最多 +2.8s）。
 */
const SONG_URL_RETRY_DELAYS_MS = [800, 2000];

/** 侧车对 `/song/url` 不做缓存，但会缓存 2 分钟内的 200 响应（apicache）。
 *  重试时带上时间戳可以确保拿到的是新一轮判定而不是同一份结果。 */
let neteaseCacheBuster = 0;

/**
 * 给侧车请求补上传输层参数：强制走 weapi 加密通道。
 *
 * NeteaseCloudMusicApi 的 `util/config.json` 里 `APP_CONF.encrypt: true`，于是
 * `util/request.js` 默认把请求加密成 eapi 打到 `interface.music.163.com/eapi/...`。
 * 网易云对这条通道做风控：同一批 `/song/url/v1` 请求里约一半直接返回
 * `-460 检测到您的网络环境存在风险`（实测 eapi 每 12 发被拒 4~8 次，weapi 连续
 * 36 发全过，且与请求间隔无关）。表现就是"点歌时好时坏、播完一首就停在等待播放"。
 * 侧车支持按请求传 `crypto`（util/option.js），注入 weapi 即可绕开。
 *
 * 登录 / 验证码路径保持侧车默认：它们不走这条风控，也避免影响扫码登录流程。
 */
export function withNeteaseTransport<T>(params: T, path: string): T & { crypto?: string } {
  if (path.startsWith("/login") || path.startsWith("/captcha")) return params as T & { crypto?: string };
  return { ...(params as object), crypto: "weapi" } as T & { crypto?: string };
}

// NetEase quality levels: standard(128k) higher(192k) exhigh(320k) lossless(flac) hires(hi-res) jyeffect jymaster
export const NETEASE_QUALITY_LEVELS = [
  { value: "standard", label: "标准 (128kbps)", bitrate: 128 },
  { value: "higher", label: "较高 (192kbps)", bitrate: 192 },
  { value: "exhigh", label: "极高 (320kbps)", bitrate: 320 },
  { value: "lossless", label: "无损 (FLAC)", bitrate: 900 },
  { value: "hires", label: "Hi-Res", bitrate: 1500 },
  { value: "jymaster", label: "超清母带", bitrate: 4000 },
] as const;

export class NeteaseProvider implements MusicProvider {
  readonly platform = "netease" as const;
  private api: AxiosInstance;
  private cookie = "";
  private quality = "exhigh";

  constructor(baseUrl: string) {
    this.api = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
    });
    // P2-30：登录 cookie 不再作为查询参数明文外发（URL 会进入访问日志、也会被
    // 绑定同一 127.0.0.1 端口的任意本机进程读取）。改由请求头 `Cookie` 携带；
    // NeteaseCloudMusicApi 侧车会把请求头 cookie 解析进 req.cookies 并作为默认
    // cookie 使用。拦截器每次请求读取最新 cookie，登录/刷新后立即生效。
    // 用可选链是为了兼容单测里替换成不含 interceptors 的假 api 对象。
    this.api.interceptors?.request?.use?.((config) => {
      // 强制走 weapi 通道（原因见 withNeteaseTransport 的注释）。
      config.params = withNeteaseTransport(config.params, config.url ?? "");
      if (this.cookie) {
        const headers = (config.headers ?? {}) as Record<string, unknown> & { set?: (k: string, v: string) => void };
        if (typeof headers.set === "function") headers.set("Cookie", this.cookie);
        else headers.Cookie = this.cookie;
        config.headers = headers as typeof config.headers;
      }
      return config;
    });
  }

  setQuality(quality: string): void {
    if (NETEASE_QUALITY_LEVELS.some((l) => l.value === quality)) {
      this.quality = quality;
    }
  }

  getQuality(): string {
    return this.quality;
  }

  async search(query: string, limit = 20, offset = 0, type: SearchType = "all"): Promise<SearchResult> {
    const q = query.trim();
    if (!q) return { songs: [], playlists: [], albums: [] };

    const fetchSongs = type === "all" || type === "song";
    const fetchPlaylists = type === "all" || type === "playlist";
    const fetchAlbums = type === "all" || type === "album";

    const [songRes, playlistRes, albumRes] = await Promise.all([
      fetchSongs
        ? this.api.get("/cloudsearch", {
            params: { keywords: q, type: 1, limit, offset },
          }).catch(() => null)
        : Promise.resolve(null),
      fetchPlaylists
        ? this.api.get("/cloudsearch", {
            params: {
              keywords: q,
              type: 1000,
              limit,
              offset,
            },
          }).catch(() => null)
        : Promise.resolve(null),
      fetchAlbums
        ? this.api.get("/cloudsearch", {
            params: { keywords: q, type: 10, limit, offset },
          }).catch(() => null)
        : Promise.resolve(null),
    ]);

    // P2-32：映射阶段单独 try/catch —— 上游把某个字段从数组改成对象时，
    // 映射器不再把整个搜索变成 500，而是降级为空结果 + error（与其它 provider 一致）。
    try {
      const songs: Song[] = songRes ? mapNeteaseSongs(songRes.data?.result?.songs) : [];

      const playlists: Playlist[] = (
        Array.isArray(playlistRes?.data?.result?.playlists)
          ? playlistRes.data.result.playlists
          : []
      ).map((p: any) => ({
        id: String(p.id),
        name: p.name,
        coverUrl: p.coverImgUrl ?? "",
        songCount: p.trackCount ?? 0,
        platform: "netease",
      }));

      const albums = albumRes ? mapNeteaseAlbums(albumRes.data?.result?.albums) : [];

      return { songs, playlists, albums };
    } catch (err) {
      return {
        songs: [],
        playlists: [],
        albums: [],
        error: { message: err instanceof Error ? err.message : "NetEase search failed" },
      };
    }
  }

  async getSongUrl(songId: string, quality?: string): Promise<SongUrlResult | null> {
    const level = quality ?? this.quality;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= SONG_URL_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, SONG_URL_RETRY_DELAYS_MS[attempt - 1]));
      }
      try {
        const res = await this.api.get("/song/url/v1", {
          params: {
            id: songId,
            level,
            // 首次请求保持原样（可吃侧车缓存）；重试时绕过缓存，确保是新一轮
            // 上游判定，而不是把同一份失败/成功结果再拿一遍。
            ...(attempt > 0 ? { _t: `${Date.now()}${neteaseCacheBuster++}` } : {}),
          },
        });
        const item = res.data?.data?.[0];
        const url = item?.url;
        // 200 但拿不到 url：无版权 / 地区限制，重试没有意义。
        if (!url) return null;
        return { url, trialDuration: parseNeteaseTrial(item) };
      } catch (err) {
        // 抛错的是传输层失败（-460 风控返回 HTTP 400、超时、5xx），退避后再试。
        lastError = err;
      }
    }
    throw lastError;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const res = await this.api.get("/song/detail", {
      params: { ids: songId },
    });
    return mapNeteaseSongs(res.data?.songs)[0] ?? null;
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const res = await this.api.get("/playlist/track/all", {
      params: { id: playlistId },
    });
    return mapNeteaseSongs(res.data?.songs);
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    const res = await this.api.get("/personalized", {
      params: { limit: 10 },
    });
    return (res.data?.result ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.picUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    const res = await this.api.get("/album", {
      params: { id: albumId },
    });
    return mapNeteaseSongs(res.data?.songs);
  }

  async getLyrics(songId: string): Promise<LyricLine[]> {
    const res = await this.api.get("/lyric", {
      params: { id: songId },
    });
    return parseLyrics(
      res.data?.lrc?.lyric ?? "",
      res.data?.tlyric?.lyric
    );
  }

  async getQrCode(): Promise<QrCodeResult> {
    const keyRes = await this.api.get("/login/qr/key", {
      params: { timestamp: Date.now() },
    });
    const key = keyRes.data?.data?.unikey ?? "";
    const createRes = await this.api.get("/login/qr/create", {
      params: { key, qrimg: true },
    });
    return {
      qrUrl: createRes.data?.data?.qrurl ?? "",
      qrImg: createRes.data?.data?.qrimg ?? "",
      key,
    };
  }

  async checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    const res = await this.api.get("/login/qr/check", {
      params: { key, timestamp: Date.now() },
    });
    const code = res.data?.code;
    switch (code) {
      case 801:
        return "waiting";
      case 802:
        return "scanned";
      case 803:
        if (res.data?.cookie) {
          this.cookie = res.data.cookie;
        }
        return "confirmed";
      default:
        return "expired";
    }
  }

  async sendSmsCode(phone: string): Promise<boolean> {
    const res = await this.api.get("/captcha/sent", {
      params: { phone },
    });
    return res.data?.code === 200;
  }

  async loginWithSms(phone: string, code: string): Promise<boolean> {
    const res = await this.api.get("/login/cellphone", {
      params: { phone, captcha: code },
    });
    if (res.data?.cookie) {
      this.cookie = res.data.cookie;
    }
    return res.data?.code === 200 && typeof res.data?.cookie === "string" && res.data.cookie.length > 0;
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cookie) return { loggedIn: false };
    try {
      const res = await this.api.get("/login/status", {
        params: {},
      });
      const profile = res.data?.data?.profile;
      if (profile) {
        return {
          loggedIn: true,
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl,
        };
      }
    } catch {
      // ignore
    }
    return { loggedIn: false };
  }

  async getPersonalFm(): Promise<Song[]> {
    const res = await this.api.get("/personal_fm", {
      params: {},
    });
    return mapNeteaseSongs(res.data?.data);
  }

  async getDailyRecommendSongs(): Promise<Song[]> {
    const res = await this.api.get("/recommend/songs", {
      params: {},
    });
    return mapNeteaseSongs(res.data?.data?.dailySongs);
  }

  async getPlaylistDetail(playlistId: string): Promise<PlaylistDetail | null> {
    const res = await this.api.get("/playlist/detail", {
      params: { id: playlistId },
    });
    const p = res.data?.playlist;
    if (!p) return null;
    return {
      id: String(p.id),
      name: p.name ?? "",
      description: p.description ?? "",
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
    };
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    // First get user ID from login status
    const statusRes = await this.api.get("/login/status", {
      params: {},
    });
    const uid = statusRes.data?.data?.profile?.userId;
    if (!uid) return [];

    const res = await this.api.get("/user/playlist", {
      params: { uid },
    });
    return (res.data?.playlist ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));
  }
}
