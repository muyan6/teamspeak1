import pino from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Logger = pino.Logger;
const redact = { paths: ['cookie', 'key', 'token', 'password', 'clientSecret', 'apiKey',
  '*.cookie', '*.key', '*.token', '*.password', '*.clientSecret', '*.apiKey',
  'req.headers.cookie', 'req.headers.authorization', 'err.config.headers', 'err.config.params', 'err.config.data', 'err.request'], censor: '[REDACTED]' };

export function createLogger(logDir?: string): Logger {
  if (!logDir) {
    return pino({ level: "info", redact });
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

  return pino({ level: "debug", redact, serializers: {
    err: (err: Error) => ({ type: err.name, message: err.message.replace(/([?&](?:api_key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]') }),
    url: (url: string) => String(url).replace(/([?&](?:api_key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]'),
  } }, transport);
}
