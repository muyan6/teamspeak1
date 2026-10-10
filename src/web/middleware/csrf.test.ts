import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { csrfOriginCheck } from "./csrf.js";

describe("csrfOriginCheck middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(csrfOriginCheck);
    app.get("/", (_req, res) => res.json({ ok: true }));
    app.post("/", (_req, res) => res.json({ ok: true }));
  });

  it("allows safe methods (GET/HEAD/OPTIONS) without Origin", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
  });

  it("rejects POST without Origin or Referer", async () => {
    const res = await request(app).post("/");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "bad origin" });
  });

  it("accepts POST when Origin host matches request host", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Origin", "https://example.com");
    expect(res.status).toBe(200);
  });

  it("rejects POST when Origin host does not match request host", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Origin", "https://evil.com");
    expect(res.status).toBe(403);
  });

  it("accepts POST when Referer host matches and Origin is absent", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Referer", "https://example.com/some/path");
    expect(res.status).toBe(200);
  });

  it("rejects POST when Referer host does not match", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Referer", "https://evil.com/some/path");
    expect(res.status).toBe(403);
  });

  // Documents the server side of the QR-login outage: a `no-referrer` document
  // policy makes the browser send the literal `Origin: null` on same-origin
  // POSTs, which this guard cannot parse a host from and therefore rejects.
  // The fix lives in the frontend (referrer policy -> same-origin); this test
  // pins the gate behavior so the interaction stays understood. See
  // src/web/referrer-policy.test.ts.
  it('rejects POST with the literal Origin: "null" (no-referrer downgrade)', async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Origin", "null");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "bad origin" });
  });

  it("accepts POST when Origin matches X-Forwarded-Host behind reverse proxy", async () => {
    app.set("trust proxy", true);
    const res = await request(app)
      .post("/")
      .set("Host", "127.0.0.1:3000")
      .set("X-Forwarded-Host", "music.example.com")
      .set("Origin", "https://music.example.com");
    expect(res.status).toBe(200);
  });

  // A proxy that APPENDS to X-Forwarded-Host puts client-supplied data FIRST, so
  // the first entry cannot be trusted as "our" host. Without a canonical
  // publicUrl there is nothing server-side to compare against, so the guard now
  // fails closed instead of accepting the spoofable first entry. (This test used
  // to assert 200 for exactly that spoofable shape — see P2-15.)
  it("fails closed on a comma-separated (appended) X-Forwarded-Host without publicUrl", async () => {
    app.set("trust proxy", true);
    const res = await request(app)
      .post("/")
      .set("Host", "127.0.0.1:3000")
      .set("X-Forwarded-Host", "music.example.com, internal-proxy.local")
      .set("Origin", "https://music.example.com");
    expect(res.status).toBe(403);
    expect(res.body.hint).toContain("publicUrl");
  });

  it("rejects a spoofed first X-Forwarded-Host entry (appending proxy)", async () => {
    app.set("trust proxy", true);
    const res = await request(app)
      .post("/")
      .set("Host", "127.0.0.1:3000")
      .set("X-Forwarded-Host", "evil.com, internal-proxy.local")
      .set("Origin", "https://evil.com");
    expect(res.status).toBe(403);
  });

  it("still serves a multi-hop chain once publicUrl pins the canonical host", async () => {
    app.set("trust proxy", true);
    // server.ts sets this from config.publicUrl — with it present the comparison
    // no longer involves any client-supplied header.
    app.set("canonicalHost", "music.example.com");
    const res = await request(app)
      .post("/")
      .set("Host", "127.0.0.1:3000")
      .set("X-Forwarded-Host", "music.example.com, internal-proxy.local")
      .set("Origin", "https://music.example.com");
    expect(res.status).toBe(200);
  });

  it("ignores X-Forwarded-Host when trust proxy is not enabled", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "127.0.0.1:3000")
      .set("X-Forwarded-Host", "evil.com")
      .set("Origin", "https://evil.com");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "bad origin" });
  });
});
