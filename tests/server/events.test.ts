import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoriesJson } from "../../src/api/types.ts";
import { EventHub, MAX_BUFFERED_BYTES } from "../../src/server/events.ts";

/** A minimal stand-in for an HTTP response that records writes. */
class FakeResponse extends EventEmitter {
  written: string[] = [];
  writableLength = 0;
  destroyed = false;
  ended = false;
  writeHead(): this {
    return this;
  }
  write(text: string): boolean {
    this.written.push(text);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

let revision = 1;
const payload = (): RepositoriesJson => ({
  apiVersion: 1,
  display: {
    timeZone: "UTC",
    businessDays: 2,
    reducedMotion: false,
    windowStartMs: 0,
  },
  repositories: [
    {
      id: "a",
      label: "A",
      kind: "local",
      revision,
      status: {
        state: "ready",
        lastAttempt: 0,
        lastSuccess: 0,
        diagnostic: null,
      },
      remote: null,
      counts: null,
    },
  ],
  configErrors: [],
  restartNeeded: [],
});

const hubs: EventHub[] = [];
function connect(hub: EventHub): FakeResponse {
  const res = new FakeResponse();
  hub.connect(
    new EventEmitter() as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    {},
  );
  return res;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

describe("EventHub", () => {
  it("sends the complete state immediately on connect (full resync)", () => {
    const hub = new EventHub(payload);
    hubs.push(hub);
    const res = connect(hub);
    expect(res.written).toHaveLength(1);
    expect(res.written[0]).toMatch(
      /^retry: 2000\nid: 1\nevent: repositories\ndata: \{/,
    );
    const data = JSON.parse(
      (res.written[0] as string).split("data: ")[1] as string,
    ) as RepositoriesJson;
    expect(data.repositories[0]?.revision).toBe(1);
  });

  it("coalesces a burst of changes into one message with the latest state", async () => {
    const hub = new EventHub(payload);
    hubs.push(hub);
    const res = connect(hub);
    for (let i = 0; i < 10; i++) {
      revision++;
      hub.publish();
    }
    await wait(250);
    expect(res.written).toHaveLength(2);
    expect(res.written[1]).toContain(`"revision":${String(revision)}`);
  });

  it("drops a client that stops reading instead of buffering without bound", async () => {
    const hub = new EventHub(payload);
    hubs.push(hub);
    const slow = connect(hub);
    const fast = connect(hub);
    slow.writableLength = MAX_BUFFERED_BYTES + 1;
    hub.publish();
    await wait(250);
    expect(slow.destroyed).toBe(true);
    expect(hub.size).toBe(1);
    expect(fast.written).toHaveLength(2);
  });

  it("forgets clients that disconnect", () => {
    const hub = new EventHub(payload);
    hubs.push(hub);
    const res = connect(hub);
    expect(hub.size).toBe(1);
    res.emit("close");
    expect(hub.size).toBe(0);
  });
});
