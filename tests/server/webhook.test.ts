/*
 * P1-F: GitHub push notifications. The receiver is tested against forged,
 * oversized, duplicate, irrelevant, and malformed deliveries; end to end, a
 * signed push makes the monitor fetch at once while polling is effectively
 * off, a missed delivery is still caught by the safety poll, and a missing
 * secret falls back to ordinary polling.
 */
import { request } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/config.ts";
import { buildFixture, fixtureGit } from "../../src/demo/builder.ts";
import { forkMerge } from "../../src/demo/fixtures.ts";
import { startApp, type RunningApp } from "../../src/server/app.ts";
import {
  MAX_WEBHOOK_BYTES,
  signBody,
  startWebhookReceiver,
  type WebhookReceiver,
} from "../../src/server/webhook.ts";
import { useTempDirs } from "../helpers/temp-dir.ts";

const tempDir = useTempDirs();
const SECRET = "correct horse battery staple";

interface Delivery {
  body?: string;
  signature?: string | null;
  event?: string;
  id?: string;
  method?: string;
  path?: string;
}

function deliver(
  url: string,
  d: Delivery = {},
): Promise<{ status: number; text: string }> {
  const body =
    d.body ?? JSON.stringify({ repository: { full_name: "octo/garden" } });
  const target = new URL(url);
  if (d.path) target.pathname = d.path;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: d.method ?? "POST",
        // A fresh connection each time: the receiver closes the socket of an
        // oversized request, which must not affect the next delivery.
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": d.event ?? "push",
          "X-GitHub-Delivery": d.id ?? crypto.randomUUID(),
          ...(d.signature === null
            ? {}
            : { "X-Hub-Signature-256": d.signature ?? signBody(SECRET, body) }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text: text.trim() });
        });
      },
    );
    req.on("error", (error) => {
      // For an oversized body the receiver may close the socket before the
      // client finishes sending; that is the rejection we expect.
      const code = (error as NodeJS.ErrnoException).code;
      if (
        body.length > MAX_WEBHOOK_BYTES &&
        (code === "ECONNRESET" || code === "EPIPE")
      ) {
        resolve({ status: 413, text: "connection closed" });
      } else reject(error);
    });
    req.end(d.method === "GET" ? undefined : body);
  });
}

const receivers: WebhookReceiver[] = [];
const apps: RunningApp[] = [];
afterEach(async () => {
  for (const r of receivers.splice(0)) await r.close();
  for (const a of apps.splice(0)) await a.close();
});

describe("webhook receiver", () => {
  async function receiver() {
    const notified: string[] = [];
    const r = await startWebhookReceiver({
      host: "127.0.0.1",
      port: 0,
      secret: SECRET,
      onInvalidate: (name) => notified.push(name),
    });
    receivers.push(r);
    return { r, notified };
  }

  it("accepts a correctly signed push and reports it", async () => {
    const { r, notified } = await receiver();
    expect(await deliver(r.url)).toEqual({ status: 202, text: "Accepted" });
    expect(notified).toEqual(["octo/garden"]);
    expect(r.stats()).toMatchObject({ accepted: 1, rejected: 0 });
    expect(r.stats().lastEventAt).not.toBeNull();
  });

  it("rejects forged, unsigned, and tampered deliveries without acting", async () => {
    const { r, notified } = await receiver();
    expect(
      (await deliver(r.url, { signature: signBody("wrong secret", "{}") }))
        .status,
    ).toBe(401);
    expect((await deliver(r.url, { signature: null })).status).toBe(401);
    const body = JSON.stringify({ repository: { full_name: "octo/garden" } });
    const tampered = body.replace("garden", "gardem");
    expect(
      (
        await deliver(r.url, {
          body: tampered,
          signature: signBody(SECRET, body),
        })
      ).status,
    ).toBe(401);
    expect((await deliver(r.url, { signature: "sha256=short" })).status).toBe(
      401,
    );
    expect(notified).toEqual([]);
  });

  it("caps body size, and serves only POST on its one path", async () => {
    const { r, notified } = await receiver();
    const huge = JSON.stringify({
      repository: { full_name: "octo/garden" },
      pad: "x".repeat(MAX_WEBHOOK_BYTES),
    });
    expect((await deliver(r.url, { body: huge })).status).toBe(413);
    expect((await deliver(r.url, { method: "GET" })).status).toBe(405);
    expect((await deliver(r.url, { path: "/api/repositories" })).status).toBe(
      404,
    );
    expect((await deliver(r.url, { path: "/" })).status).toBe(404);
    expect(notified).toEqual([]);
  });

  it("drops duplicate deliveries and ignores irrelevant or malformed ones", async () => {
    const { r, notified } = await receiver();
    expect((await deliver(r.url, { id: "d-1" })).status).toBe(202);
    expect(await deliver(r.url, { id: "d-1" })).toEqual({
      status: 202,
      text: "Duplicate delivery",
    });
    expect(await deliver(r.url, { event: "ping" })).toEqual({
      status: 200,
      text: "pong",
    });
    expect((await deliver(r.url, { event: "issues" })).text).toBe(
      "Ignored event: issues",
    );
    expect((await deliver(r.url, { body: "not json" })).status).toBe(400);
    expect((await deliver(r.url, { body: "{}" })).text).toBe(
      "No repository in payload",
    );
    // Reordered and missing deliveries are harmless: each is only a hint.
    expect((await deliver(r.url, { event: "delete", id: "d-0" })).status).toBe(
      202,
    );
    expect(notified).toEqual(["octo/garden", "octo/garden"]);
  });

  it("refuses a short secret", async () => {
    await expect(
      startWebhookReceiver({
        host: "127.0.0.1",
        port: 0,
        secret: "short",
        onInvalidate: () => undefined,
      }),
    ).rejects.toThrow(/at least 16 characters/);
  });
});

