import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  MusicProvider,
  Song,
  SongWithUrl,
  SongUrlResult,
  Playlist,
  Album,
  SearchResult,
  LyricLine,
  QrCodeResult,
  AuthStatus,
} from "./provider.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the yt-dlp binary path. Checks the project bin/ dir first, then PATH. */
function findYtDlp(): string {
  const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const candidates = [
    join(__dirname, "..", "..", "bin", exe),
    join(__dirname, "..", "..", "bin", "yt-dlp"),
    exe,
  ];
  for (const c of candidates) {
    // Absolute/relative paths: only return if the file exists.
    // Bare names: return and let execFile resolve via PATH.
    const isBinPath = c.includes(join("bin", "yt-dlp"));
    if (!isBinPath || existsSync(c)) return c;
  }
  return exe;
}

/**
 * Availability check for yt-dlp. Runs `yt-dlp --version` and caches only
 * the positive result — if the binary is missing, subsequent calls retry
 * so the user can install yt-dlp while the server is running and pick it
 * up without a restart. Used by getAuthStatus() so the UI can reflect
 * whether YouTube is actually usable.
 */
let cachedAvailable = false;
let pendingCheck: Promise<boolean> | null = null;
async function checkYtDlpAvailable(): Promise<boolean> {
  if (cachedAvailable) return true;
  if (pendingCheck) return pendingCheck;
  pendingCheck = (async () => {
    try {
      await execFileAsync(findYtDlp(), ["--version"], {
        timeout: 5_000,
        maxBuffer: 1024,
      });
      cachedAvailable = true;
      return true;
    } catch {
      return false;
    } finally {
      pendingCheck = null;
    }
  })();
  return pendingCheck;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/** True only for an http(s) URL whose host is a known YouTube domain. */
export function isYouTubeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return YOUTUBE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Force re-detection on the next call (for tests). */
export function resetYtDlpAvailabilityCache(): void {
  cachedAvailable = false;
  pendingCheck = null;
}

async function runYtDlp(args: string[], timeoutMs = 30_000): Promise<string> {
  const binary = findYtDlp();
  const env = { ...process.env };
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    // yt-dlp respects these env vars natively
  }
  const { stdout } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

interface YtDlpEntry {
  id: string;
  title: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  webpage_url?: string;
  url?: string;
  entries?: YtDlpEntry[];
  _type?: string;
}

function entryToSong(entry: YtDlpEntry): Song {
  return {
    id: entry.id ?? "",
    name: entry.title ?? "Unknown",
    artist: entry.uploader ?? entry.channel ?? "YouTube",
    album: "YouTube",
    duration: Math.round(entry.duration ?? 0),
    coverUrl: entry.thumbnail ?? "",
    platform: "youtube",
  };
}

export class YouTubeProvider implements MusicProvider {
  readonly platform = "youtube" as const;
  private quality = "bestaudio";

  async search(query: string, limit = 5, offset = 0): Promise<SearchResult> {
    try {
      // yt-dlp's `ytsearchN` has no offset cursor — it always returns the first
      // N results. Best-effort paginate by fetching offset+limit and slicing
      // locally. (offset 0 → identical to before.)
      const total = offset + limit;
      const raw = await runYtDlp([
        `ytsearch${total}:${query}`,
        "--dump-json",
        "--flat-playlist",
        "--no-warnings",
        "--quiet",
      ]);
      const lines = raw.trim().split("\n").filter(Boolean);
      const entries: YtDlpEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as YtDlpEntry);
        } catch {
          // Ignore non-JSON lines emitted by yt-dlp
        }
      }
      const songs: Song[] = entries
        .slice(offset, offset + limit)
        .map((entry) => entryToSong(entry));
      return { songs, playlists: [], albums: [] };
    } catch (err) {
      return {
        songs: [],
        playlists: [],
        albums: [],
        error: {
          code: (err as any)?.code || "YT_SEARCH_FAILED",
          message: (err as Error)?.message || "YouTube search failed",
        },
      };
    }
  }

  async getSongUrl(songId: string): Promise<SongUrlResult | null> {
    try {
      const url = `https://www.youtube.com/watch?v=${songId}`;
      const raw = await runYtDlp([
        url,
        "--get-url",
        "-f",
        "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
        "--no-warnings",
        "--quiet",
      ], 45_000);
      const audioUrl = raw.trim().split("\n")[0];
      return audioUrl ? { url: audioUrl } : null;
    } catch {
      return null;
    }
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    try {
      const url = `https://www.youtube.com/watch?v=${songId}`;
      const raw = await runYtDlp([url, "--dump-json", "--no-warnings", "--quiet"]);
      const entry = JSON.parse(raw.trim()) as YtDlpEntry;
      return entryToSong(entry);
    } catch {
      return null;
    }
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    try {
      // SSRF guard: a raw "http…" id used to be handed to yt-dlp verbatim, so a
      // caller could make the host fetch http://127.0.0.1:<port>/, link-local
      // metadata endpoints, or file:// paths. Accept a URL only when it points
      // at a YouTube host; otherwise treat the value as a bare playlist id.
      let url: string;
      if (playlistId.startsWith("http")) {
        const allowed = isYouTubeUrl(playlistId);
        if (!allowed) {
          return [];
        }
        url = playlistId;
      } else {
        url = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
      }
      const raw = await runYtDlp([
        url,
        "--dump-json",
        "--flat-playlist",
        "--no-warnings",
        "--quiet",
      ], 60_000);
      const lines = raw.trim().split("\n").filter(Boolean);
      const songs: Song[] = [];
      for (const line of lines) {
        try {
          songs.push(entryToSong(JSON.parse(line) as YtDlpEntry));
        } catch {
          // Ignore non-JSON lines emitted by yt-dlp
        }
      }
      return songs;
    } catch {
      return [];
    }
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return [];
  }

  async getAlbumSongs(_albumId: string): Promise<Song[]> {
    return [];
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getQrCode(): Promise<QrCodeResult> {
    return { qrUrl: "", key: "" };
  }

  async checkQrCodeStatus(
    _key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }

  setCookie(_cookie: string): void {}
  getCookie(): string { return ""; }

  async getAuthStatus(): Promise<AuthStatus> {
    // YouTube has no login concept via yt-dlp, so "loggedIn" here means
    // "yt-dlp binary is reachable and responds to --version". The UI can
    // use this flag to grey out YouTube when the optional dependency is
    // missing, instead of silently returning empty search results.
    const available = await checkYtDlpAvailable();
    if (available) {
      return { loggedIn: true, nickname: "YouTube (yt-dlp)" };
    }
    return {
      loggedIn: false,
      nickname: "YouTube (yt-dlp not installed)",
    };
  }
}
