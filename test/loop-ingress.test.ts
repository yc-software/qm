import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { createLoopIngress, type LoopIngress, type IngressDelivery } from "../src/loops/ingress.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createGmailPushClient, type GmailCursor } from "../src/loops/gmail-push.ts";
import { loopIngressRoutes } from "../src/api/routes/loop-ingress.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

async function world() {
  const sources = createMemoryMap<LoopIngress>();
  const deliveries = createMemoryMap<IngressDelivery>();
  const loops = createLoopStore();
  const items = createLoopItemLedger();
  const { loop } = await loops.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: "personal:alice",
    name: "Event review",
    playbook: "Review",
    successCondition: "Reviewed",
  });
  const fires: string[] = [];
  const deps = {
    enabledFor: async () => true,
    sources,
    deliveries,
    loops,
    items,
    outputs: createLoopOutputStore(),
    lock: createMemoryAdvisoryLock(),
    fire: {
      fire: async (
        loopId: string,
        _fireKey: string,
        _cronId: string | undefined,
        options?: { enumerate?: boolean },
      ) => {
        assert.equal(options?.enumerate, false);
        fires.push(loopId);
        for (const item of await items.queued(loopId))
          await items.recordAction(item.id, { kind: "reviewed", outcome: "dismissed" });
        return { status: "ok" as const };
      },
    },
  };
  return { ...deps, loop, fires, deps, ingress: createLoopIngress(deps) };
}

function request(kind: "slack" | "webhook", secret: string, payload: unknown) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    rawBody,
    headers:
      kind === "slack"
        ? {
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
          }
        : { "x-signature": createHmac("sha256", secret).update(rawBody).digest("hex") },
  };
}

test("signed webhooks persist before ack, survive restart, deduplicate, and bypass enumeration", async () => {
  const w = await world();
  const source = await w.ingress.create(w.loop, { kind: "webhook" });
  const req = request("webhook", source.secret!, { title: "New ticket", text: "Review this" });
  assert.equal((await w.ingress.receive(source.id, req)).status, 202);
  assert.equal((await w.deliveries.all()).length, 1);
  assert.equal(w.fires.length, 0);
  const restarted = createLoopIngress(w.deps);
  await restarted.receive(source.id, req);
  await restarted.process(source.id);
  assert.equal(w.fires.length, 1);
  const [item] = await w.items.byLoop(w.loop.id);
  assert.deepEqual(item?.sourcePayload?.event, { title: "New ticket", text: "Review this" });
  assert.ok((await w.deliveries.all())[0]?.completedAt);
  await restarted.receive(source.id, req);
  await restarted.process(source.id);
  assert.equal(w.fires.length, 1);
  assert.equal("secret" in (await restarted.list(w.loop.id))[0]!, false);
});

test("invalid signatures and oversized events never enter the queue", async () => {
  const w = await world();
  const source = await w.ingress.create(w.loop, { kind: "webhook" });
  assert.equal((await w.ingress.receive(source.id, request("webhook", "wrong", { title: "x" }))).status, 401);
  assert.equal(
    (await w.ingress.receive(source.id, request("webhook", source.secret!, { text: "x".repeat(65_000) }))).status,
    413,
  );
  assert.equal((await w.deliveries.all()).length, 0);
});

test("paused Loops retain queued deliveries, and disabling stops ingress", async () => {
  const w = await world();
  const source = await w.ingress.create(w.loop, { kind: "webhook" });
  const req = request("webhook", source.secret!, { title: "Hold" });
  await w.loops.setState(w.loop.id, "paused");
  await w.ingress.receive(source.id, req);
  await w.ingress.process(source.id);
  assert.equal(w.fires.length, 0);
  await w.loops.setState(w.loop.id, "enabled");
  await w.ingress.process(source.id);
  assert.equal(w.fires.length, 1);
  await w.ingress.setEnabled(w.loop.id, source.id, false);
  assert.equal((await w.ingress.receive(source.id, req)).status, 404);
});

