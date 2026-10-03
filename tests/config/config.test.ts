import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  checkRemoteUrl,
  formatConfigError,
  parseConfig,
  validateConfig,
} from "../../src/config/config.ts";
import {
  JsonSyntaxError,
  parseJsonWithPositions,
} from "../../src/config/json-positions.ts";
import { seededRandom } from "../oracle/random-dag.ts";

const root = resolve(import.meta.dirname, "../..");
const schema = JSON.parse(
  readFileSync(join(root, "git-flower-garden.schema.json"), "utf8"),
) as object;
const exampleText = readFileSync(
  join(root, "git-flower-garden.example.json"),
  "utf8",
);
const example = JSON.parse(exampleText) as Record<string, unknown>;
// strictRequired is an Ajv lint that rejects `required` inside `not`; the schema is valid JSON Schema.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
const schemaValid = ajv.compile(schema);
const dir = resolve("/configs/home");

describe("parseJsonWithPositions", () => {
  it("matches JSON.parse on 500 random documents and locates every value", () => {
    const random = seededRandom(11);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(random() * xs.length)] as T;
    const gen = (depth: number): unknown => {
      const r = random();
      if (depth > 3 || r < 0.35) {
        return pick<unknown>([
          null,
          true,
          false,
          0,
          -12.5e3,
          1e-7,
          Math.floor(random() * 1e9),
          "",
          "plain",
          'quote " and \\ backslash',
          "tab\tnewline\nnul\u0000 unicode ✿ 🌻  ",
        ]);
      }
      if (r < 0.65)
        return Array.from({ length: Math.floor(random() * 4) }, () =>
          gen(depth + 1),
        );
      const obj: Record<string, unknown> = {};
      for (let k = 0; k < Math.floor(random() * 4); k++)
        obj[pick(["a", "b/c", "~tilde", "é", "", `k${String(k)}`])] = gen(
          depth + 1,
        );
      return obj;
    };
    for (let n = 0; n < 500; n++) {
      const value = gen(0);
      const text = JSON.stringify(value, null, pick([0, 1, 2, "\t"]));
      const parsed = parseJsonWithPositions(text);
      expect(parsed.value).toEqual(JSON.parse(text));
      // Every recorded position points at the start of a value or a member key.
      const lines = text.split("\n");
      for (const [pointer, pos] of parsed.positions) {
        const ch = lines[pos.line - 1]?.[pos.column - 1];
        expect(ch, `${pointer} in ${text}`).toMatch(/["{[\-0-9tfn]/);
      }
    }
  });

  it("rejects exactly what JSON.parse rejects on 500 random corruptions", () => {
    const random = seededRandom(5);
    const junk = [
      "",
      ",",
      "}",
      "]",
      ":",
      '"',
      "\\",
      "x",
      "01",
      "tru",
      "\u0001",
      "{",
      "-",
    ];
    for (let n = 0; n < 500; n++) {
      const cut = Math.floor(random() * exampleText.length);
      const text =
        exampleText.slice(0, cut) +
        (junk[n % junk.length] as string) +
        exampleText.slice(cut + (n % 3));
      let native = true;
      try {
        JSON.parse(text);
      } catch {
        native = false;
      }
      let ours = true;
      try {
        parseJsonWithPositions(text);
      } catch (error) {
        expect(error).toBeInstanceOf(JsonSyntaxError);
        ours = false;
      }
      // Duplicate keys are the one deliberate difference (we reject them).
      if (ours !== native) expect(native && !ours).toBe(true);
      if (native && !ours)
        expect(() => parseJsonWithPositions(text)).toThrow(/Duplicate key/);
    }
  });

  it("reports positions of syntax errors and duplicate keys", () => {
    expect(() => parseJsonWithPositions('{\n  "a": 1,\n  "a": 2\n}')).toThrow(
      /Duplicate key "a" at line 3, column 3/,
    );
    expect(() => parseJsonWithPositions('{\n  "a": tru\n}')).toThrow(
      /line 2, column 8/,
    );
  });
});

describe("example configuration", () => {
  it("is valid for both the schema and the validator", () => {
    expect(schemaValid(example), JSON.stringify(schemaValid.errors)).toBe(true);
    const result = parseConfig(exampleText, dir);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.config.repositories[0]?.path).toBe(dir);
    expect(result.config.repositories[1]).toEqual({
      id: "another-project",
      label: "Another project",
      url: "https://github.com/OWNER/REPOSITORY.git",
      remotes: [],
      github: "OWNER/REPOSITORY",
    });
  });

  it("fills documented defaults for a minimal file", () => {
    const result = parseConfig('{"version": 1, "repositories": []}', dir);
    expect(result).toMatchObject({
      ok: true,
      config: {
        server: { host: "127.0.0.1", port: 4783 },
        history: {
          businessDays: 2,
          weekdays: ["mon", "tue", "wed", "thu", "fri"],
          maxRecentCommits: null,
        },
        monitor: {
          localReconcileSeconds: 5,
          remotePollSeconds: 60,
          maxConcurrentFetches: 2,
          fetchTimeoutSeconds: 120,
        },
        display: { renderer: "technical", reducedMotion: false },
        repositories: [],
      },
    });
  });
});

