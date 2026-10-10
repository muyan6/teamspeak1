const ESCAPE_MAP: [string, string][] = [
  ["\\", "\\\\"],
  ["/", "\\/"],
  [" ", "\\s"],
  ["|", "\\p"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\x07", "\\a"],
  ["\x08", "\\b"],
  ["\x0C", "\\f"],
  ["\x0B", "\\v"],
];

/** escape-code character -> the value it stands for. */
const UNESCAPE_TABLE: Record<string, string> = Object.fromEntries(
  ESCAPE_MAP.map(([plain, escaped]) => [escaped.slice(1), plain]),
);

export function escapeValue(value: string): string {
  let result = value;
  for (const [plain, escaped] of ESCAPE_MAP) {
    result = result.replaceAll(plain, escaped);
  }
  return result;
}

/**
 * Reverse `escapeValue` with a SINGLE left-to-right pass.
 *
 * A sequence of `replaceAll` calls cannot invert the escaping: the replacement
 * for `\s` also matches the second character of the escape sequence `\\`, so
 * `unescapeValue(escapeValue("back\\slash"))` yielded `back\ lash`. Scanning
 * once and consuming the character after a backslash keeps `\\` opaque, which is
 * exactly how the TeamSpeak query protocol is defined.
 */
export function unescapeValue(value: string): string {
  if (!value.includes("\\")) return value;
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const replacement = UNESCAPE_TABLE[value[i + 1]];
      if (replacement !== undefined) {
        result += replacement;
        i++; // consume the escape code
        continue;
      }
    }
    result += ch;
  }
  return result;
}

export function encodeCommand(
  command: string,
  params: Record<string, string | number>
): string {
  const parts = [command];
  for (const [key, value] of Object.entries(params)) {
    parts.push(`${key}=${escapeValue(String(value))}`);
  }
  return parts.join(" ") + "\n";
}

export function decodeResponse(raw: string): Record<string, string>[] {
  const entries = raw.split("|");
  return entries.map((entry) => {
    const result: Record<string, string> = {};
    const pairs = entry.trim().split(" ");
    for (const pair of pairs) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) {
        result[pair] = "";
      } else {
        const key = pair.substring(0, eqIndex);
        const value = unescapeValue(pair.substring(eqIndex + 1));
        result[key] = value;
      }
    }
    return result;
  });
}

export function parseErrorLine(line: string): { id: number; msg: string } {
  const decoded = decodeResponse(line.replace(/^error\s+/, ""))[0];
  return {
    id: parseInt(decoded.id ?? "0", 10),
    msg: decoded.msg ?? "ok",
  };
}
