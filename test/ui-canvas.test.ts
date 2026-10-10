import "./support/auto-fake-sprites.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import type { SessionStateEvent } from "../src/runs/session-state-bus.ts";
import { uiStateId } from "../src/surfaces/ui-state.ts";
import { testConfig } from "./support/test-config.ts";

const body = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

const SECRET = "ui-canvas-test-secret-value!".repeat(2);
const THREAD = "web:U1:canvas";

describe("ui canvas and ui observe", () => {
  let built: BuiltApp;
  let agentServer: Server;
  let sourceServer: Server;
  let agentBase: string;
  let sourceBase: string;
  let sessionId: string;
  const runs = new Map<string, { id: string; status: string; request: { actor: { id: string } } }>([
    ["run-live", { id: "run-live", status: "running", request: { actor: { id: "U1" } } }],
    ["run-done", { id: "run-done", status: "done", request: { actor: { id: "U1" } } }],
  ]);
  const events: SessionStateEvent[] = [];

  const token = (extra: Partial<CapabilityClaims> = {}) =>
    mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: scopeId("personal", "U1"),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
        liveActor: true,
        surface: "web",
        runId: "run-live",
        threadRef: THREAD,
        ...extra,
      },
      SECRET,
    );

  const agent = async (method: string, path: string, body?: unknown, extra?: Partial<CapabilityClaims>) =>
    fetch(`${agentBase}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await token(extra),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const source = (method: string, path: string, body?: unknown) =>
    fetch(`${sourceBase}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    const deps = {
      sessions: built.sessions,
      uiState: built.uiState,
      featureFlags: built.featureFlags,
      signals: built.signals,
      sessionStateBus: built.sessionStateBus,
      runs: { get: async (id: string) => runs.get(id) ?? null } as never,
    };
    agentServer = createServer(built.app, { signingSecret: SECRET, ...deps });
    sourceServer = createInsecureTestServer(built.app, deps);
    await new Promise<void>((resolve) => agentServer.listen(0, resolve));
    await new Promise<void>((resolve) => sourceServer.listen(0, resolve));
    agentBase = `http://localhost:${(agentServer.address() as AddressInfo).port}`;
    sourceBase = `http://localhost:${(sourceServer.address() as AddressInfo).port}`;
    const turn: TurnRequest = {
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: THREAD },
      text: "hello",
    };
    sessionId = (await built.app.turn(turn)).sessionId!;
    built.sessionStateBus.subscribe((event) => {
      if (event.state === "ui") events.push(event);
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => agentServer.close(() => resolve()));
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
  });

  it("is off until the ui_canvas flag is enabled for the person", async () => {
    const r = await agent("POST", "/v1/ui/canvas", { html: "<p>hi</p>" });
    assert.equal(r.status, 403);
    assert.equal((await body(r)).error, "feature_disabled");
    await built.featureFlags.setEnabled("ui_canvas", scopeId("personal", "U1"), true, "test");
  });

  it("refuses tokens that are not a live web turn", async () => {
    for (const extra of [{ surface: "slack" }, { liveActor: false }, { triggered: true }, { botActor: true }]) {
      const r = await agent("POST", "/v1/ui/canvas", { html: "x" }, extra as Partial<CapabilityClaims>);
      assert.equal(r.status, 403, JSON.stringify(extra));
    }
    const ended = await agent("POST", "/v1/ui/canvas", { html: "x" }, { runId: "run-done" });
    assert.equal(ended.status, 409);
  });

  it("writes, updates, pins, replaces and signals only the owner", async () => {
    const first = await body(agent("POST", "/v1/ui/canvas", { html: "<p>a</p>", js: "1" }));
    assert.equal(first.canvas.rev, 1);
    const styled = await body(agent("POST", "/v1/ui/canvas", { css: "p{}" }));
    assert.equal(styled.canvas.rev, 2);
    const pinned = await body(agent("POST", "/v1/ui/canvas", { pinned: true }));
    assert.deepEqual([pinned.canvas.rev, pinned.canvas.pinned], [2, true], "pinning alone keeps the revision");
    const read = (await body(agent("GET", "/v1/ui/canvas"))).canvas;
    assert.deepEqual(read, { html: "<p>a</p>", css: "p{}", js: "1", pinned: true, rev: 2 });
    const replaced = (await body(agent("POST", "/v1/ui/canvas", { replace: true, html: "<b/>" }))).canvas;
    assert.equal(replaced.rev, 3);
    const after = (await body(agent("GET", "/v1/ui/canvas"))).canvas;
    assert.deepEqual(after, { html: "<b/>", css: "", js: "", pinned: false, rev: 3 });
    const event = events.at(-1)!;
    assert.deepEqual([event.sessionId, event.participants, event.ui], [sessionId, ["U1"], { kind: "canvas" }]);
  });

  it("rejects bad and oversized writes", async () => {
    assert.equal((await agent("POST", "/v1/ui/canvas", { html: 5 })).status, 400);
    assert.equal((await agent("POST", "/v1/ui/canvas", {})).status, 400);
    assert.equal((await agent("POST", "/v1/ui/canvas", { js: "x".repeat(70_000) })).status, 413);
  });

  it("serves the canvas only to its owner with the flag on, and lets the owner pin or dismiss it", async () => {
    const own = await source("GET", `/v1/ui/canvases/${sessionId}?principalId=U1`);
    assert.equal((await body(own)).canvas.html, "<b/>");
    assert.equal((await source("GET", `/v1/ui/canvases/${sessionId}?principalId=U2`)).status, 404);
    const pin = await source("POST", `/v1/ui/canvases/${sessionId}`, { principalId: "U1", pinned: true });
    assert.equal((await body(pin)).canvas.pinned, true);
    await built.featureFlags.setEnabled("ui_canvas", scopeId("personal", "U1"), false, "test");
    assert.equal((await source("GET", `/v1/ui/canvases/${sessionId}?principalId=U1`)).status, 404);
    await built.featureFlags.setEnabled("ui_canvas", scopeId("personal", "U1"), true, "test");
    await source("POST", `/v1/ui/canvases/${sessionId}`, { principalId: "U1", dismiss: true });
    assert.equal((await body(agent("GET", "/v1/ui/canvas"))).canvas, null);
  });

  it("keeps revisions increasing across a dismiss and never resurrects an empty canvas", async () => {
    const before = (await body(agent("POST", "/v1/ui/canvas", { html: "<i/>" }))).canvas.rev;
    assert.equal((await agent("DELETE", "/v1/ui/canvas")).status, 200);
    const pin = await agent("POST", "/v1/ui/canvas", { pinned: true });
    assert.equal(pin.status, 404);
    const ownerPin = await source("POST", `/v1/ui/canvases/${sessionId}`, { principalId: "U1", pinned: true });
    assert.equal(ownerPin.status, 404);
    assert.equal((await body(agent("GET", "/v1/ui/canvas"))).canvas, null);
    const again = (await body(agent("POST", "/v1/ui/canvas", { html: "<i/>" }))).canvas.rev;
    assert.equal(again, before + 1);
    await agent("DELETE", "/v1/ui/canvas");
  });

  it("keeps canvas and observe keys out of the generic ui-state API", async () => {
    for (const key of [`ui-canvas-${sessionId}`, "ui-observe-abc"]) {
      const put = await source("PUT", "/v1/ui-state", { principalId: "U1", key, value: { runId: "run-live" } });
      assert.equal(put.status, 400, key);
      assert.equal((await source("GET", `/v1/ui-state?principalId=U1&key=${key}`)).status, 400, key);
    }
  });

  it("observes only in the person's own conversations", async () => {
    const shared = await agent("POST", "/v1/ui/observe", {}, { scopeId: scopeId("channel", "C1") });
    assert.equal(shared.status, 403);
  });

  it("returns the snapshot the owner's browser posts back", async () => {
    const pending = agent("POST", "/v1/ui/observe", { selector: ".x", screenshot: true });
    let request: SessionStateEvent | undefined;
    for (let i = 0; i < 100 && !request; i++) {
      request = events.find((e) => e.ui?.kind === "observe");
      if (!request) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(request?.ui?.kind === "observe");
    assert.deepEqual([request.ui.selector, request.ui.screenshot], [".x", true]);
    const stranger = await source("POST", `/v1/ui/observe/${request.ui.callId}/result`, {
      principalId: "U2",
      snapshot: { html: "forged" },
    });
    assert.equal(stranger.status, 404, "another person cannot answer");
    const answered = await source("POST", `/v1/ui/observe/${request.ui.callId}/result`, {
      principalId: "U1",
      snapshot: { html: "<main/>" },
    });
    assert.equal(answered.status, 200);
    const result = await body(pending);
    assert.deepEqual(result.snapshot, { html: "<main/>" });
    const late = await source("POST", `/v1/ui/observe/${request.ui.callId}/result`, {
      principalId: "U1",
      snapshot: { html: "late" },
    });
    assert.equal(late.status, 404, "a call is answered once");
  });

  it("does not deliver a result into a run the person does not own", async () => {
    runs.set("run-other", { id: "run-other", status: "running", request: { actor: { id: "U2" } } });
    await built.uiState.put(uiStateId("U1", "ui-observe-forged"), { value: { runId: "run-other" }, updatedAt: 1 });
    const r = await source("POST", "/v1/ui/observe/forged/result", { principalId: "U1", snapshot: {} });
    assert.equal(r.status, 404);
  });
});
