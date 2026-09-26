import { describe, expect, it } from "vitest";
import { GitError, redactCredentials, runGit } from "../../src/git/run-git.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();

describe("runGit", () => {
  it("passes arguments literally rather than through a shell", async () => {
    const dir = await tempDir();
    const hostile = `a b; echo injected && echo $(whoami) %PATH% "quoted" \`tick\` | more`;
    // --sq-quote echoes its argument back, shell-quoted, exactly as Git received it.
    const echoed = await runGit(["rev-parse", "--sq-quote", hostile], {
      cwd: dir,
    });
    expect(echoed.trim()).toBe(`'${hostile}'`);
  });

  it("writes input to standard input", async () => {
    const dir = await tempDir();
    const oid = await runGit(["hash-object", "--stdin"], {
      cwd: dir,
      input: "hello\n",
    });
    // Well-known SHA-1 blob ID for "hello\n".
    expect(oid.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("rejects output beyond the configured limit", async () => {
    const dir = await tempDir();
    await expect(
      runGit(["--help"], { cwd: dir, maxOutputBytes: 16 }),
    ).rejects.toThrow(/output limit/);
  });

  it("reports failures with a sanitized diagnostic", async () => {
    const dir = await tempDir();
    const error = await runGit(["rev-parse", "--verify", "does-not-exist"], {
      cwd: dir,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toMatch(
      /^git rev-parse exited with code \d+/,
    );
  });
});

describe("redactCredentials", () => {
  it("removes URL userinfo", () => {
    expect(
      redactCredentials(
        "fatal: https://fern:hunter2@example.invalid/r.git not found",
      ),
    ).toBe("fatal: https://***@example.invalid/r.git not found");
  });

  it("leaves credential-free URLs and scp-style remotes alone", () => {
    const text = "https://example.invalid/r.git and git@example.invalid:r.git";
    expect(redactCredentials(text)).toBe(text);
  });
});
