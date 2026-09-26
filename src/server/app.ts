/**
 * The running application: continuous monitoring, configuration reload, and
 * the loopback server. Used by `git-garden serve` and the browser tests.
 *
 * Configuration changes are validated before anything is applied (roadmap
 * section 5.2): an invalid edit keeps the last valid configuration and shows
 * its problems in the UI; a valid one is applied without restarting
 * unaffected repositories. Server address changes need a restart and say so.
 */
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  formatConfigError,
  parseConfig,
  type Config,
} from "../config/config.ts";
import {
  RepositoryService,
  type ServiceOptions,
} from "../monitor/repository-service.ts";
import type { WebhooksJson } from "../api/types.ts";
import {
  startServer,
  type ConfigHealth,
  type StartedServer,
} from "./server.ts";
import { startWebhookReceiver, type WebhookReceiver } from "./webhook.ts";

export interface RunningApp {
  service: RepositoryService;
  url: string;
  /** Re-read the configuration file now (also runs on file changes). */
  reloadConfig(): Promise<void>;
  health(): ConfigHealth;
  close(): Promise<void>;
}

export interface AppOptions extends ServiceOptions {
  /** Built UI directory; found automatically when omitted. */
  uiDir?: string | null;
  /** Port override (0 picks a free port). */
  port?: number;
  /** Configuration file to watch for changes. */
  configPath?: string;
  /** How often to re-check the configuration file (a backstop for watch events). */
  configPollMs?: number;
  /** Shown on every page (demo mode). */
  notice?: string;
  /** Environment to read the webhook secret from (tests). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Webhook receiver port override (0 picks a free port). */
  webhookPort?: number;
  /** Wait until every repository has been read once before listening (default true). */
  waitForFirstRead?: boolean;
}

/** dist/ui next to the running code, whether it runs from src/ or dist/. */
export async function findUiDir(): Promise<string | null> {
  const here = dirname(import.meta.filename);
  const candidates = [resolve(here, "../../dist/ui"), resolve(here, "../ui")];
  for (const dir of candidates) {
    try {
      await access(resolve(dir, "index.html"));
      return dir;
    } catch {
      // try the next location
    }
  }
  return null;
}

export async function startApp(
  config: Config,
  options: AppOptions = {},
): Promise<RunningApp> {
  const service = new RepositoryService(config, {
    background: true,
    ...options,
  });
  // Progressive startup: listen first so the page appears at once, with each
  // repository filling in as it is read. Tests can wait for the first reads.
  const starting = service.start();
  if (options.waitForFirstRead ?? true) await starting;
  else void starting;
  const uiDir = options.uiDir === undefined ? await findUiDir() : options.uiDir;
  let health: ConfigHealth = {
    configErrors: [],
    restartNeeded: [],
    ...(options.notice === undefined ? {} : { notice: options.notice }),
  };
  const listen = {
    host: config.server.host,
    port: options.port ?? config.server.port,
  };
  // Optional GitHub push notifications on their own isolated listener.
  let receiver: WebhookReceiver | null = null;
  let webhookProblem: string | null = null;
  const webhookStatus = (): WebhooksJson => {
    if (!config.webhooks.enabled)
      return { state: "off", url: null, diagnostic: null, lastEvent: null };
    if (!receiver)
      return {
        state: "error",
        url: null,
        diagnostic: webhookProblem,
        lastEvent: null,
      };
    return {
      state: "listening",
      url: receiver.url,
      diagnostic: null,
      lastEvent: receiver.stats().lastEventAt,
    };
  };
  if (config.webhooks.enabled) {
    const secret = (options.env ?? process.env)[config.webhooks.secretEnv];
    if (!secret) {
      webhookProblem = `Push notifications are enabled, but the environment variable ${config.webhooks.secretEnv} is not set; remotes are polled instead.`;
    } else {
      try {
        receiver = await startWebhookReceiver({
          host: config.webhooks.host,
          port: options.webhookPort ?? config.webhooks.port,
          secret,
          onInvalidate: (repository) => {
            service.notifyGithub(repository);
          },
        });
        service.setWebhooksActive(true);
      } catch (error) {
        webhookProblem = `The push-notification receiver could not start (${error instanceof Error ? error.message : String(error)}); remotes are polled instead.`;
      }
    }
  }
  const server: StartedServer = await startServer(
    service,
    listen.host,
    listen.port,
    {
      uiDir,
      health: () => ({ ...health, webhooks: webhookStatus() }),
    },
  );

  const configPath = options.configPath;
  let lastHash: string | null = null;
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  if (configPath) {
    lastHash = hash(await readFile(configPath, "utf8").catch(() => ""));
  }

  let reloading: Promise<void> | null = null;
  const reloadConfig = (): Promise<void> => {
    reloading ??= (async () => {
      try {
        if (!configPath) return;
        let text: string;
        try {
          text = await readFile(configPath, "utf8");
        } catch (error) {
          // Editors often replace files atomically; a missing file is transient.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        const h = hash(text);
        if (h === lastHash) return;
        lastHash = h;
        const result = parseConfig(text, dirname(configPath));
        if (!result.ok) {
          health = {
            ...health,
            configErrors: result.errors.map((e) =>
              formatConfigError(basename(configPath), e),
            ),
          };
          server.hub.publish();
          return;
        }
        const next = result.config;
        const restartNeeded: string[] = [];
        if (next.server.host !== listen.host) restartNeeded.push("server.host");
        if (options.port === undefined && next.server.port !== listen.port)
          restartNeeded.push("server.port");
        if (JSON.stringify(next.webhooks) !== JSON.stringify(config.webhooks))
          restartNeeded.push("webhooks");
        health = { ...health, configErrors: [], restartNeeded };
        await service.applyConfig(next);
        server.hub.publish();
      } finally {
        reloading = null;
      }
    })();
    return reloading;
  };

  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  if (configPath) {
    try {
      // Watch the directory: atomic saves replace the file itself.
      watcher = watch(
        dirname(configPath),
        { persistent: false },
        (_event, file) => {
          if (file !== null && file !== basename(configPath)) return;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void reloadConfig(), 200);
        },
      );
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
    poll = setInterval(() => void reloadConfig(), options.configPollMs ?? 5000);
    poll.unref();
  }

  return {
    service,
    url: server.url,
    reloadConfig,
    health: () => ({ ...health, webhooks: webhookStatus() }),
    close: async () => {
      watcher?.close();
      if (debounce) clearTimeout(debounce);
      if (poll) clearInterval(poll);
      service.stop();
      await receiver?.close();
      await server.close();
    },
  };
}
