import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { App } from "../src/api/app-types.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createServer } from "../src/api/server.ts";
import type { NewItem } from "../src/sessions/items.ts";
import type { TurnRequest } from "../src/types.ts";
import { browserImpersonationCookie, browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

const id = "6f1c2a4e-0b7d-4c55-9a8e-3d2f1e0c9b8a";
const thread = `web:alice:meeting:${id}`;
const flagged = new Set<string>();
const turns: TurnRequest[] = [];
const appended: NewItem[] = [];
const runs = new Map<string, { createdAt: number; result: { reply?: string }; request: TurnRequest }>();
let pending = false;

const app = {
  spawnSession: async (_user: string, opts: { threadRef?: string; title?: string }) => {
    assert.equal(opts.threadRef, thread);
    return { session: { id: "meeting-session", title: opts.title } };
  },
  turn: async (req: TurnRequest) => {
    turns.push(req);
    runs.set(req.idempotencyKey!, {
      createdAt: Date.now(),
      result: { reply: "Weekly sync with Dana Kowalczyk" },
      request: req,
    });
    return { status: "queued", runId: "run" };
  },
} as unknown as App;

const deps = {
  signingSecret: "meeting-route-signing-secret-0123456789",
  replayDedupe: { claim: async () => true },
  ...browserSessionDeps,
  admin: { adminStatusOf: async () => ({ isAdmin: true }) },
  openaiApiKey: "meeting-test-key",
  featureFlags: { enabled: async (name: string, scope: string) => flagged.has(`${name}:${scope}`) },
  sessions: {
    getByThread: async (ref: string) => (ref === thread ? { id: "meeting-session" } : null),
    getItems: async () => appended.map((item) => ({ ...item, seq: 1, createdAt: 0 })),
    appendDelivery: async (_writer: unknown, item: NewItem) => {
      if (appended.some((seen) => seen.externalId === item.externalId)) return false;
      appended.push(item);
      return true;
    },
  },
  runs: {
    getByDedupKey: async (key: string) => runs.get(key) ?? null,
    inFlightForThread: async () => (pending ? [{ status: "pending" }] : []),
  },
};
const server = createServer(app, deps as unknown as ServerDeps);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
test.after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const headers = { cookie: browserSessionCookie("alice"), origin: browserSessionDeps.portalUrl };
const post = (path: string, body: unknown, extra: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(`${base}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });

test("the recorder stays off until the person's flag is on, and while impersonating", async () => {
  const enabled = async (cookie: string) =>
    ((await (await fetch(`${base}/api/meetings`, { headers: { cookie } })).json()) as { enabled: boolean }).enabled;
  assert.equal(await enabled(headers.cookie), false);
  assert.equal((await post("/api/meetings", { id, startedAt: 1, timezone: "UTC" })).status, 404);
  flagged.add("meeting_recorder:personal:alice");
  assert.equal(await enabled(headers.cookie), true);
  assert.equal(await enabled(`${headers.cookie}; ${browserImpersonationCookie("alice", "bob")}`), false);
});

test("a meeting opens with a brief, stores speech once as overheard lines, checks in, and is written up", async (t) => {
  flagged.add("meeting_recorder:personal:alice");
  const prompts: unknown[] = [];
  const realFetch = globalThis.fetch;
  const spoken = ["Dana said revenue tripled.", ""];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    if (!String(url).startsWith("https://api.openai.com/")) return realFetch(url, init);
    prompts.push((await new Response(init!.body, { headers: init!.headers }).formData()).get("prompt"));
    return Response.json({ text: spoken.shift() ?? "" });
  });
  const start = await post("/api/meetings", {
    id,
    startedAt: Date.UTC(2026, 10, 23, 18, 2),
    app: "Zoom",
    timezone: "America/Los_Angeles",
  });
  assert.deepEqual(
    [start.status, await start.json()],
    [201, { path: "/s/meeting-session", prompt: "Weekly sync with Dana Kowalczyk" }],
  );
  assert.deepEqual(
    [turns[0]!.origin, turns[0]!.displayText, turns[0]!.conversation.threadRef, Boolean(turns[0]!.conversationHeader)],
    [{ kind: "human" }, "Recording started · Zoom · 10:02 AM", thread, true],
  );
  runs.get(`${thread}:start`)!.createdAt = Date.now() - 150_000;
  pending = true;
  const speech = (at: number) =>
    post(`/api/meetings/${id}/speech?speaker=others&at=${at}`, "audio", { "content-type": "audio/webm" });
  assert.deepEqual(await (await speech(1_795_000_000_000)).json(), {
    text: "Dana said revenue tripled.",
    prompt: "Weekly sync with Dana Kowalczyk\nDana said revenue tripled.",
  });
  assert.equal(String(prompts[0]).includes("Dana Kowalczyk"), true);
  assert.deepEqual(appended, [
    {
      kind: "UserMessage",
      externalId: "1795000000.000:others",
      text: "Dana said revenue tripled.",
      body: { overheard: true, name: "Others" },
    },
  ]);
  assert.equal(turns.length, 1);
  pending = false;
  assert.deepEqual(await (await speech(1_795_000_005_000)).json(), {
    text: "",
    prompt: "Weekly sync with Dana Kowalczyk\nDana said revenue tripled.",
  });
  spoken.push("Dana said revenue tripled.");
  await speech(1_795_000_000_000);
  assert.equal(appended.length, 1);
  spoken.push("And margins are flat.");
  await speech(1_795_000_010_000);
  assert.deepEqual(
    [turns[1]!.surface, turns[1]!.origin, turns[1]!.deliveryTarget],
    ["meeting", { kind: "automation" }, undefined],
  );
  const stop = await post(`/api/meetings/${id}/stop`, { endedAt: Date.UTC(2026, 10, 23, 18, 47) });
  assert.equal(stop.status, 202);
  assert.deepEqual(
    [turns[2]!.origin, turns[2]!.displayText, turns[0]!.skipMemory, turns[2]!.skipMemory],
    [{ kind: "human" }, "Recording stopped · 10:47 AM", true, true],
  );
  spoken.push("One more thing.");
  await speech(1_795_000_020_000);
  assert.equal(turns.length, 3);
});

test("a segment OpenAI rejects is dropped, and a refused key ends the recording", async (t) => {
  const realFetch = globalThis.fetch;
  const statuses = [400, 401];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) =>
    String(url).startsWith("https://api.openai.com/")
      ? Response.json({ error: { code: "rejected" } }, { status: statuses.shift() })
      : realFetch(url, init),
  );
  const speech = () => post(`/api/meetings/${id}/speech?speaker=me&at=1`, "audio", { "content-type": "audio/webm" });
  assert.deepEqual([(await speech()).status, (await speech()).status], [422, 403]);
  assert.equal((await post(`/api/meetings/${"-".repeat(36)}/stop`, { endedAt: 1 })).status, 400);
});

test("text transcribed on the Mac is stored without an OpenAI key, which audio still needs", async (t) => {
  const keyless = createServer(app, { ...deps, openaiApiKey: undefined } as unknown as ServerDeps);
  await new Promise<void>((resolve) => keyless.listen(0, "127.0.0.1", resolve));
  t.after(() => keyless.close());
  const speech = (body: unknown, type = "application/json") =>
    fetch(
      `http://127.0.0.1:${(keyless.address() as AddressInfo).port}/api/meetings/${id}/speech?speaker=me&at=1795000030000`,
      { method: "POST", headers: { ...headers, "content-type": type }, body: JSON.stringify(body) },
    );
  const reply = (await (await speech({ text: " Margins are flat. " })).json()) as { text: string; prompt: string };
  assert.deepEqual([reply.text, appended.at(-1)!.text], ["Margins are flat.", "Margins are flat."]);
  assert.equal(reply.prompt.endsWith("\nMargins are flat."), true);
  const refused = await speech("audio", "audio/webm");
  assert.deepEqual([(await speech({})).status, refused.status], [400, 403]);
  assert.equal(((await refused.json()) as { error: string }).error, "transcription_unavailable");
});