describe("validation errors", () => {
  const errorsFor = (text: string) => {
    const result = parseConfig(text, dir);
    return result.ok
      ? []
      : result.errors.map((e) => formatConfigError("c.json", e));
  };

  it("names the failing field with its line and column, and reports all errors at once", () => {
    const text = [
      "{",
      '  "version": 1,',
      '  "server": { "host": "0.0.0.0", "port": 70000 },',
      '  "history": { "timeZone": "Mars/Base", "weekdays": ["mon", "mon", "funday"] },',
      '  "monitor": { "remotePollSeconds": 1 },',
      '  "repositories": [',
      '    { "id": "Bad ID", "path": "a", "url": "https://x.invalid/r.git" },',
      '    { "id": "ok", "url": "https://user:secret@x.invalid/r.git", "remotes": ["origin"] },',
      '    { "id": "ok", "path": "b", "colour": "green" }',
      "  ],",
      '  "extra": true',
      "}",
    ].join("\n");
    expect(errorsFor(text)).toEqual([
      'c.json:11:3: /extra unknown key "extra"; allowed: $schema, version, server, history, monitor, display, repositories, environment, webhooks',
      "c.json:3:15: /server/host must be a loopback address (127.0.0.1, localhost, ::1); serving on a network needs authentication that does not exist yet",
      "c.json:3:34: /server/port must be an integer from 1 to 65535",
      'c.json:4:61: /history/weekdays/1 duplicate weekday "mon"',
      "c.json:4:68: /history/weekdays/2 must be one of sun, mon, tue, wed, thu, fri, sat",
      "c.json:4:16: /history/timeZone must be an IANA time zone such as America/New_York",
      "c.json:5:16: /monitor/remotePollSeconds must be an integer from 10 to 86400",
      "c.json:7:7: /repositories/0/id is required: 1-64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit",
      'c.json:7:5: /repositories/0 must have exactly one of "path" or "url"',
      "c.json:8:19: /repositories/1/url must not contain a password; use a credential helper or SSH agent",
      'c.json:8:65: /repositories/1/remotes applies only to a local "path" repository',
      'c.json:9:32: /repositories/2/colour unknown key "colour"; allowed: id, label, path, url, remotes, github',
      'c.json:9:7: /repositories/2/id duplicate id "ok" (also used by /repositories/1)',
    ]);
  });

  it("requires version and repositories and explains unsupported versions", () => {
    expect(errorsFor("{}")).toEqual([
      "c.json:1:1: /version is required and must be 1",
      "c.json:1:1: /repositories is required (use [] to start with no repositories)",
    ]);
    expect(errorsFor('{"version": 2, "repositories": []}')).toEqual([
      "c.json:1:2: /version unsupported version 2; this git-flower-garden reads version 1",
    ]);
  });

  it("accepts any well-formed renderer id and rejects others", () => {
    const withRenderer = (renderer: unknown) =>
      parseConfig(
        JSON.stringify({ version: 1, repositories: [], display: { renderer } }),
        dir,
      );
    expect(withRenderer("pixel")).toMatchObject({
      ok: true,
      config: { display: { renderer: "pixel" } },
    });
    for (const bad of ["Pixel Art", "9lives", "", 3])
      expect(withRenderer(bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
        errors: [{ pointer: "/display/renderer" }],
      });
  });

  it("reports JSON syntax errors with their location", () => {
    expect(errorsFor('{\n  "version": 1,\n}')).toEqual([
      "c.json:3:1: invalid JSON: Expected a quoted property name",
    ]);
  });

  it("resolves relative paths against the config file's directory, keeping spaces and Unicode", () => {
    const result = parseConfig(
      JSON.stringify({
        version: 1,
        repositories: [{ id: "u", path: "../jardín de rosas" }],
      }),
      dir,
    );
    expect(result.ok && result.config.repositories[0]?.path).toBe(
      resolve(dir, "..", "jardín de rosas"),
    );
  });
});

