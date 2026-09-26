import { spawn } from "node:child_process";

export interface RunGitOptions {
  /** Working directory for the Git process. Always explicit; never inherited. */
  cwd: string;
  /** Text written to Git's standard input, which is then closed. */
  input?: string;
  /** Extra environment variables layered over the current process environment. */
  env?: Readonly<Record<string, string>>;
  /** Kill Git and reject after this many milliseconds. */
  timeoutMs?: number;
  /** Kill Git and reject once standard output exceeds this many bytes. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 2_000;

/**
 * Background reads must never wait on a credential prompt. These are applied
 * last so a caller cannot accidentally re-enable interactive prompting.
 */
const NONINTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
} as const;

export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  /** Standard error, with credentials redacted and length bounded. */
  readonly stderr: string;

  constructor(
    message: string,
    args: readonly string[],
    exitCode: number | null,
    stderr: string,
  ) {
    super(message);
    this.name = "GitError";
    this.args = args.map(redactCredentials);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Replace `user:secret@` style URL userinfo so it cannot reach logs or the UI. */
export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

function sanitizeDiagnostic(text: string): string {
  const redacted = redactCredentials(text.trim());
  return redacted.length > MAX_DIAGNOSTIC_CHARS
    ? `${redacted.slice(0, MAX_DIAGNOSTIC_CHARS)}…`
    : redacted;
}

/**
 * Run the installed Git CLI with an argument array (never through a shell)
 * and resolve with its standard output decoded as UTF-8.
 */
export async function runGit(
  args: readonly string[],
  options: RunGitOptions,
): Promise<string> {
  return (await runGitRaw(args, options)).toString("utf8");
}

/** Like {@link runGit}, but resolve with raw bytes for length-framed output. */
export function runGitRaw(
  args: readonly string[],
  options: RunGitOptions,
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const describe = `git ${args[0] ?? ""}`.trim();

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, ...NONINTERACTIVE_ENV },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: GitError | undefined;

    const fail = (message: string): void => {
      failure ??= new GitError(message, args, null, "");
      child.kill();
    };

    const timer = setTimeout(() => {
      fail(`${describe} timed out after ${String(timeoutMs)} ms`);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(
          `${describe} exceeded the ${String(maxOutputBytes)} byte output limit`,
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep only enough standard error for a diagnostic.
      if (stderrBytes < MAX_DIAGNOSTIC_CHARS * 4) {
        stderr.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        failure ??
          new GitError(
            `${describe} could not run: ${error.message}`,
            args,
            null,
            "",
          ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      const diagnostic = sanitizeDiagnostic(
        Buffer.concat(stderr).toString("utf8"),
      );
      if (code !== 0) {
        const detail = diagnostic ? `: ${diagnostic}` : "";
        reject(
          new GitError(
            `${describe} exited with code ${String(code)}${detail}`,
            args,
            code,
            diagnostic,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout));
    });

    // Git may exit before consuming its input; that is reported via "close".
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}
