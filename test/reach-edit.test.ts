import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId, type Destination } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "reach-edit-secret".repeat(3);
const TS = "1723497600.123456";

describe("POST /v1/reach with edit", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const cap = async (destination?: Destination, turn: { surface?: string; liveReplies?: boolean } = {}) =>
    await mintCapabilityToken(
      {
        actorId: "U-carol",
        scopeId: scopeId("personal", "U-carol"),
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...(destination ? { destination } : {}),
        ...turn,
      },
      SECRET,
    );

  const post = async (body: unknown, destination?: Destination, turn?: { surface?: string; liveReplies?: boolean }) =>
    fetch(`${base}/v1/reach`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await cap(destination, turn) },
      body: JSON.stringify(body),
    });

  const delivery = async (res: Response) => {
    assert.equal(res.status, 200, await res.clone().text());
    const { deliveryId } = (await res.json()) as { deliveryId: string };
    const d = (await built.app.pendingDeliveries("slack")).find((x) => x.id === deliveryId);
    assert.ok(d, "delivery enqueued for the slack surface");
    return d!;
  };

  before(async () => {
    built = buildApp(
      testConfig({ signingSecret: SECRET, genericChat: { url: "https://chat.example", secret: SECRET } }),
    );
    await built.app.upsertDirectory([
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
    ]);
    await built.app.upsertChannels([{ channelId: "C-eng", name: "eng" }]);
    server = createServer(built.app, {
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
      signingSecret: SECRET,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rewrites a message in a named channel in place: edit = ts, text = the new text", async () => {
    const d = await delivery(await post({ channel: "eng", edit: { ts: TS }, text: "corrected numbers" }));
    assert.equal(d.destination.target, "C-eng");
    assert.deepEqual(d.destination.edit, { messageTs: TS });
    assert.equal(d.text, "corrected numbers");
  });

  it("with no target, edits in this conversation's Slack surface", async () => {
    const here: Destination = { type: "slack", target: `C-eng:${TS}`, audienceScopeId: scopeId("channel", "C-eng") };
    const d = await delivery(await post({ edit: { ts: "1723497601.000001" }, text: "fixed" }, here));
    assert.equal(d.destination.target, `C-eng:${TS}`);
    assert.deepEqual(d.destination.edit, { messageTs: "1723497601.000001" });
    assert.equal(d.text, "fixed");
  });

  it("with no target, edits in this conversation on another chat surface only during a live-reply turn", async () => {
    const here: Destination = { type: "generic-chat", target: "generic-chat:7001:dm:88" };
    const body = { edit: { ts: "1793649600.00000000000000001002" }, text: "42 widgets" };
    assert.equal((await post(body, here, { surface: "generic-chat" })).status, 400);
    const res = await post(body, here, { surface: "generic-chat", liveReplies: true });
    assert.equal(res.status, 200, await res.clone().text());
    const { deliveryId } = (await res.json()) as { deliveryId: string };
    const d = (await built.app.pendingDeliveries("generic-chat")).find((x) => x.id === deliveryId);
    assert.deepEqual(d?.destination.edit, { messageTs: "1793649600.00000000000000001002" });
  });

  it("refuses an edit outside a chat surface", async () => {
    const web: Destination = { type: "web", target: "web:carol:s1", audienceScopeId: scopeId("personal", "U-carol") };
    const res = await post({ edit: { ts: TS }, text: "fixed" }, web);
    assert.equal(res.status, 400);
  });

  it("rejects malformed or conflicting edits", async () => {
    for (const body of [
      { channel: "eng", edit: { ts: TS } },
      { channel: "eng", edit: {}, text: "no ts" },
      { channel: "eng", edit: { ts: "latest" }, text: "not a Slack ts" },
      { channel: "eng", edit: { ts: TS }, text: "x", delete: { ts: TS } },
      { channel: "eng", edit: { ts: TS }, text: "x", react: { ts: TS, emoji: "eyes" } },
      { channel: "eng", edit: { ts: TS }, text: "x", threadTs: TS },
      { recipient: "Alice", edit: { ts: TS }, text: "x" },
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });
});