describe("checkRemoteUrl", () => {
  it.each([
    ["https://github.com/o/r.git", null],
    ["ssh://git@example.invalid:2222/o/r.git", null],
    ["git@github.com:o/r.git", null],
    ["file:///srv/git/r.git", null],
    ["git://example.invalid/r.git", null],
    [
      "ext::sh -c touch% /tmp/pwned",
      "transport helpers (such as ext:: or fd::) are not allowed",
    ],
    ["fd::7", "transport helpers (such as ext:: or fd::) are not allowed"],
    [
      "https://user:pw@example.invalid/r.git",
      "must not contain a password; use a credential helper or SSH agent",
    ],
    [
      "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git",
      "must not contain an access token; use a credential helper or SSH agent",
    ],
    [
      "https://github_pat_11ABC@github.com/o/r.git",
      "must not contain an access token; use a credential helper or SSH agent",
    ],
    [
      "https://oauth2%3Aglpat-secret@gitlab.example.invalid/o/r.git",
      "must not contain an access token; use a credential helper or SSH agent",
    ],
    [
      `https://${"a".repeat(40)}@example.invalid/r.git`,
      "must not contain an access token; use a credential helper or SSH agent",
    ],
    [
      "glpat-abcdef@gitlab.example.invalid:o/r.git",
      "must not contain an access token; use a credential helper or SSH agent",
    ],
    // A plain user name picks the credential helper's account: allowed.
    ["https://octocat@github.com/o/r.git", null],
    ["--upload-pack=touch /tmp/x", "must not start with '-'"],
    [
      "ftp://example.invalid/r.git",
      'scheme "ftp" is not supported; use https, http, ssh, git, file',
    ],
    [
      "https://example.invalid/has space",
      "must not contain whitespace or control characters",
    ],
    [
      "just-a-name",
      "must be a URL (https://, ssh://, git://, file://) or user@host:path",
    ],
  ])("%s", (url, expected) => {
    expect(checkRemoteUrl(url)).toBe(expected);
  });
});

describe("validator agrees with the JSON Schema (Ajv) on structural rules", () => {
  it("on 1,000 random mutations of the example", () => {
    const random = seededRandom(99);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(random() * xs.length)] as T;
    // Replacement values chosen to stay within rules both can express:
    // valid time zones and URLs only, no duplicate ids, no "..", no NUL.
    const values: unknown[] = [
      0,
      1,
      2,
      5,
      9,
      10,
      16,
      17,
      65535,
      65536,
      -1,
      1.5,
      "1",
      true,
      null,
      [],
      {},
      "127.0.0.1",
      "0.0.0.0",
      "::1",
      "localhost",
      "technical",
      "garden",
      "America/New_York",
      "UTC",
      ["mon"],
      [],
      ["mon", "mon"],
      ["sun", "xyz"],
      "origin",
      ["origin", "up/stream"],
      ["bad name"],
      "",
      " ",
      "a",
      "Label",
      "https://example.invalid/r.git",
      "git@example.invalid:o/r.git",
      -90,
      90.5,
      -180,
      181,
      35.6,
      -82.55,
      9001,
    ];
    const paths: (string | number)[][] = [
      ["version"],
      ["server"],
      ["server", "host"],
      ["server", "port"],
      ["history", "businessDays"],
      ["history", "weekdays"],
      ["history", "timeZone"],
      ["history", "maxRecentCommits"],
      ["monitor", "remotePollSeconds"],
      ["monitor", "maxConcurrentFetches"],
      ["display", "renderer"],
      ["display", "reducedMotion"],
      ["environment", "enabled"],
      ["environment", "latitude"],
      ["environment", "longitude"],
      ["environment", "elevationMeters"],
      ["environment", "timeZone"],
      ["environment", "weather"],
      ["environment", "surprise"],
      ["repositories"],
      ["repositories", 0, "id"],
      ["repositories", 0, "label"],
      ["repositories", 0, "path"],
      ["repositories", 0, "url"],
      ["repositories", 0, "remotes"],
      ["repositories", 1, "path"],
      ["repositories", 1, "remotes"],
      ["repositories", 1, "url"],
      ["surprise"],
      ["server", "surprise"],
      ["repositories", 1, "surprise"],
    ];
    let agreedValid = 0;
    let agreedInvalid = 0;
    for (let n = 0; n < 1000; n++) {
      const doc = structuredClone(example);
      for (let m = 0; m < 1 + Math.floor(random() * 3); m++) {
        const path = pick(paths);
        let target: Record<string | number, unknown> | undefined = doc;
        for (const key of path.slice(0, -1)) {
          const next: unknown = target?.[key];
          target =
            typeof next === "object" && next !== null
              ? (next as Record<string | number, unknown>)
              : undefined;
        }
        if (!target) continue;
        const last = path.at(-1) as string | number;
        // Time zones and URLs have semantic rules the schema cannot express
        // (IANA validity, URL safety), so they only receive values whose
        // semantic validity is not in question: valid ones or non-strings.
        const pool =
          last === "timeZone"
            ? ["America/New_York", "UTC", 5, null, ""]
            : last === "url"
              ? [
                  "https://example.invalid/r.git",
                  "git@example.invalid:o/r.git",
                  5,
                  null,
                ]
              : values;
        if (random() < 0.2) Reflect.deleteProperty(target, last);
        else target[last] = structuredClone(pick(pool));
      }
      const repos = doc.repositories;
      // Keep ids unique: duplicate ids are a semantic rule the schema cannot state.
      if (Array.isArray(repos) && repos.length === 2) {
        const [a, b] = repos as Record<string, unknown>[];
        if (a && b && a.id === b.id && typeof a.id === "string")
          b.id = `${a.id}-2`;
      }
      const bySchema = schemaValid(doc);
      const byValidator = validateConfig(doc, dir).ok;
      expect(
        byValidator,
        `${JSON.stringify(doc)}\nschema errors: ${JSON.stringify(schemaValid.errors)}`,
      ).toBe(bySchema);
      if (bySchema) agreedValid++;
      else agreedInvalid++;
    }
    expect(agreedValid).toBeGreaterThan(100);
    expect(agreedInvalid).toBeGreaterThan(100);
  });
});

