import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

export function isPublicAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(a) === 4) {
    const [x, y, z] = a.split('.').map(Number);
    return !(x === 0 || x === 10 || x === 127 || x >= 224 ||
      (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && (y === 168 || y === 0 || (y === 88 && z === 99))) ||
      (x === 100 && y >= 64 && y <= 127) || (x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) ||
      (x === 203 && y === 0 && z === 113));
  }
  if (isIP(a) === 6) {
    // Only global unicast 2000::/3. This also excludes all IPv4-mapped,
    // loopback, unspecified, link-local, ULA and multicast representations.
    const first = parseInt(a.split(':')[0], 16);
    return first >= 0x2000 && first <= 0x3fff && !a.startsWith('2001:db8:') && !a.startsWith('2002:');
  }
  return false;
}

export function isSafeCoverUrl(raw: string, allowedOrigins: string[] = []): boolean {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // Private servers are only permitted for the configured image resource
    // on exactly the configured origin (including its port).
    if (allowedOrigins.some(origin => {
      try { return new URL(origin).origin === u.origin; } catch { return false; }
    })) return /\/Items\/[^/]+\/Images\/Primary$/i.test(u.pathname);
    if (host === 'localhost' || !host.includes('.') && !isIP(host) || /\.(?:local|internal|localhost)\.?$/.test(host)) return false;
    return isIP(host) ? isPublicAddress(host) : true;
  } catch { return false; }
}

/** DNS is checked once and the approved address is pinned to the connection.
 * Redirects are never followed, including redirects from an approved server. */
export async function downloadCoverImage(raw: string, allowedOrigins: string[] = []): Promise<Buffer | null> {
  if (!isSafeCoverUrl(raw, allowedOrigins)) return null;
  const u = new URL(raw), host = u.hostname.replace(/^\[|\]$/g, '');
  const trusted = allowedOrigins.some(v => { try { return new URL(v).origin === u.origin; } catch { return false; } });
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('cover DNS lookup timed out')), 8000); }),
  ]).finally(() => { if (dnsTimer) clearTimeout(dnsTimer); });
  if (!addresses.length || !trusted && addresses.some(a => !isPublicAddress(a.address))) return null;
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.get(u, {
      agent: false,
      lookup: ((_h: string, options: { all?: boolean }, cb: (...args: any[]) => void) => {
        if (options.all) cb(null, [selected]); else cb(null, selected.address, selected.family);
      }) as http.RequestOptions['lookup'],
    }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) res.destroy(new Error('cover image exceeds 2 MB'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const timer = setTimeout(() => req.destroy(new Error('cover download timed out')), 8000);
    req.on('error', reject); req.on('close', () => clearTimeout(timer));
  });
}
