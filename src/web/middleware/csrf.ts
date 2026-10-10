import type { Request, Response, NextFunction } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The host that Origin/Referer must match, plus whether the request can be
 * judged at all.
 *
 * `reject` means "undeterminable, fail closed": a trusted proxy is in front but
 * it APPENDED to X-Forwarded-Host, so the first entry is client-supplied and the
 * last is not demonstrably ours either. Without a canonical `publicUrl` there is
 * no server-side value to compare against, so the safest answer is to refuse —
 * otherwise `Origin: evil.com` + `X-Forwarded-Host: evil.com,…` would pass.
 */
export interface HostResolution {
  host: string | null;
  reject: boolean;
  reason?: string;
}

export function resolveExpectedHost(input: {
  canonicalHost?: string;
  isProxyTrusted: boolean;
  xForwardedHost?: string;
  hostHeader?: string;
}): HostResolution {
  const canonical = (input.canonicalHost ?? "").trim();
  if (canonical) return { host: canonical, reject: false };

  if (input.isProxyTrusted) {
    const entries = (input.xForwardedHost ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length > 1) {
      return { host: null, reject: true, reason: "ambiguous X-Forwarded-Host chain" };
    }
    if (entries.length === 1) return { host: entries[0], reject: false };
  }

  const host = (input.hostHeader ?? "").trim();
  return { host: host || null, reject: false };
}

/**
 * Same-origin CSRF protection. For mutating requests, the Origin or Referer
 * header must indicate a host equal to the request's own host.
 *
 * SameSite=Lax on the session cookie blocks classic cross-site form posts;
 * this header check covers the remaining attack surface.
 */
export function csrfOriginCheck(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const originHeader = req.get("origin");
  const refererHeader = req.get("referer");
  const headerHost = hostOf(originHeader) ?? hostOf(refererHeader);

  const trust = req.app?.get("trust proxy fn") as ((ip: string, hop: number) => boolean) | undefined;
  const isProxyTrusted = trust?.(req.socket?.remoteAddress ?? "", 0) ?? false;
  const resolved = resolveExpectedHost({
    canonicalHost: req.app?.get("canonicalHost") as string | undefined,
    isProxyTrusted,
    xForwardedHost: req.get("x-forwarded-host"),
    hostHeader: req.get("host"),
  });

  // No `publicUrl` + a proxy that appends to X-Forwarded-Host: we cannot tell
  // which host is really ours, so we fail closed. The operator fixes this once
  // by configuring `publicUrl`.
  if (resolved.reject) {
    res.status(403).json({
      error: "bad origin",
      hint: "trusted proxy supplied an ambiguous X-Forwarded-Host chain; set publicUrl",
    });
    return;
  }

  if (!headerHost || !resolved.host || headerHost !== resolved.host) {
    res.status(403).json({ error: "bad origin" });
    return;
  }
  next();
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
