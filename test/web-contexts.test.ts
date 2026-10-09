import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { ContextSummary } from "../src/api/app.ts";
import { testConfig } from "./support/test-config.ts";
import { principalOf } from "./support/principal.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webctx-")) }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { built, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const contexts = async (base: string, principalId: string): Promise<ContextSummary[]> => {
  const res = await fetch(`${base}/v1/contexts?principalId=${encodeURIComponent(principalId)}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { contexts: ContextSummary[] }).contexts;
};

const webTurn = (base: string, actor: string, conversation: unknown, text = "hi") =>
  fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: "web", actor: { externalId: actor }, conversation, text }),
  });

test("GET /v1/contexts: personal always; public channels and current private memberships", async () => {
  const s = start();
  try {
    const ALICE_ID = await principalOf(s.built, "alice");
    const BOB_ID = await principalOf(s.built, "bob");
    const before = await contexts(s.base, ALICE_ID);
    assert.equal(before.length, 1);
    assert.equal(before[0]!.scopeId, `personal:${ALICE_ID}`);
    assert.equal(before[0]!.kind, "personal");

    await s.built.app.upsertChannels(
      [
        { channelId: "C1", name: "eng", isPrivate: false },
        { channelId: "C2", name: "sekrit", isPrivate: true },
      ],
      [{ channelId: "C2", principalId: ALICE_ID }],
    );

    const alice = await contexts(s.base, ALICE_ID);
    assert.deepEqual(alice.map((c) => c.scopeId).sort(), ["channel:C1", "channel:C2", `personal:${ALICE_ID}`]);
    assert.equal(alice[0]!.kind, "personal", "personal sorts first");
    assert.equal(alice.find((c) => c.scopeId === "channel:C2")!.isPrivate, true);

    const bob = await contexts(s.base, BOB_ID);
    assert.deepEqual(
      bob.map((c) => c.scopeId).sort(),
      ["channel:C1", `personal:${BOB_ID}`],
      "public rooms remain usable without stale-session authority",
    );
  } finally {
    await s.close();
  }
});

test("web turns into a shared scope are membership-checked; sessions then count toward the context", async () => {
  const s = start();
  try {
    const ALICE_ID = await principalOf(s.built, "alice");
    const BOB_ID = await principalOf(s.built, "bob");
    await s.built.app.upsertDirectory([
      { principalId: ALICE_ID, displayName: "Alice", type: "internal" },
      { principalId: BOB_ID, displayName: "Bob", type: "internal" },
    ]);
    await s.built.app.upsertChannels(
      [
        { channelId: "C1", name: "eng", isPrivate: false },
        { channelId: "C2", name: "sekrit", isPrivate: true },
      ],
      [{ channelId: "C2", principalId: ALICE_ID }],
    );

    const aliceOk = await webTurn(s.base, ALICE_ID, {
      kind: "channel",
      threadRef: `web:${ALICE_ID}:t1`,
      channelRef: "C2",
    });
    assert.equal(aliceOk.status, 200);
    const bobNo = await webTurn(s.base, BOB_ID, { kind: "channel", threadRef: `web:${BOB_ID}:t1`, channelRef: "C2" });
    assert.equal(bobNo.status, 403);
    assert.equal(
      (await webTurn(s.base, BOB_ID, { kind: "channel", threadRef: `web:${BOB_ID}:t2`, channelRef: "C1" })).status,
      200,
    );

    assert.equal(
      (await webTurn(s.base, BOB_ID, { kind: "channel", threadRef: `web:${BOB_ID}:t3`, channelRef: "C9" })).status,
      403,
    );
    assert.equal((await webTurn(s.base, BOB_ID, { kind: "group", threadRef: `web:${BOB_ID}:t4` })).status, 403);

    const bob = await contexts(s.base, BOB_ID);
    assert.ok(bob.some((c) => c.scopeId === "channel:C1"));

    const alice = await contexts(s.base, ALICE_ID);
    const c2 = alice.find((c) => c.scopeId === "channel:C2")!;
    assert.equal(c2.sessionCount, 1);
    assert.ok((c2.lastActivityAt ?? 0) > 0);
    const aliceSessions = await s.built.app.listSessions(ALICE_ID);
    const expected = Math.max(
      ...aliceSessions.filter((x) => x.scopeId === "channel:C2").map((x) => x.lastActivityAt ?? x.createdAt),
    );
    assert.equal(
      c2.lastActivityAt,
      expected,
      "context recency is derived from session lastActivityAt, not a separate signal",
    );
  } finally {
    await s.close();
  }
});

test("a web turn carrying fastMode on a non-fast model is accepted; dispatch masks the flag", async () => {
  const s = start();
  try {
    const ALICE_ID = await principalOf(s.built, "alice");
    const res = await fetch(`${s.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "web",
        actor: { externalId: ALICE_ID },
        conversation: { kind: "dm", threadRef: `web:${ALICE_ID}:fast1` },
        text: "hi",
        model: "claude-fable-5",
        fastMode: true,
      }),
    });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test("prior participation never authorizes a shared scope after directory membership is absent", async () => {
  const s = start();
  try {
    const slack = await fetch(`${s.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "slack",
        actor: { externalId: "alice", provider: "slack" as const },
        conversation: { kind: "group", threadRef: "grp:G1:1", channelRef: "G1" },
        text: "hello",
      }),
    });
    assert.equal(slack.status, 200);

    assert.equal(
      (await webTurn(s.base, "alice", { kind: "group", threadRef: "web:alice:g1", channelRef: "G1" })).status,
      403,
    );
    assert.equal(
      (await webTurn(s.base, "bob", { kind: "group", threadRef: "web:bob:g1", channelRef: "G1" })).status,
      403,
    );

    const alice = await contexts(s.base, "alice");
    assert.equal(
      alice.find((c) => c.scopeId === "group:G1"),
      undefined,
    );
  } finally {
    await s.close();
  }
});

test("a web turn can't pair an authorized scope claim with a thread living elsewhere", async () => {
  const s = start();
  try {
    const ALICE_ID = await principalOf(s.built, "alice");
    const CAROL_ID = await principalOf(s.built, "carol");
    await s.built.app.upsertChannels(
      [{ channelId: "C2", name: "sekrit", isPrivate: true }],
      [
        { channelId: "C2", principalId: ALICE_ID },
        { channelId: "C2", principalId: CAROL_ID },
      ],
    );

    assert.equal((await webTurn(s.base, ALICE_ID, { kind: "dm", threadRef: `web:${ALICE_ID}:p1` })).status, 200);
    assert.equal(
      (await webTurn(s.base, ALICE_ID, { kind: "channel", threadRef: `web:${ALICE_ID}:t1`, channelRef: "C2" })).status,
      200,
    );

    assert.equal(
      (await webTurn(s.base, CAROL_ID, { kind: "channel", threadRef: `web:${ALICE_ID}:t1`, channelRef: "C2" })).status,
      200,
    );

    assert.equal((await webTurn(s.base, CAROL_ID, { kind: "dm", threadRef: `web:${ALICE_ID}:t1` })).status, 403);
    assert.equal(
      (await webTurn(s.base, CAROL_ID, { kind: "channel", threadRef: `web:${ALICE_ID}:p1`, channelRef: "C2" })).status,
      403,
    );
    assert.equal(
      (await webTurn(s.base, ALICE_ID, { kind: "channel", threadRef: `web:${ALICE_ID}:p1`, channelRef: "C2" })).status,
      403,
    );

    assert.equal(
      (await webTurn(s.base, CAROL_ID, { kind: "channel", threadRef: `web:${ALICE_ID}:default`, channelRef: "C2" }))
        .status,
      403,
    );
    assert.equal((await webTurn(s.base, ALICE_ID, { kind: "dm", threadRef: `web:${ALICE_ID}:default` })).status, 200);
  } finally {
    await s.close();
  }
});

test("directory push stores the workspace URL; /v1/directory/meta serves it", async () => {
  const s = start();
  try {
    const before = await fetch(`${s.base}/v1/directory/meta`);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { workspaceUrl: null });

    const push = await fetch(`${s.base}/v1/directory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        members: [{ principalId: "alice", displayName: "Alice", type: "internal" }],
        workspaceUrl: "https://acme.slack.com/",
      }),
    });
    assert.equal(push.status, 200);

    const after = (await (await fetch(`${s.base}/v1/directory/meta`)).json()) as { workspaceUrl: string | null };
    assert.equal(after.workspaceUrl, "https://acme.slack.com", "stored normalized, trailing slash dropped");
  } finally {
    await s.close();
  }
});
