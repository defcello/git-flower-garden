/**
 * Server-sent events for live updates (roadmap section 5.2).
 *
 * Every message is the complete repository status list, so a client that
 * connects, reconnects, or misses messages is fully resynchronized by the next
 * one; nothing depends on replaying history. Clients fetch a graph when its
 * revision (or the history window) changes. Bursts are coalesced, idle
 * connections get a heartbeat, and a client that stops reading is dropped
 * rather than buffered without bound (it reconnects and resyncs).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RepositoriesJson } from "../api/types.ts";

export const MAX_BUFFERED_BYTES = 256 * 1024;
const HEARTBEAT_MS = 20_000;
const COALESCE_MS = 100;

export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private sequence = 0;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly snapshot: () => RepositoriesJson;

  constructor(snapshot: () => RepositoriesJson) {
    this.snapshot = snapshot;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) this.write(client, ": heartbeat\n\n");
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Take over an HTTP response as an event stream. */
  connect(
    req: IncomingMessage,
    res: ServerResponse,
    headers: Record<string, string>,
  ): void {
    res.writeHead(200, {
      ...headers,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.clients.add(res);
    const remove = () => {
      this.clients.delete(res);
    };
    req.on("close", remove);
    res.on("close", remove);
    // Reconnect quickly after the service restarts; resync with the full state now.
    this.write(res, `retry: 2000\n${this.message()}`);
  }

  /** Coalesce bursts of changes into one message. */
  publish(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      const message = this.message();
      for (const client of this.clients) this.write(client, message);
    }, COALESCE_MS);
    this.pending.unref();
  }

  close(): void {
    clearInterval(this.heartbeat);
    if (this.pending) clearTimeout(this.pending);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private message(): string {
    this.sequence++;
    return `id: ${String(this.sequence)}\nevent: repositories\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
  }

  private write(client: ServerResponse, text: string): void {
    if (client.writableLength > MAX_BUFFERED_BYTES) {
      // The client is not reading. Drop it; it will reconnect and resync.
      this.clients.delete(client);
      client.destroy();
      return;
    }
    client.write(text);
  }
}