test("Slack validates signatures, challenge, workspace, channels, bot exclusion and event retries", async () => {
  const w = await world();
  const source = await w.ingress.create(w.loop, {
    kind: "slack",
    secret: "slack-secret",
    teamId: "T123",
    channels: ["C123"],
  });
  const challenge = await w.ingress.receive(
    source.id,
    request("slack", source.secret!, { type: "url_verification", challenge: "challenge" }),
  );
  assert.deepEqual(challenge, { status: 200, body: "challenge" });
  const event = {
    team_id: "T123",
    event_id: "Ev1",
    event: {
      type: "message",
      channel: "C123",
      user: "U123",
      text: "Please review",
      ts: "1750000000.001",
      thread_ts: "1740000000.001",
    },
  };
  for (const payload of [
    { ...event, team_id: "T999" },
    { ...event, event: { ...event.event, channel: "C999" } },
    { ...event, event: { ...event.event, bot_id: "B123" } },
  ])
    assert.equal((await w.ingress.receive(source.id, request("slack", source.secret!, payload))).body, "Skipped");
  assert.equal((await w.deliveries.all()).length, 0);
  await w.ingress.receive(source.id, request("slack", source.secret!, event));
  await w.ingress.receive(source.id, request("slack", source.secret!, event));
  await w.ingress.process(source.id);
  const items = await w.items.byLoop(w.loop.id);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.sourceKey, "C123:1740000000.001");
  assert.equal(items[0]?.source, "slack");
  assert.equal(items[0]?.sourcePayload?.context, undefined);
  assert.equal(items[0]?.sourcePayload?.snippet, event.event.text);
});

test("concurrent workers only fire a durable event once", async () => {
  const w = await world();
  const source = await w.ingress.create(w.loop, { kind: "webhook" });
  await w.ingress.receive(source.id, request("webhook", source.secret!, { title: "x" }));
  await Promise.all([w.ingress.process(source.id), createLoopIngress(w.deps).process(source.id)]);
  assert.equal(w.fires.length, 1);
});

test("failed processing retains the event and exposes an error for retry", async () => {
  const w = await world();
  const ingress = createLoopIngress({
    ...w.deps,
    fire: { fire: async () => ({ status: "failed", note: "Unavailable" }) },
  });
  const source = await ingress.create(w.loop, { kind: "webhook" });
  await ingress.receive(source.id, request("webhook", source.secret!, { title: "x" }));
  await ingress.process(source.id);
  const [delivery] = await w.deliveries.all();
  assert.ok(delivery?.completedAt);
  assert.equal(delivery?.ingested, true);
  assert.equal((await w.sources.get(source.id))?.lastError, "Unavailable");
  await w.sources.merge(source.id, { nextWorkAt: 0 });
  await w.ingress.process(source.id);
  assert.ok((await w.deliveries.get(delivery!.id))?.completedAt);
  assert.equal((await w.items.byLoop(w.loop.id)).length, 1);
});

const gmailConfig = {
  topic: "projects/test/topics/gmail",
  audience: "https://example.com/v1/loop-ingress/gmail",
  serviceAccount: "push@test.iam.gserviceaccount.com",
};

test("Gmail routes verified mailbox notifications and retains cursor across renewal", async () => {
  const w = await world();
  let cursor: GmailCursor = { email: "alice@example.com", historyId: "10", expiresAt: Date.now() + 100_000 };
  let changes = 0;
  const ingress = createLoopIngress({
    ...w.deps,
    gmailConfig,
    verifyGoogle: async (auth) => auth === "Bearer trusted",
    gmailClient: {
      watch: async () => cursor,
      changes: async () => {
        changes++;
        return "20";
      },
    },
  });
  const source = await ingress.create(w.loop, { kind: "gmail" });
  const notification = (emailAddress: string, historyId: string) => ({
    rawBody: JSON.stringify({
      message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId })).toString("base64") },
    }),
    headers: { authorization: "Bearer trusted" },
  });
  assert.equal(
    (await ingress.receive("gmail", { ...notification("alice@example.com", "20"), headers: {} })).status,
    401,
  );
  await ingress.receive("gmail", notification("other@example.com", "20"));
  assert.equal((await w.deliveries.all()).length, 0);
  await ingress.receive("gmail", notification("alice@example.com", "20"));
  await w.sources.merge(source.id, { nextWorkAt: 0 });
  await ingress.process(source.id);
  assert.equal(changes, 1);
  assert.equal((await w.sources.get(source.id))?.gmail?.historyId, "20");
  await ingress.receive("gmail", notification("alice@example.com", "11"));
  await w.sources.merge(source.id, { nextWorkAt: 0 });
  await ingress.process(source.id);
  assert.equal(changes, 1);
  cursor = { ...cursor, historyId: "30" };
  await w.sources.merge(source.id, { nextWatchAt: 0 });
  await ingress.maintain();
  assert.equal((await w.sources.get(source.id))?.gmail?.historyId, "20");
});