describe("environment (real-time sky, ADR 0018)", () => {
  const base = { version: 1, repositories: [] };
  const parse = (environment: unknown) =>
    parseConfig(JSON.stringify({ ...base, environment }), dir);

  it("defaults to the sky over Blacksburg, Virginia, in its own time zone", () => {
    const result = parseConfig(
      JSON.stringify({ ...base, history: { timeZone: "Europe/Paris" } }),
      dir,
    );
    expect(result.ok && result.config.environment).toEqual({
      enabled: true,
      place: { latitude: 37.2296, longitude: -80.4139, elevationMeters: 634 },
      timeZone: "America/New_York",
      weather: { enabled: false },
    });
    expect(
      parse({ enabled: false }).ok && parse({ enabled: false }),
    ).toMatchObject({
      config: { environment: { enabled: false } },
    });
  });

  it("needs both coordinates or neither; there is no location lookup", () => {
    const result = parse({ enabled: true, latitude: 35.6 });
    expect(result.ok ? [] : result.errors.map((e) => e.pointer)).toEqual([
      "/environment/longitude",
    ]);
    expect(schemaValid({ ...base, environment: { latitude: 35.6 } })).toBe(
      false,
    );
    expect(schemaValid({ ...base, environment: { enabled: true } })).toBe(true);
    // Switched off, an incomplete place is ignored.
    expect(parse({ enabled: false, latitude: 35.6 }).ok).toBe(true);
    expect(
      schemaValid({ ...base, environment: { enabled: false, latitude: 35.6 } }),
    ).toBe(true);
  });

  it("uses the history time zone unless it names its own", () => {
    const inherits = parseConfig(
      JSON.stringify({
        ...base,
        history: { timeZone: "America/New_York" },
        environment: { enabled: true, latitude: 35.6, longitude: -82.55 },
      }),
      dir,
    );
    expect(inherits.ok && inherits.config.environment).toEqual({
      enabled: true,
      place: { latitude: 35.6, longitude: -82.55, elevationMeters: 0 },
      timeZone: "America/New_York",
      weather: { enabled: false },
    });
    const own = parse({
      enabled: true,
      latitude: -33.87,
      longitude: 151.21,
      elevationMeters: 58,
      timeZone: "Australia/Sydney",
    });
    expect(own.ok && own.config.environment).toMatchObject({
      place: { elevationMeters: 58 },
      timeZone: "Australia/Sydney",
    });
  });

  it("rejects out-of-range coordinates, bad zones, and unknown keys", () => {
    const result = parse({
      enabled: true,
      latitude: 91,
      longitude: "west",
      elevationMeters: 1e6,
      timeZone: "Mars/Olympus",
      surprise: true,
    });
    expect(result.ok ? [] : result.errors.map((e) => e.pointer)).toEqual([
      "/environment/surprise",
      "/environment/latitude",
      "/environment/longitude",
      "/environment/elevationMeters",
      "/environment/timeZone",
    ]);
  });

  it("keeps a place while disabled, without using it", () => {
    const result = parse({ enabled: false, latitude: 10, longitude: 20 });
    expect(result.ok && result.config.environment).toEqual({ enabled: false });
  });

  it("keeps weather off unless asked: it sends the place to the provider (ADR 0020)", () => {
    const off = parse({});
    expect(off.ok && off.config.environment).toMatchObject({
      weather: { enabled: false },
    });
    const on = parse({
      latitude: 35.6,
      longitude: -82.55,
      weather: { enabled: true, contact: " me@example.com " },
    });
    expect(on.ok && on.config.environment).toMatchObject({
      weather: {
        enabled: true,
        provider: "met-norway",
        contact: "me@example.com",
      },
    });
    expect(
      schemaValid({
        ...base,
        environment: { weather: { enabled: true, provider: "met-norway" } },
      }),
    ).toBe(true);
    // The sky off turns the weather off too.
    expect(
      parse({ enabled: false, weather: { enabled: true } }).ok &&
        parse({ enabled: false, weather: { enabled: true } }),
    ).toMatchObject({ config: { environment: { enabled: false } } });
  });

  it("rejects other providers and contacts that cannot be a header", () => {
    const bad = {
      weather: {
        enabled: true,
        provider: "open-meteo",
        contact: "me\r\nX-Evil: 1",
        apiKey: "k",
      },
    };
    const result = parse(bad);
    expect(result.ok ? [] : result.errors.map((e) => e.pointer)).toEqual([
      "/environment/weather/apiKey",
      "/environment/weather/provider",
      "/environment/weather/contact",
    ]);
    expect(schemaValid({ ...base, environment: bad })).toBe(false);
    expect(
      schemaValid({
        ...base,
        environment: { weather: { contact: "me\r\nX-Evil: 1" } },
      }),
    ).toBe(false);
    expect(parse({ weather: "met-norway" }).ok).toBe(false);
  });
});

