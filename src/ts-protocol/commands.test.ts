import { describe, it, expect } from "vitest";
import {
  encodeCommand,
  decodeResponse,
  escapeValue,
  unescapeValue,
} from "./commands.js";

describe("TS3 Commands", () => {
  it("encodes a simple command", () => {
    const encoded = encodeCommand("login", {
      client_login_name: "bot",
      client_login_password: "pass",
    });
    expect(encoded).toBe(
      "login client_login_name=bot client_login_password=pass\n"
    );
  });

  it("escapes special characters in values", () => {
    expect(escapeValue("hello world")).toBe("hello\\sworld");
    expect(escapeValue("foo|bar")).toBe("foo\\pbar");
    expect(escapeValue("a/b")).toBe("a\\/b");
    expect(escapeValue("line\nnew")).toBe("line\\nnew");
  });

  it("unescapes special characters", () => {
    expect(unescapeValue("hello\\sworld")).toBe("hello world");
    expect(unescapeValue("foo\\pbar")).toBe("foo|bar");
    expect(unescapeValue("a\\/b")).toBe("a/b");
  });

  it("decodes a single response", () => {
    const response =
      "virtualserver_name=My\\sServer virtualserver_port=9987";
    const result = decodeResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0].virtualserver_name).toBe("My Server");
    expect(result[0].virtualserver_port).toBe("9987");
  });

  it("decodes a piped multi-entry response", () => {
    const response =
      "clid=1 client_nickname=User1|clid=2 client_nickname=User2";
    const result = decodeResponse(response);
    expect(result).toHaveLength(2);
    expect(result[0].client_nickname).toBe("User1");
    expect(result[1].client_nickname).toBe("User2");
  });

  it("handles command with no params", () => {
    const encoded = encodeCommand("quit", {});
    expect(encoded).toBe("quit\n");
  });
});

describe("escape/unescape round-trip", () => {
  // Regression: sequential replaceAll could not invert the escaping. `\s` also
  // matched the second character of the escape sequence `\\`, so a value with a
  // backslash was corrupted ("back\slash" -> "back\ lash").
  it("is an exact inverse for backslash-bearing values", () => {
    for (const value of [
      "back\\slash",
      "C:\\new folder",
      "a\\sb",
      "\\\\",
      "\\",
      "\\\\s",
      "prefix\\nbranch",
      "x\\ty",
      "pipe|and space and/slash",
      "trailing\\",
    ]) {
      expect(unescapeValue(escapeValue(value))).toBe(value);
    }
  });

  it("keeps an escaped backslash opaque instead of letting it start a code", () => {
    // "\\\\s" in TS source is the 3-char sequence \ \ s: an escaped backslash
    // followed by a literal "s", i.e. the value `\s`. It must NOT become " ".
    expect(unescapeValue("\\\\s")).toBe("\\s");
    expect(unescapeValue("\\\\n")).toBe("\\n");
    expect(unescapeValue("\\\\p")).toBe("\\p");
  });

  it("still decodes every real escape code", () => {
    expect(unescapeValue("a\\sb")).toBe("a b");
    expect(unescapeValue("a\\pb")).toBe("a|b");
    expect(unescapeValue("a\\/b")).toBe("a/b");
    expect(unescapeValue("a\\nb")).toBe("a\nb");
    expect(unescapeValue("a\\rb")).toBe("a\rb");
    expect(unescapeValue("a\\tb")).toBe("a\tb");
    expect(unescapeValue("\\\\")).toBe("\\");
  });

  it("passes values through unchanged when there is no escape character", () => {
    expect(unescapeValue("plain value")).toBe("plain value");
    expect(unescapeValue("")).toBe("");
  });

  it("leaves a trailing lone backslash alone", () => {
    expect(unescapeValue("abc\\")).toBe("abc\\");
  });
});