test("Gmail is opt in, personal-only, and never uses a company credential", async () => {
  const w = await world();
  await assert.rejects(w.ingress.create(w.loop, { kind: "gmail" }), /administrator/);
  const accounts: Array<string | undefined> = [];
  const client = createGmailPushClient(
    {
      connectorAccessToken: async (_host, _owner, accountType) => {
        accounts.push(accountType);
        return null;
      },
    },
    gmailConfig,
  );
  await assert.rejects(client.watch("alice"), /personal Gmail/);
  assert.deepEqual(accounts, ["personal"]);
  await assert.rejects(w.ingress.create({ ...w.loop, ownerScopeId: "channel:C1" }, { kind: "gmail" }), /personal Loop/);
});

test("Gmail history pagination advances only after durable ingestion, and expired cursors resync", async () => {
  const visited: string[] = [];
  const entries: unknown[] = [];
  let expired = false;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    visited.push(url.pathname + url.search);
    if (url.pathname.endsWith("profile")) return Response.json({ emailAddress: "alice@example.com", historyId: "100" });
    if (url.pathname.endsWith("history")) {
      if (expired) return new Response("", { status: 404 });
      return Response.json(
        url.searchParams.has("pageToken")
          ? { historyId: "101", history: [{ labelsAdded: [{ labelIds: ["INBOX"], message: { id: "m2" } }] }] }
          : { historyId: "101", nextPageToken: "next", history: [{ messagesAdded: [{ message: { id: "m1" } }] }] },
      );
    }
    if (url.pathname.endsWith("messages")) return Response.json({ messages: [{ id: "m3" }] });
    const id = url.pathname.split("/").at(-1);
    return Response.json({
      id,
      threadId: `thread-${id}`,
      internalDate: "1000",
      labelIds: ["INBOX"],
      snippet: "Hello",
      payload: {
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "Message-ID", value: "<original>" },
        ],
      },
    });
  };
  const client = createGmailPushClient({ connectorAccessToken: async () => "token" }, gmailConfig, fetchImpl);
  const cursor = { email: "alice@example.com", historyId: "1", expiresAt: 1 };
  assert.equal(
    await client.changes("alice", "loop", cursor, async (batch) => {
      entries.push(...batch);
    }),
    "101",
  );
  assert.equal(entries.length, 2);
  assert.ok(visited.some((path) => path.includes("pageToken=next")));
  await assert.rejects(
    client.changes("alice", "loop", cursor, async () => {
      throw new Error("DB unavailable");
    }),
    /DB unavailable/,
  );
  expired = true;
  assert.equal(
    await client.changes("alice", "loop", cursor, async (batch) => {
      entries.push(...batch);
    }),
    "100",
  );
  assert.equal((entries.at(-1) as any).sourcePayload.gmail.rfcMessageId, "<original>");
});

test("ingestion configuration rejects nonowners and unattended callers", async () => {
  const w = await world();
  const route = loopIngressRoutes.find((route) => "method" in route && route.method === "POST")!;
  for (const [actor, expected] of [
    ["mallory", 403],
    [null, 403],
  ] as const) {
    let status = 0;
    await route.handle({
      params: { id: w.loop.id },
      url: new URL("http://local?principalId=alice"),
      actor: actor ? { p: actor } : null,
      capability: null,
      body: { kind: "webhook" },
      deps: { loops: { store: w.loops }, loopIngress: w.ingress, featureFlags: { enabled: async () => true } },
      app: {
        samePerson: async (a: string, b: string) => a === b,
        membershipControlsScope: async () => false,
        managesScope: async () => false,
      },
      res: {
        writeHead: (value: number) => {
          status = value;
        },
        end: () => {},
      },
    } as unknown as ApiCtx);
    assert.equal(status, expected);
  }
  assert.equal((await w.sources.all()).length, 0);
});

