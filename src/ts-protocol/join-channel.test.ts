import { describe, it, expect, vi, beforeEach } from "vitest";
import { TS3Client } from "./client.js";
import type { Logger } from "../logger.js";
import { clientMove, listChannels } from "@honeybbq/teamspeak-client";

// Only the two transport calls joinChannel makes are stubbed; everything else
// stays real so the client's own wiring is exercised.
vi.mock("@honeybbq/teamspeak-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@honeybbq/teamspeak-client")>();
  return {
    ...actual,
    clientMove: vi.fn(),
    listChannels: vi.fn(),
  };
});

const mockedMove = vi.mocked(clientMove);
const mockedListChannels = vi.mocked(listChannels);

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

/** Wire just enough private state for joinChannel to run without connecting. */
function makeClient() {
  const logger = makeLogger();
  const tsClient = new TS3Client(
    {
      host: "127.0.0.1",
      port: 9987,
      queryPort: 10011,
      nickname: "test-bot",
      serverProtocol: "ts3",
    },
    logger,
  );
  const sendCommandNoWait = vi.fn(async () => {});
  const raw = tsClient as unknown as {
    client: unknown;
    clientId: number;
    currentChannelId: bigint;
  };
  raw.client = { sendCommandNoWait };
  raw.clientId = 1;
  raw.currentChannelId = 0n;
  return { tsClient, logger, sendCommandNoWait };
}

/** Collects "Failed to join channel" records the way pino would receive them. */
function failedJoinLogs(logger: Logger) {
  return (logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([, msg]) => msg === "Failed to join channel",
  );
}

beforeEach(() => {
  mockedMove.mockReset();
  mockedListChannels.mockReset();
});

describe("TS3Client.joinChannel logging", () => {
  it("logs a numeric-channel move failure exactly once", async () => {
    const { tsClient, logger } = makeClient();
    mockedMove.mockRejectedValue(
      Object.assign(new Error("command timeout: clientmove clid=1 cid=7"), {
        name: "CommandTimeoutError",
      }),
    );

    await expect(tsClient.joinChannel("7")).rejects.toThrow("command timeout");
    expect(failedJoinLogs(logger)).toHaveLength(1);
  });

  it("logs a name-channel move failure exactly once (no duplicate from the outer catch)", async () => {
    const { tsClient, logger } = makeClient();
    mockedListChannels.mockResolvedValue([
      { id: 7n, name: "Music" },
    ] as Awaited<ReturnType<typeof listChannels>>);
    mockedMove.mockRejectedValue(
      Object.assign(new Error("command timeout: clientmove clid=1 cid=7"), {
        name: "CommandTimeoutError",
      }),
    );

    await expect(tsClient.joinChannel("Music")).rejects.toThrow("command timeout");
    expect(failedJoinLogs(logger)).toHaveLength(1);
  });

  it("throws (and logs once) when the channel name does not exist", async () => {
    const { tsClient, logger } = makeClient();
    mockedListChannels.mockResolvedValue([
      { id: 7n, name: "Music" },
    ] as Awaited<ReturnType<typeof listChannels>>);

    await expect(tsClient.joinChannel("Nope")).rejects.toThrow(
      "Channel not found: Nope",
    );
    expect(failedJoinLogs(logger)).toHaveLength(1);
    expect(mockedMove).not.toHaveBeenCalled();
  });

  it("treats error 770 (already a member) as success without logging a failure", async () => {
    const { tsClient, logger } = makeClient();
    mockedListChannels.mockResolvedValue([
      { id: 7n, name: "Music" },
    ] as Awaited<ReturnType<typeof listChannels>>);
    mockedMove.mockRejectedValue(
      Object.assign(new Error("already member of channel"), { id: "770" }),
    );

    await expect(tsClient.joinChannel("Music")).resolves.toBeUndefined();
    expect(failedJoinLogs(logger)).toHaveLength(0);
  });

  it("logs 'Joined channel' once on success", async () => {
    const { tsClient, logger, sendCommandNoWait } = makeClient();
    mockedListChannels.mockResolvedValue([
      { id: 7n, name: "Music" },
    ] as Awaited<ReturnType<typeof listChannels>>);
    mockedMove.mockResolvedValue(
      undefined as unknown as Awaited<ReturnType<typeof clientMove>>,
    );

    await tsClient.joinChannel("Music");

    const joined = (
      logger.info as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([, msg]) => msg === "Joined channel");
    expect(joined).toHaveLength(1);
    expect(sendCommandNoWait).toHaveBeenCalledWith("channelsubscribe cid=7");
  });
});
