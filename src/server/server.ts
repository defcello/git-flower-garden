/**
 * Loopback-only HTTP service (roadmap sections 5 and 13, ADR 0001).
 *
 * Private commit data must not reach other websites open in the same browser:
 * - Host must name this loopback server exactly (defeats DNS rebinding).
 * - A cross-origin Origin is refused; no CORS headers are ever sent.
 * - Cross-Origin-Resource-Policy: same-origin blocks no-cors embedding.
 * - Only GET and HEAD exist; no request can choose a path, command, or URL.
 * - Static UI files come from a fixed map built at startup, so request paths
 *   never reach the filesystem.
 */
import { readdir, readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative } from "node:path";
import type {
  EnvironmentJson,
  GraphJson,
  GraphNodeJson,
  RepositoriesJson,
  RepositoryStatusJson,
  WeatherJson,
  WebhooksJson,
  WorktreeJson,
} from "../api/types.ts";
import type {
  GraphView,
  RepositoryService,
  RepositoryView,
} from "../monitor/repository-service.ts";
import type { EnvironmentConfig } from "../config/config.ts";
import { escapeXml, renderSvg } from "../render/svg.ts";
import { directorySize } from "../monitor/cache.ts";
import { EventHub } from "./events.ts";

export const API_VERSION = 1;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  // blob: images are the scene's relit sprite atlases, made in the page
  // (ADR 0018); the relighting worker is a same-origin script.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export interface StartedServer {
  server: Server;
  hub: EventHub;
  url: string;
  close(): Promise<void>;
}

export interface ServerOptions {
  /** Built UI directory (dist/ui). Without it, "/" serves the static preview. */
  uiDir?: string | null;
  health?: () => ConfigHealth;
}

