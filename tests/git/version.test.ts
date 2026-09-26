import { describe, expect, it } from "vitest";
import {
  detectGitVersion,
  isSupportedGitVersion,
  parseGitVersion,
} from "../../src/git/version.ts";

describe("parseGitVersion", () => {
  it.each([
    ["git version 2.55.0.windows.3", [2, 55, 0]],
    ["git version 2.39.5 (Apple Git-154)", [2, 39, 5]],
    ["git version 2.43.0\n", [2, 43, 0]],
    ["git version 3.0", [3, 0, 0]],
  ])("parses %j", (output, [major, minor, patch]) => {
    expect(parseGitVersion(output)).toMatchObject({ major, minor, patch });
  });

  it("rejects unrecognized output", () => {
    expect(() => parseGitVersion("hub version 2.14.2")).toThrow(/Unrecognized/);
  });
});

describe("isSupportedGitVersion", () => {
  it.each([
    ["git version 2.35.8", false],
    ["git version 2.36.0", true],
    ["git version 2.40.1", true],
    ["git version 1.99.9", false],
    ["git version 3.0.0", true],
  ])("%s -> %s", (output, supported) => {
    expect(isSupportedGitVersion(parseGitVersion(output))).toBe(supported);
  });
});

describe("installed Git", () => {
  it("meets the minimum supported version", async () => {
    const version = await detectGitVersion(process.cwd());
    expect(isSupportedGitVersion(version), version.raw).toBe(true);
  });
});
