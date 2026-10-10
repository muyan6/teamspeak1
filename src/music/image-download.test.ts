import { describe, it, expect } from "vitest";
import { isPublicAddress, isSafeCoverUrl } from "./image-download.js";

describe("isPublicAddress — IPv6 special-purpose blocks (P2-31)", () => {
  it("accepts ordinary global unicast", () => {
    expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
    expect(isPublicAddress("2400:cb00::1")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
  });

  it("rejects Teredo 2001::/32", () => {
    expect(isPublicAddress("2001:0000:4136:e378:8000:63bf:3fff:fdd2")).toBe(false);
  });

  it("rejects the 3fff::/20 documentation block", () => {
    expect(isPublicAddress("3fff::1")).toBe(false);
    expect(isPublicAddress("3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(false);
    // 3fff:1000:: is outside 3fff::/20 and remains global unicast.
    expect(isPublicAddress("3fff:1000::1")).toBe(true);
  });

  it("still rejects 2001:db8::/32, 2002::/16 and non-2000::/3 forms", () => {
    expect(isPublicAddress("2001:db8::1")).toBe(false);
    expect(isPublicAddress("2002::1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fe80::1")).toBe(false);
    expect(isPublicAddress("fc00::1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  });
});

describe("isSafeCoverUrl — literal IPv6 goes through isPublicAddress (P2-31)", () => {
  it("rejects literal IPv6 in a reserved block", () => {
    expect(isSafeCoverUrl("http://[3fff::1]/x.jpg")).toBe(false);
    expect(isSafeCoverUrl("http://[2001:db8::1]/x.jpg")).toBe(false);
  });

  it("accepts a literal public IPv6", () => {
    expect(isSafeCoverUrl("http://[2606:4700::1111]/x.jpg")).toBe(true);
  });
});
