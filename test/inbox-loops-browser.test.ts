import "./support/auto-fake-sprites.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { API_ALIASES } from "../src/api/browser-session.ts";
import { createServer } from "../src/api/server.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserImpersonationCookie, browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

const SECRET = "inbox-loops-browser-signing-secret-0123456789";
const config = testConfig({ signingSecret: SECRET, capabilitySecret: SECRET, publicWebUrl: "https://qm.test" });
const built = stopAtEnd(buildApp(config));
const itemImages = new Map<string, () => Response>();
const server = createServer(built.app, {
  ...serverDeps(config, built),
  ...browserSessionDeps,
  itemImageFetch: async (input) => {
    const fake = itemImages.get(String(input));
    if (!fake) throw new TypeError(`unexpected item image fetch ${String(input)}`);
    return fake();
  },
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const flag = (user: string, on: boolean) =>
  built.featureFlags.setEnabled("inbox_loops", scopeId("personal", user), on, "test");

function browser(user: string, method: string, path: string, body?: unknown, cookie = browserSessionCookie(user)) {
  return fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: "https://qm.test", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function firstInboxLoop(user: string): Promise<string> {
  const inbox = (await (await browser(user, "GET", "/api/inbox")).json()) as { available: { id: string }[] };
  return inbox.available[0]!.id;
}

const inboxLoopsAliases = [...API_ALIASES.keys()]
  .map((key) => key.split(" ", 2) as [string, string])
  .filter(([, path]) => path.startsWith("/api/inbox") || path.startsWith("/api/loops"));

test("every inbox and loops page route refuses a signed-in person without the inbox_loops flag", async () => {
  assert.ok(inboxLoopsAliases.length > 0);
  for (const [method, pattern] of inboxLoopsAliases) {
    const path = pattern.replaceAll(/:[A-Za-z]+/g, "x1");
    const response = await browser("dana", method, path, method === "GET" ? undefined : {});
    assert.deepEqual(
      [response.status, await response.json()],
      [403, { error: "feature_disabled" }],
      `${method} ${path}`,
    );
  }
});

test("the flag alone opens inbox and loops to a person", async () => {
  await flag("erin", true);
  assert.equal((await browser("erin", "GET", "/api/loops")).status, 200);
  const created = await browser("erin", "POST", "/api/loops", {
    name: "Weekly review",
    playbook: "Review.",
    successCondition: "Reviewed.",
  });
  assert.ok(created.status < 300, await created.clone().text());
  const selected = await browser("erin", "POST", "/api/inbox/selection", { loopIds: [await firstInboxLoop("erin")] });
  assert.equal(selected.status, 200);
  const sent = await browser("erin", "GET", "/api/inbox/sent");
  assert.deepEqual([sent.status, ((await sent.json()) as { error: string }).error], [409, "not_connected"]);
  await flag("erin", false);
  assert.equal((await browser("erin", "GET", "/api/loops")).status, 403);
});

test("agents keep using loops through their capability without the person flag", async () => {
  const cap = await mintCapabilityToken(
    {
      actorId: "hal",
      scopeId: scopeId("personal", "hal"),
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );
  const response = await fetch(`${base}/v1/loops`, { headers: { "x-agent-capability": cap } });
  assert.equal(response.status, 200, await response.clone().text());
});

test("loop grants and decisions need the person's own session or running turn", async () => {
  await flag("fay", true);
  const loopId = await firstInboxLoop("fay");
  const impersonating = `${browserSessionCookie("admin-alice")}; ${browserImpersonationCookie("admin-alice", "fay")}`;
  for (const [path, body] of [
    ["grants", { shipAction: "send" }],
    ["outputs/o1/decide", { decision: "ship" }],
    ["autopilot", { enabled: true }],
  ] as const) {
    const refused = await browser("fay", "POST", `/api/loops/${loopId}/${path}`, body, impersonating);
    assert.deepEqual(
      [refused.status, await refused.json()],
      [403, { error: "forbidden", message: "Unavailable while impersonating." }],
      path,
    );
  }
  const ended = await mintCapabilityToken(
    {
      actorId: "fay",
      scopeId: scopeId("personal", "fay"),
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      runId: "run-that-ended",
      runLeaseToken: "lease",
      runAttempt: 1,
      threadRef: "dm:fay",
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );
  const late = await fetch(`${base}/v1/loops/${loopId}/grants`, {
    method: "POST",
    headers: { "x-agent-capability": ended, "content-type": "application/json" },
    body: JSON.stringify({ shipAction: "send" }),
  });
  assert.deepEqual([late.status, ((await late.json()) as { error: string }).error], [403, "inactive_run"]);
  assert.deepEqual(await built.loops.grants.byLoop(loopId), []);
});

test("an inbox item image is served only as a sandboxed, non-sniffable image", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  itemImages.set("https://images.example/a.png", () => new Response(png, { headers: { "content-type": "image/png" } }));
  itemImages.set(
    "https://internal.example/admin",
    () => new Response("<h1>admin</h1>", { status: 403, headers: { "content-type": "text/html" } }),
  );
  await flag("ivy", true);
  const loopId = await firstInboxLoop("ivy");
  await built.loops.items.ingest([
    {
      loopId,
      dedupeKey: "image-item",
      sourcePayload: {
        title: "Photo",
        snippet: "see attached",
        images: ["https://images.example/a.png", "https://internal.example/admin"],
      },
      proposal: { data: {}, by: "agent" },
    },
  ]);
  const [item] = await built.loops.items.byLoop(loopId);
  const image = await browser("ivy", "GET", `/api/loops/${loopId}/items/${item!.id}/image?ctx=-1&i=0`);
  assert.equal(image.status, 200, await image.clone().text());
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("content-security-policy"), "sandbox");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const refused = await browser("ivy", "GET", `/api/loops/${loopId}/items/${item!.id}/image?ctx=-1&i=1`);
  assert.deepEqual([refused.status, await refused.json()], [502, { error: "upstream" }]);
  await flag("ivy", false);
});