/** Hosts a browser may legitimately send for this server. */
export function allowedHosts(port: number): Set<string> {
  const p = String(port);
  return new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extra,
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

export function statusJson(view: RepositoryView): RepositoryStatusJson {
  return {
    id: view.id,
    label: view.label,
    kind: view.kind,
    revision: view.revision,
    status: view.status,
    remote: view.remote,
    counts: view.snapshot
      ? {
          refs: view.snapshot.refs.length,
          worktrees: view.snapshot.worktrees.length,
          reachableCommits: view.snapshot.topology.commits.size,
        }
      : null,
  };
}

/** Configuration problems and restart notices supplied by the app. */
export interface ConfigHealth {
  configErrors: string[];
  restartNeeded: string[];
  notice?: string;
  webhooks?: WebhooksJson;
  /** Weather status (ADR 0020); null or absent when off. */
  weather?: WeatherJson | null;
}

function environmentJson(
  environment: EnvironmentConfig,
  weather: WeatherJson | null,
): EnvironmentJson | null {
  return environment.enabled
    ? { ...environment.place, timeZone: environment.timeZone, weather }
    : null;
}

export function repositoriesJson(
  service: RepositoryService,
  health: ConfigHealth = { configErrors: [], restartNeeded: [] },
): RepositoriesJson {
  return {
    apiVersion: API_VERSION,
    display: {
      timeZone: service.config.history.timeZone,
      businessDays: service.config.history.businessDays,
      reducedMotion: service.config.display.reducedMotion,
      windowStartMs: service.windowStartMs(),
      notice: health.notice ?? null,
      environment: environmentJson(
        service.config.environment,
        health.weather ?? null,
      ),
    },
    repositories: service
      .ids()
      .map((id) => statusJson(service.view(id) as RepositoryView)),
    configErrors: health.configErrors,
    restartNeeded: health.restartNeeded,
    webhooks: health.webhooks ?? {
      state: "off",
      url: null,
      diagnostic: null,
      lastEvent: null,
    },
  };
}

export function graphJson(view: GraphView): GraphJson {
  const { graph, layout } = view;
  const worktreesAt = new Map<string, WorktreeJson[]>();
  for (const w of view.worktrees) {
    if (!w.headOid) continue;
    const list = worktreesAt.get(w.headOid) ?? [];
    list.push({
      path: w.path,
      branch: w.branch,
      detached: w.detached,
      locked: w.locked,
      prunable: w.prunable,
      main: w.main,
    });
    worktreesAt.set(w.headOid, list);
  }
  const signature = (s: {
    name: string;
    email: string;
    time: number;
    timezone: string;
  }) => ({
    name: s.name,
    email: s.email,
    time: s.time,
    timezone: s.timezone,
  });
  const nodes: GraphNodeJson[] = [...layout.nodes.values()].map((n) => {
    const node = graph.nodes.get(n.oid);
    const d = view.details.get(n.oid);
    return {
      oid: n.oid,
      lane: n.lane,
      row: n.row,
      x: n.x,
      y: n.y,
      reasons: node?.reasons ?? [],
      anchorFor: node?.anchorFor ?? [],
      futureDated: node?.futureDated ?? false,
      boundary: node?.boundary ?? false,
      refs: view.labels.get(n.oid) ?? [],
      subject: d?.subject ?? "",
      message: d?.message ?? "",
      parents: d?.parents ?? [],
      author: d ? signature(d.author) : null,
      committer: d ? signature(d.committer) : null,
      worktrees: worktreesAt.get(n.oid) ?? [],
    };
  });
  return {
    id: view.id,
    revision: view.revision,
    window: graph.window,
    reachableCount: graph.reachableCount,
    completeness: view.completeness,
    revealed: view.revealed,
    nodes,
    edges: layout.edges,
    tails: layout.tails,
    size: {
      width: layout.width,
      height: layout.height,
      lanes: layout.lanes,
      rows: layout.rows,
    },
  };
}

const PREVIEW_CSS = `body{margin:0;background:#fbfaf7;color:#1f2a22;font:14px system-ui,sans-serif}
header{padding:12px 20px;border-bottom:1px solid #d9d4c7}h1{font-size:18px;margin:0}
main{display:flex;flex-wrap:wrap;gap:20px;padding:20px}section{background:#fff;border:1px solid #d9d4c7;border-radius:8px;padding:12px;max-width:100%}
h2{font-size:15px;margin:0 0 6px}.status{font-size:12px;color:#4a5a4f;margin-bottom:8px}img{display:block;max-width:calc(100vw - 64px);height:auto}
.empty{padding:40px 20px;max-width:640px}code{background:#eee9dc;padding:1px 4px;border-radius:3px}`;

function previewHtml(service: RepositoryService): string {
  const sections = service.ids().map((id) => {
    const v = service.view(id) as RepositoryView;
    const status = `${v.status.state}${v.status.diagnostic ? ` — ${v.status.diagnostic}` : ""}`;
    const img = v.snapshot
      ? `<img src="/api/repositories/${encodeURIComponent(id)}/graph.svg?rev=${String(v.revision)}" alt="Commit graph of ${escapeXml(v.label)}">`
      : "";
    return `<section><h2>${escapeXml(v.label)}</h2><div class="status">${escapeXml(status)}</div>${img}</section>`;
  });
  const body =
    sections.length > 0
      ? `<main>${sections.join("")}</main>`
      : `<div class="empty"><p>No repositories are configured yet.</p><p>Add entries to <code>repositories</code> in your configuration file, check it with <code>git-flower-garden validate-config</code>, then restart.</p></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>git-flower-garden</title><link rel="stylesheet" href="/preview.css"></head><body><header><h1>git-flower-garden <small>local preview</small></h1></header>${body}</body></html>`;
}

/** Load every file of the built UI into memory, keyed by URL path. */
export async function loadUi(
  uiDir: string,
): Promise<Map<string, { type: string; body: Buffer }> | null> {
  const files = new Map<string, { type: string; body: Buffer }>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const type = MIME[extname(entry.name).toLowerCase()];
        if (type) {
          files.set(`/${relative(uiDir, full).replaceAll("\\", "/")}`, {
            type,
            body: await readFile(full),
          });
        }
      }
    }
  };
  try {
    await walk(uiDir);
  } catch {
    return null;
  }
  return files.has("/index.html") ? files : null;
}

