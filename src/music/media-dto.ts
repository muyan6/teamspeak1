import type { Song, Platform } from './provider.js';
import type { QueuedSong } from '../audio/queue.js';
import { createHash } from 'node:crypto';
import type { MusicProvider } from './provider.js';
import type { BotConfig } from '../data/config.js';

export function musicContext(config: BotConfig | undefined, providers: MusicProvider[]): string {
  return createHash('sha256').update(JSON.stringify([
    config,
    providers.map(p => [p.platform, p.getCookie?.(), p.getQuality?.()]),
  ])).digest('hex');
}

export const PLATFORMS: readonly Platform[] = ['netease', 'qq', 'bilibili', 'youtube', 'local', 'kugou', 'spotify', 'jellyfin'];

/** Browser-facing Jellyfin art identifies a resource, never an account token.
 *
 *  P2-37: only ABSOLUTE http(s) URLs may pass. A protocol-relative URL
 *  (`//evil.com/x`) parses with `u.protocol === "http:"` (resolved against the
 *  dummy base), so the old protocol check let it through — the browser would
 *  then load `//evil.com/x` for every viewer. Require the RAW string to start
 *  with `http://` / `https://`, and reject `//host/...`. */
export function publicCoverUrl(value: string): string {
  if (!value) return '';
  try {
    const u = new URL(value, 'http://relative.invalid');
    if (u.searchParams.has('api_key') || u.searchParams.has('AccessToken')) {
      const m = /\/Items\/([^/]+)\/Images\/Primary$/i.exec(u.pathname);
      if (!m) return '';
      const tag = u.searchParams.get('tag');
      return `/api/music/jellyfin/cover/${encodeURIComponent(decodeURIComponent(m[1]))}${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`;
    }
    if (value.startsWith('/api/music/jellyfin/cover/')) return value;
    if (!/^https?:\/\//i.test(value)) return '';
    return /^https?:$/.test(u.protocol) ? value : '';
  } catch { return ''; }
}

/** White-list output fields; internal URLs and caller-supplied properties stay internal. */
export function publicSong(song: QueuedSong | Song): QueuedSong {
  return {
    id: song.id, name: song.name, artist: song.artist, album: song.album,
    platform: song.platform, duration: song.duration, coverUrl: publicCoverUrl(song.coverUrl),
    ...('requestedBy' in song && song.requestedBy ? { requestedBy: song.requestedBy } : {}),
    ...('vip' in song && typeof song.vip === 'boolean' ? { vip: song.vip } : {}),
  };
}

export class InvalidMediaInput extends Error { readonly status = 400; }

/**
 * Characters that must never appear in a provider id.
 *
 * Ids are interpolated straight into upstream request PATHS (e.g. Jellyfin's
 * `/Audio/{id}/stream`, `/Playlists/{id}/Items`), so a `/`, `\`, `?`, `#` or a
 * `..` segment lets a caller steer the request to another endpoint while the
 * server's own credential is attached. Every real id in use is alphanumeric
 * with `-`/`_` (NetEase/QQ numeric, kugou hex, Spotify base62, Jellyfin hex32,
 * YouTube 11 chars, local uuid), so this rejects nothing legitimate.
 */
const UNSAFE_ID_CHARS = /[/\\?#\u0000-\u001f]/;

export function normalizeSong(input: unknown): QueuedSong {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidMediaInput('song object required');
  const s = input as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id.trim() || s.id.length > 512 ||
      UNSAFE_ID_CHARS.test(s.id) || s.id.includes('..')) throw new InvalidMediaInput('invalid song id');
  if (typeof s.platform !== 'string' || !PLATFORMS.includes(s.platform as Platform)) throw new InvalidMediaInput('invalid platform');
  const text = (key: string, max: number, fallback = '') => {
    const v = s[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'string' || v.length > max) throw new InvalidMediaInput(`invalid ${key}`);
    return v;
  };
  const duration = s.duration ?? 0;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 604800) throw new InvalidMediaInput('invalid duration');
  return {
    id: s.id, platform: s.platform as Platform, name: text('name', 1000, s.id),
    artist: text('artist', 1000), album: text('album', 1000),
    duration, coverUrl: publicCoverUrl(text('coverUrl', 8192)),
    ...(typeof s.requestedBy === 'string' ? { requestedBy: text('requestedBy', 100) } : {}),
  };
}
