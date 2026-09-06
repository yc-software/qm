import "./support/auto-fake-sprites.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "session-pins-secret-value!".repeat(2);

function dm(externalId: string, text: string, thread: string): TurnRequest {
  return { surface: "test", actor: { externalId }, conversation: { kind: "dm", threadRef: thread }, text };
}

describe("conversation pins self-API", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let sessionId: string;
  const THREAD = "web:U1:pins";

  const capFor = (actorId: string, threadRef?: string) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
        liveActor: true,
        ...(threadRef ? { threadRef } : {}),
      },
      SECRET,
    );

  const call = async (method: string, path: string, body?: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { "x-agent-capability": token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    server = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    sessionId = (await built.app.turn(dm("U1", "remember the launch date is Sept 4", THREAD))).sessionId!;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a token not bound to a conversation", async () => {
    const res = await call("POST", "/v1/pins", { text: "note" }, await capFor("U1"));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "no_conversation");
  });

  it("requires a capability token", async () => {
    const res = await call("GET", "/v1/pins");
    assert.equal(res.status, 401);
  });

  it("pins a free-text note and lists it", async () => {
    const token = await capFor("U1", THREAD);
    const res = await call("POST", "/v1/pins", { text: "  launch date: Sept 4  " }, token);
    assert.equal(res.status, 200);
    const { pin } = (await res.json()) as { pin: { id: string; text: string; addedBy: string } };
    assert.equal(pin.text, "launch date: Sept 4");
    assert.equal(pin.addedBy, "U1");
    const list = await call("GET", "/v1/pins", undefined, token);
    assert.equal(list.status, 200);
    const { pins } = (await list.json()) as { pins: Array<{ id: string }> };
    assert.ok(pins.some((p) => p.id === pin.id));
  });

  it("pins a transcript entry by seq with a preview", async () => {
    const token = await capFor("U1", THREAD);
    const entries = await built.sessions.getEntries(sessionId);
    const userEntry = entries.find((e) => e.type === "user");
    assert.ok(userEntry, "session has a user entry");
    const res = await call("POST", "/v1/pins", { seq: userEntry!.seq }, token);
    assert.equal(res.status, 200);
    const { pin } = (await res.json()) as { pin: { entrySeq: number; preview?: string } };
    assert.equal(pin.entrySeq, userEntry!.seq);
    assert.ok(pin.preview?.includes("launch date"), `preview carries the entry text (got ${pin.preview})`);
  });

  it("rejects a seq that doesn't exist", async () => {
    const token = await capFor("U1", THREAD);
    const res = await call("POST", "/v1/pins", { seq: 99_999 }, token);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, "entry_not_found");
  });

  it("rejects an empty pin", async () => {
    const token = await capFor("U1", THREAD);
    const res = await call("POST", "/v1/pins", {}, token);
    assert.equal(res.status, 400);
  });

  it("surfaces pins on the transcript for the web UI", async () => {
    const found = await built.app.getSessionForViewer(sessionId, "U1");
    assert.ok(found, "viewer can read the session");
    assert.ok((found!.pins?.length ?? 0) >= 2, "transcript response carries the pins");
    const entryPin = found!.pins!.find((p) => p.entrySeq !== undefined);
    assert.ok(entryPin?.preview, "entry pins are decorated with a preview");
  });

  it("hides entry-pin previews from viewers outside the participant window", async () => {
    await built.sessions.addParticipant(sessionId, "U3");
    const found = await built.app.getSessionForViewer(sessionId, "U3");
    assert.ok(found, "the late joiner can read the session");
    const entryPin = found!.pins!.find((p) => p.entrySeq !== undefined);
    assert.ok(entryPin, "the pin itself is listed");
    assert.equal(entryPin!.preview, undefined, "no preview for an entry outside the viewer's window");
    const mine = await built.app.getSessionForViewer(sessionId, "U1");
    const minePin = mine!.pins!.find((p) => p.entrySeq !== undefined);
    assert.ok(minePin?.preview, "the original participant still sees the preview");
  });

  it("unpins an item", async () => {
    const token = await capFor("U1", THREAD);
    const created = await call("POST", "/v1/pins", { text: "ephemeral" }, token);
    const { pin } = (await created.json()) as { pin: { id: string } };
    const del = await call("DELETE", `/v1/pins/${pin.id}`, undefined, token);
    assert.equal(del.status, 200);
    const again = await call("DELETE", `/v1/pins/${pin.id}`, undefined, token);
    assert.equal(again.status, 404);
    const list = await call("GET", "/v1/pins", undefined, token);
    const { pins } = (await list.json()) as { pins: Array<{ id: string }> };
    assert.ok(!pins.some((p) => p.id === pin.id));
  });

  it("mirrors an entry pin to a native Slack pin in a DM — and only there", async () => {
    const SLACK_DM = "dm:D0PINCHAN";
    const slackTurn: TurnRequest = {
      surface: "slack",
      actor: { externalId: "U9" },
      conversation: { kind: "dm", threadRef: SLACK_DM },
      origin: { kind: "human", messageTs: "1723497600.000100" },
      text: "the venue is booked for Sept 4",
    };
    await built.app.turn(slackTurn);
    const token = await capFor("U9", SLACK_DM);
    const res = await call("POST", "/v1/pins", { seq: 0 }, token);
    assert.equal(res.status, 200);
    const { pin } = (await res.json()) as { pin: { id: string } };
    let queued = await built.deliveries.pending("slack");
    assert.equal(queued.length, 1, "the DM entry pin enqueues one native pin action");
    assert.deepEqual(queued[0]!.destination.pin, { messageTs: "1723497600.000100" });
    assert.equal(queued[0]!.destination.target, "D0PINCHAN");
    await built.deliveries.ack(queued[0]!.id, Date.now());

    const noteRes = await call("POST", "/v1/pins", { text: "just a note" }, token);
    assert.equal(noteRes.status, 200);
    assert.equal((await built.deliveries.pending("slack")).length, 0, "a text-only pin has no Slack message to pin");

    const del = await call("DELETE", `/v1/pins/${pin.id}`, undefined, token);
    assert.equal(del.status, 200);
    queued = await built.deliveries.pending("slack");
    assert.equal(queued.length, 1, "unpinning mirrors a native unpin");
    assert.deepEqual(queued[0]!.destination.pin, { messageTs: "1723497600.000100", remove: true });
    await built.deliveries.ack(queued[0]!.id, Date.now());

    const webToken = await capFor("U1", THREAD);
    const webRes = await call("POST", "/v1/pins", { seq: 0 }, webToken);
    assert.equal(webRes.status, 200);
    assert.equal((await built.deliveries.pending("slack")).length, 0, "a web conversation never touches Slack pins");
    const webPin = ((await webRes.json()) as { pin: { id: string } }).pin;
    await call("DELETE", `/v1/pins/${webPin.id}`, undefined, webToken);
  });

  it("caps pins per conversation", async () => {
    const token = await capFor("U1", THREAD);
    const existing = ((await (await call("GET", "/v1/pins", undefined, token)).json()) as { pins: unknown[] }).pins
      .length;
    for (let i = existing; i < 50; i++) {
      const res = await call("POST", "/v1/pins", { text: `filler ${i}` }, token);
      assert.equal(res.status, 200);
    }
    const overflow = await call("POST", "/v1/pins", { text: "one too many" }, token);
    assert.equal(overflow.status, 409);
    assert.equal(((await overflow.json()) as { error: string }).error, "pin_limit");
  });
});
