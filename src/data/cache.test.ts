import { describe, it, expect, vi } from "vitest";
import { LRUCache } from "./cache.js";

describe("LRUCache", () => {
  it("stores and retrieves values", () => {
    const cache = new LRUCache<string, number>({ maxSize: 3 });
    cache.set("a", 1);
    cache.set("b", 2);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBeUndefined();
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(false);
  });

  it("evicts least recently used item when max size is exceeded", () => {
    const cache = new LRUCache<string, string>({ maxSize: 3 });
    cache.set("a", "alpha");
    cache.set("b", "beta");
    cache.set("c", "gamma");

    // Access "a" so "b" becomes the least recently used
    cache.get("a");

    // Insert "d" -> "b" should be evicted
    cache.set("d", "delta");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("alpha");
    expect(cache.get("c")).toBe("gamma");
    expect(cache.get("d")).toBe("delta");
  });

  it("expires items after ttl", () => {
    vi.useFakeTimers();
    try {
      const cache = new LRUCache<string, string>({ defaultTtlMs: 1000 });
      cache.set("k1", "v1");
      cache.set("k2", "v2", 5000);

      expect(cache.get("k1")).toBe("v1");
      expect(cache.get("k2")).toBe("v2");

      // Advance by 1500ms -> k1 expires, k2 alive
      vi.advanceTimersByTime(1500);
      expect(cache.get("k1")).toBeUndefined();
      expect(cache.get("k2")).toBe("v2");

      // Advance by 4000ms -> k2 expires
      vi.advanceTimersByTime(4000);
      expect(cache.get("k2")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: get() only drops an EXPIRED entry when that exact key is read
  // again, so a cache filled with short-TTL entries used to stay at maxSize
  // full of dead values while set() evicted LIVE ones. Expired entries must be
  // reclaimed first; only when none are expired does LRU eviction apply.
  it("reclaims expired entries before evicting live ones", () => {
    vi.useFakeTimers();
    try {
      const cache = new LRUCache<string, string>({ maxSize: 2, defaultTtlMs: 1000 });
      cache.set("dead1", "v1");
      cache.set("dead2", "v2");

      vi.advanceTimersByTime(1500); // both expired, but nothing has read them
      cache.set("live", "v3");      // would previously evict "dead1"

      expect(cache.get("live")).toBe("v3");
      expect(cache.size).toBe(1);   // both stale entries were reclaimed
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports delete and clear", () => {
    const cache = new LRUCache<string, number>();
    cache.set("a", 1);
    cache.set("b", 2);

    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("nonexistent")).toBe(false);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("b")).toBeUndefined();
  });
});