describe("push notifications end to end", () => {
  async function setup(options: { secret?: string; safetyPollMs: number }) {
    const root = await tempDir();
    const seed = await buildFixture(forkMerge, join(root, "seed"));
    const server = join(root, "server.git");
    const pusher = join(root, "pusher");
    await fixtureGit(root, ["clone", "--quiet", "--bare", seed.dir, server]);
    await fixtureGit(root, ["clone", "--quiet", server, pusher]);
    const parsed = parseConfig(
      JSON.stringify({
        version: 1,
        history: { timeZone: "America/New_York" },
        webhooks: { enabled: true },
        repositories: [
          {
            id: "garden",
            url: pathToFileURL(server).href,
            github: "octo/garden",
          },
        ],
      }),
      root,
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const app = await startApp(parsed.config, {
      port: 0,
      webhookPort: 0,
      uiDir: null,
      cacheRoot: join(root, "cache"),
      env:
        options.secret === undefined
          ? {}
          : { GIT_GARDEN_WEBHOOK_SECRET: options.secret },
      // Ordinary polling effectively off: an hour.
      intervals: {
        remotePollMs: 3_600_000,
        safetyPollMs: options.safetyPollMs,
      },
    });
    apps.push(app);
    // Wait for the first fetch.
    for (
      let i = 0;
      i < 300 && app.service.view("garden")?.remote?.state !== "ok";
      i++
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const push = async (message: string) => {
      await fixtureGit(pusher, [
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        message,
      ]);
      await fixtureGit(pusher, ["push", "--quiet", "origin", "HEAD:main"]);
      return (await fixtureGit(pusher, ["rev-parse", "HEAD"])).trim();
    };
    const mainOid = async () => {
      const g = await app.service.graph("garden");
      return [...(g?.labels ?? [])].find(([, l]) =>
        l.includes("origin/main"),
      )?.[0];
    };
    return { app, push, mainOid };
  }

  async function waitFor(
    probe: () => Promise<boolean>,
    timeoutMs: number,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await probe()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it("a signed push notification triggers an immediate fetch", async () => {
    const { app, push, mainOid } = await setup({
      secret: SECRET,
      safetyPollMs: 3_600_000,
    });
    const health = app.health().webhooks;
    expect(health?.state).toBe("listening");
    const url = health?.url as string;
    const pushed = await push("Notified change");
    // Nothing polls within the next hour, so only the notification can explain an update.
    expect(await waitFor(async () => (await mainOid()) === pushed, 1500)).toBe(
      false,
    );
    const started = Date.now();
    expect((await deliver(url)).status).toBe(202);
    expect(
      await waitFor(async () => (await mainOid()) === pushed, 15_000),
    ).toBe(true);
    const latency = Date.now() - started;
    expect(latency).toBeLessThan(15_000);
    expect(app.service.view("garden")?.remote?.lastEvent).not.toBeNull();
    // Notifications for other repositories change nothing.
    expect(app.service.notifyGithub("someone/else")).toEqual([]);
  });

  it("the safety poll catches a missed delivery", async () => {
    const { push, mainOid } = await setup({
      secret: SECRET,
      safetyPollMs: 500,
    });
    const pushed = await push("Delivery lost in transit");
    expect(
      await waitFor(async () => (await mainOid()) === pushed, 20_000),
    ).toBe(true);
  });

  it("without a secret, reports why and keeps ordinary polling", async () => {
    const { app } = await setup({ safetyPollMs: 500 });
    expect(app.health().webhooks).toMatchObject({
      state: "error",
      diagnostic: expect.stringMatching(
        /GIT_GARDEN_WEBHOOK_SECRET is not set; remotes are polled instead/,
      ) as unknown,
    });
  });
});
