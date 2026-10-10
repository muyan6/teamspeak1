import pino from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Logger = pino.Logger;

/**
 * Field names that must never reach a log line.
 *
 * P2-10: the original list covered cookies/tokens/api keys but NOT the secrets
 * this project actually stores — the TS3 server password, the per-channel
 * password, the TS6 query API key, the account password hash and the bot's TS3
 * `identity` (a private key). No current log statement dumps them, but a single
 * future `logger.info({ bot })` would have written a server password or a
 * private key to disk in cleartext, so they are censored defensively.
 */
const SECRET_FIELDS = [
  "cookie",
  "key",
  "token",
  "password",
  "clientSecret",
  "apiKey",
  "serverPassword",
  "channelPassword",
  "ts6ApiKey",
  "passwordHash",
  "identity",
];

const redact = {
  paths: [
    ...SECRET_FIELDS,
    ...SECRET_FIELDS.map((field) => `*.${field}`),
    ...SECRET_FIELDS.map((field) => `*.*.${field}`),
    'req.headers.cookie',
    'req.headers.authorization',
    'err.config.headers',
    'err.config.params',
    'err.config.data',
    'err.request',
  ],
  censor: '[REDACTED]',
};

export const serializers = {
  err: (err: unknown) => {
    if (!err) return { type: "Error", message: "" };
    if (typeof err === "string") {
      return {
        type: "Error",
        message: err.replace(/([?&](?:api_key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]'),
      };
    }
    const errObj = err as Record<string, unknown>;
    const type = typeof errObj.name === "string" ? errObj.name : "Error";
    const rawMsg = typeof errObj.message === "string" ? errObj.message : String(err);
    const message = rawMsg.replace(/([?&](?:api_key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]');
    return {
      type,
      message,
      stack: typeof errObj.stack === "string" ? errObj.stack : undefined,
    };
  },
  url: (url: unknown) => (url ? String(url).replace(/([?&](?:api_key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]') : ""),
};

/**
 * P2-12: block until buffered log lines have actually reached the file.
 *
 * With `pino.transport()` the writes happen on a worker thread, and
 * `logger.flush` does NOT exist on this pino version — so the old
 * `logger.flush?.()` plus a fixed 100 ms sleep was a guess that could still lose
 * the shutdown lines. thread-stream (behind pino.transport) exposes a real
 * `flushSync()`, which is registered here at construction time.
 */
const transportFlushers = new Set<() => void>();

export function flushLoggerSync(): void {
  for (const flush of transportFlushers) {
    try {
      flush();
    } catch {
      // Shutdown path: never let a log flush failure mask the real exit.
    }
  }
}

export function createLogger(logDir?: string): Logger {
  if (!logDir) {
    return pino({ level: "info", redact, serializers });
  }

  mkdirSync(logDir, { recursive: true });

  const transport = pino.transport({
    targets: [
      {
        target: "pino/file",
        options: { destination: 1 }, // stdout
        level: "info",
      },
      {
        target: 'pino-roll',
        options: { file: join(logDir, 'bot.log'), frequency: 'daily', size: '10m', limit: { count: 7 }, mkdir: true },
        level: "debug",
      },
    ],
  });

  // Prevent EINTR errors from crashing the process (known pino/thread-stream issue on Linux)
  transport.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "EINTR") return;
    console.error("Logger transport error:", err);
  });

  transportFlushers.add(() => {
    (transport as unknown as { flushSync?: () => void }).flushSync?.();
  });

  return pino({ level: "debug", redact, serializers }, transport);
}