test("new conversation input supersedes held outputs and preserves an edited draft", async () => {
  const w = await world();
  const source = await w.ingress.create(w.loop, {
    kind: "slack",
    secret: "secret",
    teamId: "T123",
    channels: ["C123"],
  });
  const { item } = await w.items.enqueue({ loopId: w.loop.id, sourceKey: "C123:1000.001" });
  const claimed = await w.items.claim(item.id);
  const output = await w.outputs.capture({
    loopId: w.loop.id,
    itemId: item.id,
    attemptId: "old",
    shipAction: "send",
    title: "Old draft",
    capturedBy: "agent",
  });
  await w.outputs.promoteAttempt(item.id, "old");
  await w.items.markReady(item.id, [output.id], claimed!.claimToken!);
  await w.items.setProposal(item.id, { by: "human", data: { body: "My edit" } });
  const payload = {
    team_id: "T123",
    event_id: "Ev-new",
    event: {
      type: "message",
      channel: "C123",
      user: "U123",
      text: "Changed requirements",
      ts: "1001.001",
      thread_ts: "1000.001",
    },
  };
  const ingress = createLoopIngress({ ...w.deps, fire: { fire: async () => ({ status: "ok" }) } });
  await ingress.receive(source.id, request("slack", source.secret!, payload));
  await ingress.process(source.id);
  const refreshed = await w.items.get(item.id);
  assert.equal(refreshed?.status, "queued");
  assert.equal(refreshed?.proposal, undefined);
  assert.deepEqual(refreshed?.outputIds, []);
  assert.match(refreshed?.thread?.at(-1)?.text ?? "", /My edit/);
  assert.equal((await w.outputs.get(output.id))?.state, "superseded");
});

test("expired claims and returned work drain without any new webhook delivery", async () => {
  const w = await world();
  const source = await w.ingress.create(w.loop, { kind: "webhook" });
  const { item } = await w.items.enqueue({ loopId: w.loop.id, sourceKey: "interrupted" });
  const claimed = await w.items.claim(item.id, Date.now() - 700_000);
  assert.ok(claimed);
  await w.ingress.process(source.id);
  assert.equal(w.fires.length, 1);
  assert.equal((await w.items.get(item.id))?.status, "skipped");
  const second = await w.items.enqueue({ loopId: w.loop.id, sourceKey: "returned" });
  const c = await w.items.claim(second.item.id);
  await w.items.markReady(second.item.id, [], c!.claimToken!);
  await w.items.returnToWork(second.item.id, "Please revise");
  await w.sources.merge(source.id, { nextWorkAt: 0 });
  await createLoopIngress(w.deps).process(source.id);
  assert.equal(w.fires.length, 2);
});

test("model work does not hold the intake lock needed by its HTTP callbacks", async () => {
  const w = await world();
  const source = await w.ingress.create(w.loop, { kind: "webhook" });
  await w.ingress.receive(source.id, request("webhook", source.secret!, { title: "Work" }));
  let acquired = false;
  const ingress = createLoopIngress({
    ...w.deps,
    fire: {
      fire: async () => {
        const result = await w.lock.tryWithLock!(`loop-intake:${w.loop.id}`, async () => {
          acquired = true;
          return true;
        });
        assert.equal(result, true);
        return { status: "ok" };
      },
    },
  });
  await ingress.process(source.id);
  assert.equal(acquired, true);
});

test("revoking rollout blocks new deliveries and processing already queued work", async () => {
  const w = await world();
  const source = await w.ingress.create(w.loop, { kind: "webhook" });
  const req = request("webhook", source.secret!, { title: "queued" });
  await w.ingress.receive(source.id, req);
  const denied = createLoopIngress({ ...w.deps, enabledFor: async () => false });
  assert.equal((await denied.receive(source.id, req)).status, 404);
  await denied.process(source.id);
  await denied.maintain();
  assert.equal(w.fires.length, 0);
  assert.equal((await w.items.byLoop(w.loop.id)).length, 0);
  await assert.rejects(denied.create(w.loop, { kind: "webhook" }), /not enabled/);
  await denied.setEnabled(w.loop.id, source.id, false);
  await assert.rejects(denied.setEnabled(w.loop.id, source.id, true), /not enabled/);
});
