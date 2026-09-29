import { describe, it, expect, vi } from "vitest";
import { TS3Client } from "./client.js";
import type { Logger } from "../logger.js";

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => stubLogger,
} as unknown as Logger;

describe("TS3Client connection safety", () => {
  it("rejects gracefully when port is invalid without uncaught exception", async () => {
    const client = new TS3Client(
      {
        host: "127.0.0.1",
        port: 99999, // invalid port > 65535
        queryPort: 10011,
        nickname: "test-bot",
        serverProtocol: "ts3",
      },
      stubLogger
    );

    await expect(client.connect()).rejects.toThrow();
    client.disconnect();
  });

  it("handles embedded port normalization in host string correctly", async () => {
    const client = new TS3Client(
      {
        host: "127.0.0.1:99999",
        port: 9987,
        queryPort: 10011,
        nickname: "test-bot",
        serverProtocol: "ts3",
      },
      stubLogger
    );

    await expect(client.connect()).rejects.toThrow();
    client.disconnect();
  });

  it("getHost returns normalized host when unresolved and prefers resolved endpoint", () => {
    const client = new TS3Client(
      {
        host: "stormclub.ts3.uno:60001",
        port: 9987,
        queryPort: 10011,
        nickname: "test-bot",
        serverProtocol: "ts3",
      },
      stubLogger
    );

    expect(client.getHost()).toBe("stormclub.ts3.uno");

    // When resolver has pinned an IPv4 endpoint
    (client as any).voiceEndpointResolver.endpoint = { host: "154.211.23.45", port: 60001 };
    expect(client.getHost()).toBe("154.211.23.45");

    const ipv6Client = new TS3Client(
      {
        host: "[2001:db8::1]:9987",
        port: 9987,
        queryPort: 10011,
        nickname: "test-bot",
        serverProtocol: "ts3",
      },
      stubLogger
    );
    expect(ipv6Client.getHost()).toBe("2001:db8::1");

    const bareIpv6Client = new TS3Client(
      {
        host: "2001:db8::1",
        port: 9987,
        queryPort: 10011,
        nickname: "test-bot",
        serverProtocol: "ts3",
      },
      stubLogger
    );
    expect(bareIpv6Client.getHost()).toBe("2001:db8::1");

    const loopbackIpv6Client = new TS3Client(
      {
        host: "::1",
        port: 9987,
        queryPort: 10011,
        nickname: "test-bot",
        serverProtocol: "ts3",
      },
      stubLogger
    );
    expect(loopbackIpv6Client.getHost()).toBe("::1");
  });
});
