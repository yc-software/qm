import "./support/auto-fake-sprites.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import type { SessionStateEvent } from "../src/runs/session-state-bus.ts";
import { desktopCallFor, NO_DESKTOP_TEXT } from "../src/surfaces/desktop-calls.ts";
import { currentDesktopDownload } from "../src/api/routes/desktop-download.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, stopAtEnd } from "./support/build-app.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";
import { testConfig } from "./support/test-config.ts";

const config = testConfig({ signingSecret: "desktop-calls-signing-secret-0123456789" });
const built = stopAtEnd(buildApp(config));
const server = createServer(built.app, { ...serverDeps(config, built), ...browserSessionDeps } as ServerDeps);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const events: SessionStateEvent[] = [];
built.sessionStateBus.subscribe((event) => {
  if (event.state === "ui") events.push(event);
});
const relay = { bus: built.sessionStateBus, uiState: built.uiState, signals: built.signals };
const [windowA, windowB] = [randomUUID(), randomUUID()];

const call = (callId: string, opts: { clientId?: string; signal?: AbortSignal; timeoutMs?: number } = {}) =>
  desktopCallFor(relay, {
    actorId: "alice",
    threadRef: "web:alice:t1",
    sessionId: "s1",
    runId: randomUUID(),
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
  })!(callId, { code: "await computer.listApps()" }, opts.timeoutMs ?? 20_000, opts.signal);

const post = (path: string, body: unknown, user = "alice") =>
  fetch(`${base}/api/desktop/calls/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: browserSessionDeps.portalUrl,
      cookie: browserSessionCookie(user),
    },
    body: JSON.stringify(body),
  });

async function announced(callId: string, stop?: boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const event = events.find((e) => e.ui?.kind === "desktop" && e.ui.callId === callId && e.ui.stop === stop);
    if (event) return assert.deepEqual(event.participants, ["alice"]);
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`no desktop call announced for ${callId}`);
}

test("a call from any turn reaches the person's open desktop app, which claims and answers it once", async () => {
  const pending = call("c1");
  await announced("c1");
  assert.equal(
    (await post("c1/claim", { desktopClientId: windowA }, "bob")).status,
    404,
    "another person cannot claim",
  );
  const claim = await post("c1/claim", { desktopClientId: windowA });
  assert.equal(claim.status, 200);
  assert.deepEqual(((await claim.json()) as { args: unknown }).args, { code: "await computer.listApps()" });
  assert.equal((await post("c1/claim", { desktopClientId: windowB })).status, 404, "a second window loses");
  assert.equal(
    (await post("c1/claim", { desktopClientId: windowA })).status,
    404,
    "a duplicate announcement cannot run the call twice in the same window",
  );
  const forged = await post("c1/result", { desktopClientId: windowB, result: { content: "forged" } });
  assert.equal(forged.status, 404);
  const answered = await post("c1/result", { desktopClientId: windowA, result: { content: "Calculator" } });
  assert.equal(answered.status, 200);
  assert.deepEqual(await pending, { content: "Calculator" });
});

test("a call from a desktop app turn is claimable only by the window that sent it", async () => {
  const pending = call("c2", { clientId: windowA });
  await announced("c2");
  assert.equal((await post("c2/claim", { desktopClientId: windowB })).status, 404);
  assert.equal((await post("c2/claim", { desktopClientId: windowA })).status, 200);
  await post("c2/result", { desktopClientId: windowA, result: { content: "ok" } });
  assert.deepEqual(await pending, { content: "ok" });
});

test("with no desktop app connected the call ends with a clear error", async () => {
  assert.deepEqual(await call("c3", { timeoutMs: 500 }), { content: NO_DESKTOP_TEXT, isError: true });
  assert.equal((await post("c3/claim", { desktopClientId: windowA })).status, 404, "an expired call cannot be claimed");
});

test("stopping the turn tells the desktop app to stop the running call", async () => {
  const turn = new AbortController();
  const pending = call("c4", { signal: turn.signal });
  await announced("c4");
  assert.equal((await post("c4/claim", { desktopClientId: windowA })).status, 200);
  turn.abort();
  assert.equal(await pending, "cancelled");
  await announced("c4", true);
});

test("Download for Mac follows the desktop update feed to its current release", async () => {
  const zip = "https://github.com/yc-software/qm/releases/download/desktop-v0.1.7/QM-mac-arm64.zip";
  const feed =
    (body: unknown, status = 200) =>
    async () =>
      new Response(JSON.stringify(body), { status });
  const current = { currentRelease: "0.1.7", releases: [{ version: "0.1.7", updateTo: { url: zip } }] };
  assert.equal(await currentDesktopDownload(feed(current)), zip);
  await assert.rejects(currentDesktopDownload(feed(current, 404)), /HTTP 404/);
  await assert.rejects(
    currentDesktopDownload(
      feed({ ...current, releases: [{ version: "0.1.7", updateTo: { url: "https://example.com/x.zip" } }] }),
    ),
    /no download for 0.1.7/,
  );
  const response = await fetch(`${base}/api/desktop/download`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.ok(response.headers.get("location")?.startsWith("https://github.com/yc-software/qm/releases"));
});