export function createHandler(
  service: RepositoryService,
  port: () => number,
  ui: Map<string, { type: string; body: Buffer }> | null = null,
  hub: EventHub | null = null,
  health: () => ConfigHealth = () => ({ configErrors: [], restartNeeded: [] }),
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? "";
    if (!allowedHosts(port()).has(host.toLowerCase())) {
      sendJson(res, 421, {
        error: "Misdirected request: unexpected Host header",
      });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      sendJson(res, 403, { error: "Cross-origin requests are not allowed" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;
    try {
      if (path === "/" || path === "/index.html") {
        const index = ui?.get("/index.html");
        if (index) send(res, 200, index.type, index.body);
        else send(res, 200, "text/html; charset=utf-8", previewHtml(service));
        return;
      }
      if (path === "/preview") {
        send(res, 200, "text/html; charset=utf-8", previewHtml(service));
        return;
      }
      if (path === "/preview.css") {
        send(res, 200, "text/css; charset=utf-8", PREVIEW_CSS);
        return;
      }
      const asset = ui?.get(path);
      if (asset) {
        send(res, 200, asset.type, asset.body);
        return;
      }
      if (path === "/api/health") {
        sendJson(res, 200, { ok: true, apiVersion: API_VERSION });
        return;
      }
      if (path === "/api/repositories") {
        sendJson(res, 200, repositoriesJson(service, health()));
        return;
      }
      if (path === "/api/diagnostics") {
        const repositories = await Promise.all(
          service.diagnostics().map(async (d) => ({
            ...d,
            cacheBytes: d.cacheDirectory
              ? await directorySize(d.cacheDirectory)
              : null,
          })),
        );
        const memory = process.memoryUsage();
        sendJson(res, 200, {
          apiVersion: API_VERSION,
          process: {
            pid: process.pid,
            node: process.version,
            uptimeSeconds: Math.round(process.uptime()),
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            cpuMicros: process.cpuUsage(),
            eventClients: hub?.size ?? 0,
          },
          cacheRoot: service.cacheDirectory(),
          configErrors: health().configErrors,
          repositories,
        });
        return;
      }
      if (path === "/api/events" && hub) {
        hub.connect(req, res, SECURITY_HEADERS);
        return;
      }
      const match =
        /^\/api\/repositories\/([^/]+)\/(graph|graph\.svg|status|tags)$/.exec(
          path,
        );
      if (match) {
        const id = decodeURIComponent(match[1] as string);
        const view = service.view(id);
        if (!view) {
          sendJson(res, 404, {
            error: `No repository with id ${JSON.stringify(id)}`,
          });
          return;
        }
        if (match[2] === "status") {
          sendJson(res, 200, statusJson(view));
          return;
        }
        if (match[2] === "tags") {
          const tags = service.tags(id, url.searchParams.get("q") ?? "");
          if (!tags) {
            sendJson(res, 503, {
              error: "No snapshot yet",
              status: view.status,
            });
            return;
          }
          sendJson(res, 200, { id, tags });
          return;
        }
        // ?reveal=<oid>[,<oid>…] temporarily shows commits, e.g. an old tag's target.
        const reveal = (url.searchParams.get("reveal") ?? "")
          .split(",")
          .filter((oid) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid))
          .slice(0, 20);
        const graph = await service.graph(id, reveal);
        if (!graph) {
          sendJson(res, 503, { error: "No snapshot yet", status: view.status });
          return;
        }
        if (match[2] === "graph") {
          sendJson(res, 200, graphJson(graph));
        } else {
          const svg = renderSvg(graph.graph, graph.layout, {
            title: `${view.label}: commit graph`,
            refs: graph.labels,
            subjects: new Map(
              [...graph.details].map(([oid, d]) => [oid, d.subject]),
            ),
          });
          // The SVG styles itself inline; scripts stay forbidden.
          send(res, 200, "image/svg+xml; charset=utf-8", svg, {
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'",
          });
        }
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Internal error",
      });
    }
  };
}

export class PortInUseError extends Error {
  constructor(host: string, port: number) {
    super(
      `Port ${String(port)} on ${host} is already in use. Stop the other program, or choose another port with --port or server.port in the configuration.`,
    );
    this.name = "PortInUseError";
  }
}

/** Listen on the configured loopback host. Port 0 picks a free port (tests). */
export async function startServer(
  service: RepositoryService,
  host: string,
  port: number,
  options: ServerOptions = {},
): Promise<StartedServer> {
  const ui = options.uiDir ? await loadUi(options.uiDir) : null;
  let actualPort = port;
  const health =
    options.health ?? (() => ({ configErrors: [], restartNeeded: [] }));
  const hub = new EventHub(() => repositoriesJson(service, health()));
  const unsubscribe = service.subscribe(() => {
    hub.publish();
  });
  const handler = createHandler(service, () => actualPort, ui, hub, health);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE" ? new PortInUseError(host, port) : error,
      );
    });
    server.listen(port, host, () => {
      actualPort = (server.address() as AddressInfo).port;
      const shown = host.includes(":") ? `[${host}]` : host;
      resolve({
        server,
        url: `http://${shown}:${String(actualPort)}/`,
        hub,
        close: () =>
          new Promise<void>((done) => {
            unsubscribe();
            hub.close();
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
