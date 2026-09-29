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

/** Browser-facing Jellyfin art identifies a resource, never an account token. */
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

export function normalizeSong(input: unknown): QueuedSong {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidMediaInput('song object required');
  const s = input as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id.trim() || s.id.length > 512 || /[\r\n\x00]/.test(s.id)) throw new InvalidMediaInput('invalid song id');
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
