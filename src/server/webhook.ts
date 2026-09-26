/**
 * Optional GitHub webhook receiver (roadmap section 5.3, P1-F).
 *
 * A separate listener with one route, POST /github/webhook, meant to sit
 * behind a tunnel or reverse proxy the user runs. It shares nothing with the
 * UI server: no UI, no API, no Git commands. A delivery is only an
 * invalidation hint: after the signature checks out, the named repository is
 * fetched and reconciled like any poll. Payload contents are never used as
 * graph data, so duplicate, reordered, or missed deliveries are harmless.
 *
 * Checks, in order: method and path; body size (streamed, capped); HMAC-SHA256
 * signature over the raw body with a constant-time comparison; JSON; event
 * allowlist; delivery ID (a bounded window of recent IDs drops duplicates).
 * The response is sent before any fetch begins.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export const WEBHOOK_PATH = "/github/webhook";
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const RELEVANT_EVENTS = new Set(["push", "create", "delete"]);
const DEDUP_WINDOW = 1000;

export interface WebhookStats {
  accepted: number;
  duplicates: number;
  rejected: number;
  ignored: number;
  /** Milliseconds since the epoch of the last accepted delivery. */
  lastEventAt: number | null;
}

export interface WebhookReceiver {
  url: string;
  stats(): WebhookStats;
  close(): Promise<void>;
}

export interface WebhookOptions {
  host: string;
  port: number;
  secret: string;
  /** Called with "owner/name" for each accepted push, create, or delete. */
  onInvalidate: (repository: string) => void;
  now?: () => number;
}

/** "sha256=<hex>" for a body, as GitHub sends in X-Hub-Signature-256. */
export function signBody(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function signatureMatches(
  secret: string,
  body: Buffer,
  header: string | undefined,
): boolean {
  if (typeof header !== "string") return false;
  const expected = Buffer.from(signBody(secret, body));
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${message}\n`);
}

export async function startWebhookReceiver(
  options: WebhookOptions,
): Promise<WebhookReceiver> {
  if (options.secret.length < 16)
    throw new Error("The webhook secret must be at least 16 characters.");
  const now = options.now ?? Date.now;
  const stats: WebhookStats = {
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    ignored: 0,
    lastEventAt: null,
  };
  const seen = new Set<string>();

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (new URL(req.url ?? "/", "http://receiver").pathname !== WEBHOOK_PATH) {
      stats.rejected++;
      reply(res, 404, "Not found");
      return;
    }
    if (req.method !== "POST") {
      stats.rejected++;
      res.setHeader("Allow", "POST");
      reply(res, 405, "Method not allowed");
      return;
    }
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > MAX_WEBHOOK_BYTES) {
      stats.rejected++;
      reply(res, 413, "Payload too large");
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BYTES && !aborted) {
        aborted = true;
        stats.rejected++;
        reply(res, 413, "Payload too large");
        req.destroy();
        return;
      }
      if (!aborted) chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const body = Buffer.concat(chunks);
      const signature = req.headers["x-hub-signature-256"];
      if (
        !signatureMatches(
          options.secret,
          body,
          Array.isArray(signature) ? signature[0] : signature,
        )
      ) {
        stats.rejected++;
        reply(res, 401, "Invalid signature");
        return;
      }
      let payload: { repository?: { full_name?: unknown } };
      try {
        payload = JSON.parse(body.toString("utf8")) as typeof payload;
      } catch {
        stats.rejected++;
        reply(res, 400, "Expected a JSON body (content type application/json)");
        return;
      }
      const event = String(req.headers["x-github-event"] ?? "");
      if (event === "ping") {
        stats.ignored++;
        reply(res, 200, "pong");
        return;
      }
      if (!RELEVANT_EVENTS.has(event)) {
        stats.ignored++;
        reply(res, 202, `Ignored event: ${event}`);
        return;
      }
      const delivery = String(req.headers["x-github-delivery"] ?? "");
      if (delivery !== "" && seen.has(delivery)) {
        stats.duplicates++;
        reply(res, 202, "Duplicate delivery");
        return;
      }
      if (delivery !== "") {
        seen.add(delivery);
        if (seen.size > DEDUP_WINDOW)
          seen.delete(seen.values().next().value as string);
      }
      const fullName = payload.repository?.full_name;
      if (typeof fullName !== "string") {
        stats.ignored++;
        reply(res, 202, "No repository in payload");
        return;
      }
      stats.accepted++;
      stats.lastEventAt = now();
      // Acknowledge first; the fetch runs afterwards on the monitor's schedule.
      reply(res, 202, "Accepted");
      options.onInvalidate(fullName);
    });
  };

  const server: Server = createServer(handle);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = options.host.includes(":") ? `[${options.host}]` : options.host;
  return {
    url: `http://${shown}:${String(port)}${WEBHOOK_PATH}`,
    stats: () => ({ ...stats }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
