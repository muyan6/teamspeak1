import { describe, it, expect } from "vitest";
import { createLogger, serializers } from "./logger.js";

describe("logger serializers & redaction", () => {
  it("safely serializes standard Error objects", () => {
    const err = new Error("Request failed with status 500");
    const serialized = serializers.err(err);
    expect(serialized).toEqual(
      expect.objectContaining({
        type: "Error",
        message: "Request failed with status 500",
      })
    );
  });

  it("safely serializes string error messages without throwing", () => {
    const serialized = serializers.err("connection reset by peer");
    expect(serialized).toEqual({
      type: "Error",
      message: "connection reset by peer",
    });
  });

  it("safely handles null and undefined err values", () => {
    expect(serializers.err(null)).toEqual({ type: "Error", message: "" });
    expect(serializers.err(undefined)).toEqual({ type: "Error", message: "" });
  });

  it("safely serializes non-Error objects", () => {
    const serialized = serializers.err({ message: "custom obj error", code: 500 });
    expect(serialized).toEqual(
      expect.objectContaining({
        type: "Error",
        message: "custom obj error",
      })
    );
  });

  it("redacts sensitive tokens in error messages", () => {
    const serialized = serializers.err(new Error("failed at https://api.example.com?token=secret123&api_key=456xyz"));
    expect(serialized.message).toBe("failed at https://api.example.com?token=[REDACTED]&api_key=[REDACTED]");
  });

  it("safely serializes and redacts url values", () => {
    expect(serializers.url(undefined)).toBe("");
    expect(serializers.url(null)).toBe("");
    expect(serializers.url("https://example.com/play?access_token=secret789")).toBe(
      "https://example.com/play?access_token=[REDACTED]"
    );
  });

  it("does not throw when logger logs string err or non-error objects", () => {
    const logger = createLogger();
    expect(() => {
      logger.warn({ err: "Connection closed unexpectedly" }, "Warning event");
      logger.error({ err: { foo: "bar" } }, "Error event");
      logger.info({ url: "https://foo.bar?token=abc" }, "Info event");
    }).not.toThrow();
  });
});
