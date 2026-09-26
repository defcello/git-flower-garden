/**
 * The running application: repository service, periodic reconciliation, and
 * the loopback server. Used by `git-garden serve` and the browser tests.
 *
 * Reconciliation re-reads every local source on a timer (roadmap section 5.2).
 * Filesystem watchers, remote polling, and server-sent events arrive in P1-D;
 * until then the UI polls and this timer keeps snapshots current.
 */
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "../config/config.ts";
import {
  RepositoryService,
  type ServiceOptions,
} from "../monitor/repository-service.ts";
import { startServer, type StartedServer } from "./server.ts";

export interface RunningApp {
  service: RepositoryService;
  url: string;
  close(): Promise<void>;
}

export interface AppOptions extends ServiceOptions {
  /** Built UI directory; found automatically when omitted. */
  uiDir?: string | null;
  /** Port override (0 picks a free port). */
  port?: number;
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
  const service = new RepositoryService(config, options);
  await service.refreshAll();
  const uiDir = options.uiDir === undefined ? await findUiDir() : options.uiDir;
  const server: StartedServer = await startServer(
    service,
    config.server.host,
    options.port ?? config.server.port,
    { uiDir },
  );
  const timer = setInterval(() => {
    // Single-flight per repository: a slow read is never started twice.
    void service.refreshAll();
  }, config.monitor.localReconcileSeconds * 1000);
  timer.unref();
  return {
    service,
    url: server.url,
    close: async () => {
      clearInterval(timer);
      await server.close();
    },
  };
}
