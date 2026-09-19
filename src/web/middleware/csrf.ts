import type { Request, Response, NextFunction } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

  // Preferred: compare against the OPERATOR-CONFIGURED canonical host. When
  // publicUrl is set, one side of the comparison is a server-side value instead
  // of a client-supplied header — which is what made `Origin: evil.com` +
  // `X-Forwarded-Host: evil.com` pass whenever trustProxy was enabled.
  const canonicalHost = req.app?.get("canonicalHost") as string | undefined;
  if (canonicalHost) {
    if (!headerHost || headerHost !== canonicalHost) {
      res.status(403).json({ error: "bad origin" });
      return;
    }
    next();
    return;
  }

  // Fallback (no publicUrl configured): compare Origin/Referer against the
  // request's own host, taking the FIRST X-Forwarded-Host entry — the same
  // convention Express itself uses for req.hostname, and what a multi-hop
  // deployment (outer proxy sets the public host, inner appends) relies on.
  //
  // Residual risk, called out rather than hidden: this fallback compares two
  // client-supplied headers against each other, so a proxy that APPENDS to
  // (instead of setting) X-Forwarded-Host lets a spoofed first entry pass.
  // Configuring `publicUrl` enables the canonical-host path above, which is
  // immune; that is the recommended setup for proxied deployments.
  const isProxyTrusted = Boolean(req.app?.get("trust proxy"));
  const forwardedHost = isProxyTrusted
    ? req.get("x-forwarded-host")?.split(",")[0].trim()
    : undefined;
  const expectedHost = forwardedHost || req.get("host");
  if (!headerHost || !expectedHost || headerHost !== expectedHost) {
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