describe("webhooks and GitHub mapping (P1-F)", () => {
  it("defaults to off, validates settings, and never accepts a secret value", () => {
    const base = { version: 1, repositories: [] };
    const off = parseConfig(JSON.stringify(base), dir);
    expect(off.ok && off.config.webhooks).toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: 4785,
      secretEnv: "GIT_FLOWER_GARDEN_WEBHOOK_SECRET",
      safetyPollSeconds: 300,
    });
    const bad = parseConfig(
      JSON.stringify({
        ...base,
        webhooks: {
          enabled: true,
          host: "0.0.0.0",
          secretEnv: "hunter2 secret!",
          safetyPollSeconds: 5,
          secret: "x",
        },
      }),
      dir,
    );
    expect(bad.ok ? [] : bad.errors.map((e) => e.pointer)).toEqual([
      "/webhooks/secret",
      "/webhooks/host",
      "/webhooks/secretEnv",
      "/webhooks/safetyPollSeconds",
    ]);
  });

  it("maps repositories to GitHub explicitly or from github.com URLs", () => {
    const result = parseConfig(
      JSON.stringify({
        version: 1,
        repositories: [
          { id: "a", url: "git@github.com:octo/garden.git" },
          { id: "b", url: "https://gitlab.example/octo/garden.git" },
          { id: "c", path: ".", github: "octo/local" },
          { id: "d", path: ".", github: "not a repo" },
        ],
      }),
      dir,
    );
    expect(result.ok ? [] : result.errors.map((e) => e.pointer)).toEqual([
      "/repositories/3/github",
    ]);
    const ok = parseConfig(
      JSON.stringify({
        version: 1,
        repositories: [
          { id: "a", url: "git@github.com:octo/garden.git" },
          { id: "b", url: "https://gitlab.example/octo/garden.git" },
          { id: "c", path: ".", github: "octo/local" },
        ],
      }),
      dir,
    );
    expect(ok.ok && ok.config.repositories.map((r) => r.github)).toEqual([
      "octo/garden",
      undefined,
      "octo/local",
    ]);
  });
});
