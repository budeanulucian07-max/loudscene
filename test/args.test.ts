import { describe, expect, it } from "vitest";
import { parseCli, parseFields, parseFormats, parseLocales, parseTimes, UsageError } from "../src/args.js";
import { maskKey, resolveApiUrl, resolveKey } from "../src/config.js";

describe("parseCli", () => {
  it("parses a create command with every flag", () => {
    const p = parseCli(["create", "--url", "acme.com", "--brief", "We launched v2", "--formats", "9:16,1x1", "--duration", "15", "--wait", "--json"]);
    expect(p.command).toBe("create");
    expect(p.flags).toMatchObject({ url: "acme.com", brief: "We launched v2", formats: ["9:16", "1:1"], duration: 15, wait: true, json: true, render: false });
  });

  it("parses --token for a token's launch film", () => {
    const p = parseCli(["create", "--token", "0xCD291FA4d3e2Eb43e4639625092D31ae10E61111", "--formats", "16:9"]);
    expect(p.flags).toMatchObject({ token: "0xCD291FA4d3e2Eb43e4639625092D31ae10E61111", formats: ["16:9"] });
  });

  it("keeps positionals after the command and accepts -o", () => {
    const p = parseCli(["download", "abc", "-o", "out"]);
    expect(p.positionals).toEqual(["abc"]);
    expect(p.flags.output).toBe("out");
  });

  it("defaults to help and maps -v to version", () => {
    expect(parseCli([]).command).toBe("help");
    expect(parseCli(["-v"]).command).toBe("version");
    expect(parseCli(["status", "--help"]).flags.help).toBe(true);
  });

  it.each([
    [["frobnicate"], /Unknown command/],
    [["create", "--nope"], /nope/],
    [["render", "x", "--formats", "3:2"], /Unknown format/],
    [["render", "x", "--resolution", "999"], /720, 1080 or 2160/],
    [["create", "--duration", "200"], /6 to 90/],
    [["create", "--url", "a.com", "--brand", "b"], /either --url or --brand/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseCli(argv)).toThrow(UsageError);
    expect(() => parseCli(argv)).toThrow(message);
  });

  it("normalises and de-duplicates formats", () => {
    expect(parseFormats("16x9, 9/16,16:9")).toEqual(["16:9", "9:16"]);
  });
});

describe("parseFields", () => {
  it("keeps key=value as text and parses key:=value as JSON", () => {
    expect(parseFields(["headline=Launch day", "price:=29", "dark:=true", 'logo:={"url":"https://x.test/l.png"}', "tagline=a=b"])).toEqual({
      headline: "Launch day",
      price: 29,
      dark: true,
      logo: { url: "https://x.test/l.png" },
      tagline: "a=b",
    });
  });

  it("collects repeated --field flags", () => {
    expect(parseCli(["update", "x", "--field", "a=1", "--field", "b:=2"]).flags.fields).toEqual({ a: "1", b: 2 });
  });

  it.each([["=nokey"], ["novalue"], ["price:=twenty"]])("refuses %s", (pair) => {
    expect(() => parseFields([pair])).toThrow(UsageError);
  });
});

describe("parseTimes", () => {
  it("reads comma-separated seconds", () => {
    expect(parseTimes("0, 4.5,12")).toEqual([0, 4.5, 12]);
  });

  it.each([[""], ["a"], ["-1"], ["601"], [Array.from({ length: 25 }, (_, i) => i).join(",")]])("refuses %j", (raw) => {
    expect(() => parseTimes(raw)).toThrow(UsageError);
  });
});

describe("parseLocales", () => {
  it("reads and de-duplicates language codes", () => {
    expect(parseLocales("de, pt-BR,de")).toEqual(["de", "pt-BR"]);
  });

  it.each([["German"], ["de,es,fr,it"], [""]])("refuses %j", (raw) => {
    expect(() => parseLocales(raw)).toThrow(UsageError);
  });
});

describe("config resolution", () => {
  const KEY = "ls_live_" + "A".repeat(30);
  it("prefers --key, then LOUDSCENE_API_KEY, then the saved key", () => {
    expect(resolveKey("ls_live_flag", { LOUDSCENE_API_KEY: KEY }, { apiKey: "saved" })?.source).toBe("flag");
    expect(resolveKey(undefined, { LOUDSCENE_API_KEY: KEY }, { apiKey: "saved" })).toEqual({ key: KEY, source: "env" });
    expect(resolveKey(undefined, {}, { apiKey: "saved" })?.source).toBe("config");
    expect(resolveKey(undefined, {}, {})).toBeNull();
  });

  it("normalises the server URL", () => {
    expect(resolveApiUrl(undefined, {}, {})).toBe("https://www.loudscene.com");
    expect(resolveApiUrl(undefined, { LOUDSCENE_API_URL: "http://localhost:3000/" }, {})).toBe("http://localhost:3000");
    expect(resolveApiUrl("api.example.com/api/v1", {}, {})).toBe("https://api.example.com");
    expect(resolveApiUrl(undefined, {}, { apiUrl: "https://x.test/api/mcp" })).toBe("https://x.test");
  });

  it("masks keys", () => {
    expect(maskKey("ls_live_abcdEFGHijklMNOPqrst")).toBe("ls_live_abcd…qrst");
    expect(maskKey("nope")).toBe("••••");
  });
});
