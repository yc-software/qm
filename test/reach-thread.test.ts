import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "reach-thread-secret".repeat(3);
const TS = "1723497600.123456";

describe("POST /v1/reach with threadTs", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const cap = async (actorId: string) =>
    await mintCapabilityToken(
      { actorId, scopeId: scopeId("personal", actorId), exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );

  const post = async (body: unknown, actorId = "U-carol") =>
    fetch(`${base}/v1/reach`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await cap(actorId) },
      body: JSON.stringify(body),
    });

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    await built.app.upsertDirectory([
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
    ]);
    await built.app.upsertChannels([{ channelId: "C-eng", name: "eng" }]);
    server = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("threads a channel post: the delivery target carries channel:threadTs", async () => {
    const res = await post({ channel: "eng", text: "in the thread", threadTs: TS });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deliveryId: string };
    const d = (await built.app.pendingDeliveries("slack")).find((x) => x.id === body.deliveryId);
    assert.ok(d, "delivery enqueued for the slack surface");
    assert.equal(d!.destination.target, `C-eng:${TS}`);
  });

  it("an unthreaded channel post keeps a bare channel target", async () => {
    const res = await post({ channel: "eng", text: "top level" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deliveryId: string };
    const d = (await built.app.pendingDeliveries("slack")).find((x) => x.id === body.deliveryId);
    assert.equal(d!.destination.target, "C-eng");
  });

  it("threads a DM to a person without changing its principal target", async () => {
    const res = await post({ recipient: "Alice", text: "in the DM thread", threadTs: TS });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deliveryId: string };
    const d = (await built.app.pendingDeliveries("principal")).find((x) => x.id === body.deliveryId);
    assert.ok(d, "delivery enqueued for the principal surface");
    assert.equal(d!.destination.target, "U-alice");
    assert.equal(d!.destination.threadTs, TS);
  });

  it("rejects a malformed threadTs", async () => {
    const res = await post({ channel: "eng", text: "hi", threadTs: "not-a-ts" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { message: string };
    assert.match(body.message, /threadTs must be/);
  });

  it("rejects threadTs combined with react or delete", async () => {
    const r1 = await post({ channel: "eng", react: { ts: TS, emoji: "eyes" }, threadTs: TS });
    assert.equal(r1.status, 400);
    const r2 = await post({ channel: "eng", delete: { ts: TS }, threadTs: TS });
    assert.equal(r2.status, 400);
  });
});
