export interface ParsedCommand {
  name: string;
  args: string;
  rawArgs: string[];
  flags: Set<string>;
}

/**
 * The only `-x` tokens treated as flags. Anything else that merely LOOKS like a
 * flag (`-b`, `-y`, … appearing inside a song title or artist name) stays part
 * of the search query instead of being silently swallowed.
 *
 * Previously any two-character token starting with `-` whose second character
 * was a letter became a flag, so `!play A-Lin -b 给我一个理由` dropped `-b` from
 * the query AND switched the source. Restricting to the known set keeps every
 * documented flag working (`-b -q -y -k -s -l -n -j` for sources, `-a` for
 * `!load`) while a hyphenated word like `-pop` survives as search text.
 *
 * Kept in sync with BotInstance.FLAG_PLATFORMS by hand: adding a source flag
 * there means adding its letter here too, or the new flag parses as plain query
 * text. `commands.test.ts` covers the documented flags.
 */
export const KNOWN_FLAG_LETTERS = new Set([
  "b", // bilibili
  "q", // qq
  "y", // youtube
  "k", // kugou
  "s", // spotify
  "l", // local
  "n", // netease
  "j", // jellyfin
  "a", // !load -a (append)
]);

/**
 * The fixed set of "admin" chat commands. This is the SINGLE source of truth
 * for which commands the permission gate restricts; reclassifying a command is
 * a one-line edit here. Everything not in this set is public.
 */
export const ADMIN_COMMANDS = new Set([
  "stop", "clear", "remove", "move", "vol", "mode",
]);

export function parseCommand(
  message: string,
  prefix: string,
  aliases: Record<string, string> = {},
): ParsedCommand | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith(prefix)) return null;

  const withoutPrefix = trimmed.slice(prefix.length);
  if (!withoutPrefix) return null;

  const parts = withoutPrefix.split(/\s+/);
  let name = parts[0].toLowerCase();

  if (aliases[name]) {
    name = aliases[name];
  }

  const flags = new Set<string>();
  const argParts: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    if (
      parts[i].length === 2 &&
      parts[i].startsWith("-") &&
      KNOWN_FLAG_LETTERS.has(parts[i][1].toLowerCase())
    ) {
      flags.add(parts[i][1].toLowerCase());
    } else {
      argParts.push(parts[i]);
    }
  }

  return {
    name,
    args: argParts.join(" "),
    rawArgs: argParts,
    flags,
  };
}

export function isAdminCommand(commandName: string): boolean {
  return ADMIN_COMMANDS.has(commandName);
}

/**
 * Decide whether a chat command may run, given the invoker's TS server groups
 * and the configured admin groups. Pure + synchronous so it is trivially unit
 * tested and reused by the async gate in BotInstance.
 *
 * Allowed iff: (1) it is a public command, OR (2) enforcement is off
 * (adminGroups empty), OR (3) some invoker group is in adminGroups.
 * invokerGroups (strings from TS) and adminGroups (numbers) are normalized to
 * strings before comparison so "6" matches 6.
 */
export function canRunCommand(
  commandName: string,
  invokerGroups: readonly (string | number)[],
  adminGroups: readonly number[],
): boolean {
  if (!isAdminCommand(commandName)) return true;
  if (adminGroups.length === 0) return true;
  const admin = new Set(adminGroups.map((g) => String(g)));
  return invokerGroups.some((g) => admin.has(String(g)));
}
