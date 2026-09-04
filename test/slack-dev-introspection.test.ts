import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installDevIntrospection, type DevIntrospection } from "../src/slack/dev-introspection.ts";

interface FakeApp {
  receiver: { client: EventEmitter };
  deletions: Array<{ channel: string; ts: string }>;
  client: {
    chat: {
      postMessage: (args: { channel: string; text: string }) => Promise<unknown>;
      delete: (args: { channel: string; ts: string }) => Promise<unknown>;
    };
  };
}

function makeApp(onPost?: (args: { channel: string; text: string }) => Promise<unknown>): FakeApp {
  const deletions: Array<{ channel: string; ts: string }> = [];
  return {
    receiver: { client: new EventEmitter() },
    deletions,
    client: {
      chat: {
        postMessage: onPost ?? (async () => ({ ok: true, ts: "111.222" })),
        delete: async (args: { channel: string; ts: string }) => {
          deletions.push(args);
          return { ok: true };
        },
      },
    },
  };
}

function emitFrame(app: FakeApp, frame: unknown): void {
  app.receiver.client.emit("ws_message", JSON.stringify(frame));
}

async function withIntrospection(app: FakeApp, fn: (dev: DevIntrospection) => Promise<void>): Promise<void> {
  const dev = installDevIntrospection(app, { enabled: true, port: 0 });
  try {
    assert.ok(dev);
    await fn(dev);
  } finally {
    await dev?.close();
  }
}

test("disabled unless opted in", () => {
  assert.equal(installDevIntrospection(makeApp()), null);
});

test("hello frame records num_connections and host", async () => {
  const app = makeApp();
  await withIntrospection(app, async (dev) => {
    emitFrame(app, { type: "hello", num_connections: 2, debug_info: { host: "wss-x.slack.com" } });
    assert.equal(dev.state.numConnections, 2);
    assert.equal(dev.state.helloHost, "wss-x.slack.com");
    assert.ok(dev.state.lastHelloAt);
    assert.equal(dev.state.lastEventAtRaw, null);
  });
});

test("non-hello frames stamp lastEventAtRaw", async () => {
  const app = makeApp();
  await withIntrospection(app, async (dev) => {
    emitFrame(app, { type: "events_api", payload: { event: { type: "message", text: "hi" } } });
    assert.ok(dev.state.lastEventAtRaw);
  });
});

test("canary resolves when its envelope arrives over the socket", async () => {
  const app = makeApp(async ({ text }) => {
    setTimeout(() => emitFrame(app, { type: "events_api", payload: { event: { type: "message", text } } }), 20);
    return { ok: true };
  });
  await withIntrospection(app, async (dev) => {
    const result = await dev.canary("C123", 5_000);
    assert.equal(result.ok, true);
    assert.ok(typeof result.rttMs === "number" && result.rttMs >= 0);
    assert.equal(dev.state.lastCanary?.ok, true);
  });
});

test("canary times out as posted-not-received when the socket stays silent", async () => {
  const app = makeApp();
  await withIntrospection(app, async (dev) => {
    const result = await dev.canary("C123", 50);
    assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "posted-not-received" });
    assert.equal(dev.state.lastCanary?.ok, false);
  });
});

test("canary reports post failure", async () => {
  const app = makeApp(async () => {
    throw new Error("channel_not_found");
  });
  await withIntrospection(app, async (dev) => {
    const result = await dev.canary("C404", 1_000);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /channel_not_found/);
  });
});

test("canary without a channel fails without posting", async () => {
  let posted = false;
  const app = makeApp(async () => {
    posted = true;
    return { ok: true };
  });
  await withIntrospection(app, async (dev) => {
    const result = await dev.canary("", 1_000);
    assert.equal(result.ok, false);
    assert.equal(posted, false);
  });
});

test("healthz serves state over HTTP; POST /canary round-trips", async () => {
  const app = makeApp(async ({ text }) => {
    setTimeout(() => emitFrame(app, { type: "events_api", payload: { event: { type: "message", text } } }), 10);
    return { ok: true };
  });
  await withIntrospection(app, async (dev) => {
    await new Promise((r) => setTimeout(r, 20));
    const port = dev.port();
    assert.ok(port);
    dev.ready({ connectedAs: "bot1", botUserId: "U1", teamId: "T1" });
    dev.markEvent();
    emitFrame(app, { type: "hello", num_connections: 1, debug_info: { host: "wss-a" } });

    const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as any;
    assert.equal(health.ok, true);
    assert.equal(health.connectedAs, "bot1");
    assert.equal(health.numConnections, 1);
    assert.ok(health.lastEventAt);

    const canaryRes = await fetch(`http://127.0.0.1:${port}/canary`, {
      method: "POST",
      body: JSON.stringify({ channel: "C123", timeoutMs: 5_000 }),
    });
    assert.equal(canaryRes.status, 200);
    const canary = (await canaryRes.json()) as any;
    assert.equal(canary.ok, true);

    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);
  });
});

test("canary deletes its posted message after the round trip (and after a timeout)", async () => {
  const app = makeApp(async ({ text }) => {
    setTimeout(() => emitFrame(app, { type: "events_api", payload: { event: { type: "message", text } } }), 10);
    return { ok: true, ts: "123.456" };
  });
  await withIntrospection(app, async (dev) => {
    const ok = await dev.canary("C123", 5_000);
    assert.equal(ok.ok, true);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(app.deletions, [{ channel: "C123", ts: "123.456" }]);
  });

  const silent = makeApp(async () => ({ ok: true, ts: "999.000" }));
  await withIntrospection(silent, async (dev) => {
    const res = await dev.canary("C123", 50);
    assert.equal(res.ok, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(silent.deletions, [{ channel: "C123", ts: "999.000" }]);
  });
});

test("lastActivityAt tracks real inbound frames but never canary traffic", async () => {
  const app = makeApp(async ({ text }) => {
    setTimeout(() => emitFrame(app, { type: "events_api", payload: { event: { type: "message", text } } }), 10);
    return { ok: true, ts: "1.2" };
  });
  await withIntrospection(app, async (dev) => {
    emitFrame(app, { type: "events_api", payload: { event: { type: "reaction_added" } } });
    const afterReaction = dev.state.lastActivityAt;
    assert.ok(afterReaction);
    emitFrame(app, { type: "interactive", payload: { actions: [{ action_id: "agent_request_approve" }] } });
    assert.ok((dev.state.lastActivityAt ?? 0) >= (afterReaction ?? 0));
    const before = dev.state.lastActivityAt;
    await new Promise((r) => setTimeout(r, 5));
    const res = await dev.canary("C123", 5_000);
    assert.equal(res.ok, true);
    assert.equal(dev.state.lastActivityAt, before, "canary round trip must not count as activity");
  });
});
