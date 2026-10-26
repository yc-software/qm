import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxRoutes } from "../src/api/routes/inbox.ts";
import { createInboxLedger } from "../src/inbox/ledger.ts";
import { ensureInboxCron } from "../src/inbox/sync-task.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { uiStateId } from "../src/surfaces/ui-state.ts";
import type { PersistedUiState } from "../src/surfaces/ui-state.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { inboxApp } from "./support/inbox-app.ts";

function world(enabled = true, sourceRefresh?: ApiCtx["deps"]["inboxSourceRefresh"]) {
  const { crons, app } = inboxApp();
  const items = createInboxLedger();
  const uiState = createMemoryMap<PersistedUiState>();
  const defaults = async (owner = "alice") => [
    await ensureInboxCron(crons, owner, "gmail"),
    await ensureInboxCron(crons, owner, "slack"),
  ];
  const call = async (method = "GET", body: unknown = null, query = "", actor = "alice") => {
    let status = 0;
    let data: any;
    await inboxRoutes
      .find((route) => "method" in route && route.method === method)!
      .handle({
        method,
        body,
        url: new URL(`http://local/v1/inbox?${query}`),
        actor: { p: actor },
        capability: null,
        deps: {
          inbox: { items, record: async () => {} },
          uiState,
          inboxSourceRefresh: sourceRefresh,
          featureFlags: { enabled: async () => enabled },
        },
        app,
        res: {
          getHeader: () => undefined,
          writeHead: (value: number) => {
            status = value;
          },
          end: (value: string) => {
            data = JSON.parse(value);
          },
        },
      } as unknown as ApiCtx);
    return { status, data };
  };
  return { crons, items, uiState, defaults, call };
}

test("default inboxes are distinct, stable, and deliberate empty selections survive refresh", async () => {
  const w = world();
  const first = await w.call();
  assert.deepEqual(
    first.data.selected.map((cron: any) => cron.name),
    ["Email", "Slack"],
  );
  assert.notEqual(first.data.selected[0].id, first.data.selected[1].id);
  await w.call();
  assert.equal((await w.crons.list()).length, 2);
  assert.equal((await w.call("PUT", { cronIds: [] })).status, 200);
  assert.deepEqual((await w.call()).data.selected, []);
});

test("selection reuses original items, counts items, omits heavy fields, and enforces access", async () => {
  const w = world();
  const cron = await w.crons.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: "personal:alice",
    schedule: { everyMs: 3_600_000 },
    title: "QM error repairs",
    action: "Repair",
    inbox: {},
  });
  await w.items.ingest([
    {
      cronId: cron.id,
      dedupeKey: "error-1",
      source: "gmail",
      sourcePayload: { title: "Repair timeout" },
      proposal: { data: { body: "large proposal" }, by: "agent" },
    },
  ]);
  const [item] = await w.items.byCron(cron.id);
  const selected = await w.call("PUT", { cronIds: [cron.id] });
  assert.equal(selected.data.total, 1);
  assert.equal(selected.data.selected[0].name, "QM error repairs");
  assert.deepEqual(selected.data.selected[0].sources, ["gmail"]);
  assert.equal(selected.data.available.find((entry: any) => entry.id === cron.id).selected, true);
  assert.equal(selected.data.items[0].id, item!.id);
  assert.equal(selected.data.items[0].proposal, undefined);
  const detail = await w.call("GET", null, `itemId=${item!.id}`);
  assert.equal(detail.data.item.proposal.data.body, "large proposal");
  await w.call("PUT", { cronIds: [] });
  assert.equal((await w.crons.get(cron.id))!.enabled, true);
  assert.equal((await w.call("PUT", { cronIds: [cron.id] })).data.total, 1);
  assert.equal((await w.call("PUT", { cronIds: [cron.id] }, "", "mallory")).status, 403);
  assert.equal((await w.call("GET", null, `itemId=${item!.id}`, "mallory")).status, 404);
});

test("pagination is stable across equal timestamps and counts exceed the loaded page", async () => {
  const w = world();
  const [cron] = await w.defaults();
  for (let n = 0; n < 65; n++)
    await w.items.ingest([
      {
        cronId: cron!.id,
        dedupeKey: String(n),
        sourcePayload: { title: String(n) },
        proposal: { data: {}, by: "agent" },
      },
    ]);
  const first = (await w.call()).data;
  const second = (await w.call("GET", null, `cursor=${first.nextCursor}`)).data;
  assert.equal(first.total, 65);
  assert.equal(first.items.length, 40);
  assert.equal(second.items.length, 25);
  assert.equal(new Set([...first.items, ...second.items].map((item: any) => item.id)).size, 65);
});

test("disabled rollout cannot create defaults or update selection", async () => {
  const w = world(false, async () => assert.fail("disabled Inbox must not refresh sources"));
  for (const method of ["GET", "PUT"]) assert.equal((await w.call(method, { cronIds: [] })).status, 403);
  assert.equal((await w.crons.list()).length, 0);
  assert.equal(await w.uiState.get(uiStateId("alice", "inbox-crons")), null);
});

test("Sent chat items stay out of Inbox counts and handled history remains readable", async () => {
  const w = world();
  const [cron] = await w.defaults();
  await w.items.ingest([
    {
      cronId: cron!.id,
      dedupeKey: "sent",
      source: "gmail",
      sourcePayload: { sentChat: true },
      proposal: { by: "human", data: { body: "" } },
    },
    {
      cronId: cron!.id,
      dedupeKey: "dismissed",
      source: "gmail",
      sourcePayload: { title: "Handled" },
      proposal: { by: "agent", data: { body: "draft" } },
    },
  ]);
  const item = (await w.items.byCron(cron!.id)).find((entry) => entry.sourceKey === "dismissed")!;
  await w.items.recordAction(item.id, { kind: "dismiss", outcome: "dismissed" });
  assert.equal((await w.call()).data.total, 0);
  assert.deepEqual((await w.call()).data.items, []);
  const handled = await w.call("GET", null, "view=handled");
  assert.deepEqual(
    handled.data.items.map((entry: any) => entry.id),
    [item.id],
  );
});

test("the inbox feed reconciles selected owner Gmail inboxes before counting summaries", async () => {
  const refreshed: string[] = [];
  const w = world(true, async (owner, items) => {
    assert.equal(owner, "alice");
    for (const item of items) {
      refreshed.push(item.id);
      await w.items.recordAction(item.id, { kind: "replied", outcome: "dismissed" });
    }
  });
  const mail = (await w.defaults())[0]!;
  await w.items.ingest([
    {
      cronId: mail.id,
      dedupeKey: "waiting",
      source: "gmail",
      sourceAt: 1000,
      sourcePayload: { gmail: { threadId: "t1" } },
      proposal: { by: "agent", data: { body: "Draft" } },
    },
  ]);
  const item = (await w.items.byCron(mail.id))[0]!;
  const feed = await w.call();
  assert.deepEqual(refreshed, [item.id]);
  assert.equal(feed.data.total, 0);
  assert.deepEqual(feed.data.items, []);
  refreshed.length = 0;
  await w.call("PUT", { cronIds: [] });
  await w.call();
  assert.deepEqual(refreshed, []);
});

test("email filters leave Slack unchanged while source counts include all open conversations", async () => {
  const w = world();
  const [email, slack] = await w.defaults();
  for (const [key, payload, draft] of [
    ["question", {}, true],
    ["thanks", { probablyResolved: true }, true],
    ["receipt", { automated: true }, true],
    ["pending", {}, false],
    ["handled", {}, true],
  ] as const) {
    await w.items.ingest([
      {
        cronId: email!.id,
        dedupeKey: key,
        source: "gmail",
        sourcePayload: { title: key, ...payload },
        ...(draft ? { proposal: { by: "agent" as const, data: { body: "Draft" } } } : {}),
      },
    ]);
  }
  const handled = (await w.items.byCron(email!.id)).find((item) => item.sourceKey === "handled")!;
  await w.items.recordAction(handled.id, { kind: "dismiss", outcome: "dismissed" });
  await w.items.ingest([
    { cronId: slack!.id, dedupeKey: "slack-pending", source: "slack", sourcePayload: {} },
    ...(
      [
        ["slack-question", {}],
        ["slack-resolved", { probablyResolved: true }],
        ["slack-bot", { automated: true }],
      ] as const
    ).map(([key, payload]) => ({
      cronId: slack!.id,
      dedupeKey: String(key),
      source: "slack",
      sourcePayload: payload,
      proposal: { by: "agent" as const, data: { body: "Draft" } },
    })),
  ]);
  const keys = (feed: any) => feed.items.map((item: any) => item.dedupeKey).sort();
  const initial = (await w.call()).data;
  assert.equal(initial.filter, "human");
  assert.deepEqual(keys(initial), ["pending", "question", "slack-bot", "slack-question", "slack-resolved", "thanks"]);
  const triaged = (await w.call("GET", null, "filter=triaged")).data;
  assert.equal(triaged.filter, "triaged");
  assert.deepEqual(keys(triaged), ["question", "slack-bot", "slack-question", "slack-resolved"]);
  assert.equal(triaged.total, 8);
  const sourceCounts = (feed: any) => feed.selected.map((cron: any) => [cron.id, cron.count]);
  assert.deepEqual(sourceCounts(triaged), [
    [email!.id, 4],
    [slack!.id, 4],
  ]);
  for (const [filter, expected] of [
    ["triaged", ["question", "slack-bot", "slack-question", "slack-resolved"]],
    ["human", ["pending", "question", "slack-bot", "slack-question", "slack-resolved", "thanks"]],
    ["all", ["pending", "question", "receipt", "slack-bot", "slack-question", "slack-resolved", "thanks"]],
  ] as const) {
    await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: filter, updatedAt: Date.now() });
    const feed = (await w.call()).data;
    assert.equal(feed.filter, filter);
    assert.deepEqual(keys(feed), expected);
    assert.equal(feed.total, 8);
    assert.deepEqual(sourceCounts(feed), sourceCounts(triaged));
    assert.equal(
      feed.selected.reduce((sum: number, cron: any) => sum + cron.count, 0),
      8,
    );
    assert.deepEqual(keys((await w.call("GET", null, `cronId=${slack!.id}`)).data), [
      "slack-bot",
      "slack-question",
      "slack-resolved",
    ]);
    assert.deepEqual(keys((await w.call("GET", null, "view=handled")).data), ["handled"]);
    assert.deepEqual(
      keys((await w.call("GET", null, `cronId=${email!.id}`)).data),
      expected.filter((key) => !key.startsWith("slack-")),
    );
    assert.equal((await w.call("GET", null, "", "mallory")).data.filter, "human");
  }
  const receipt = (await w.call()).data.items.find((item: any) => item.dedupeKey === "receipt");
  assert.equal(receipt.sourcePayload.automated, true);
  assert.equal(receipt.state, "held");
  assert.equal(receipt.proposal, undefined);
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "invalid", updatedAt: Date.now() });
  assert.equal((await w.call()).data.filter, "human");
  const question = (await w.items.byCron(email!.id)).find((item) => item.sourceKey === "question")!;
  await w.items.recordAction(question.id, { kind: "dismiss", outcome: "dismissed" });
  const afterDismiss = (await w.call()).data;
  assert.equal(afterDismiss.total, 7);
  assert.deepEqual(sourceCounts(afterDismiss), [
    [email!.id, 3],
    [slack!.id, 4],
  ]);
});

test("inbox filters apply before pagination even when automated messages fill multiple pages", async () => {
  const w = world();
  const [cron] = await w.defaults();
  for (let n = 0; n < 85; n++) {
    await w.items.ingest([
      {
        cronId: cron!.id,
        dedupeKey: String(n),
        source: "gmail",
        sourcePayload: { automated: n >= 5 },
        proposal: { by: "agent", data: { body: "Draft" } },
      },
    ]);
  }
  const triaged = (await w.call("GET", null, "filter=triaged")).data;
  assert.equal(triaged.total, 85);
  assert.equal(triaged.items.length, 5);
  assert.equal(triaged.nextCursor, null);
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "all", updatedAt: Date.now() });
  const first = (await w.call()).data;
  const second = (await w.call("GET", null, `cursor=${first.nextCursor}`)).data;
  const third = (await w.call("GET", null, `cursor=${second.nextCursor}`)).data;
  assert.equal(first.total, 85);
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [40, 40, 5]);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map((item: any) => item.id)).size, 85);
});

test("explicit refresh filters stay consistent across saved preference changes without overwriting them", async () => {
  const w = world();
  const [cron] = await w.defaults();
  await w.items.ingest([
    { cronId: cron!.id, dedupeKey: "receipt", source: "gmail", sourcePayload: { automated: true } },
    { cronId: cron!.id, dedupeKey: "question", source: "gmail", sourcePayload: { automated: false } },
  ]);
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "all", updatedAt: Date.now() });
  const first = (await w.call()).data;
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "human", updatedAt: Date.now() + 1 });
  const pinned = (await w.call("GET", null, `filter=${first.filter}`)).data;
  assert.equal(pinned.filter, "all");
  assert.equal(pinned.total, 2);
  assert.equal(pinned.items.length, 2);
  const latest = (await w.call()).data;
  assert.equal(latest.filter, "human");
  assert.equal(latest.total, 2);
  assert.equal(latest.items.length, 1);
  assert.equal((await w.call("GET", null, "filter=invalid")).status, 400);
});

test("source metadata survives an empty filtered email view", async () => {
  const w = world();
  const [cron] = await w.defaults();
  await w.items.ingest([
    { cronId: cron!.id, dedupeKey: "receipt", source: "gmail", sourcePayload: { automated: true } },
  ]);
  await w.call("PUT", { cronIds: [cron!.id] });
  const feed = (await w.call()).data;
  assert.equal(feed.items.length, 0);
  assert.deepEqual(feed.selected[0].sources, ["gmail"]);
});

test("email classification is projected only by the flagged inbox endpoint", async (t) => {
  const w = world();
  const [cron] = await w.defaults();
  await w.items.ingest([
    {
      cronId: cron!.id,
      dedupeKey: "receipt",
      source: "gmail",
      sourcePayload: { automated: true, privateDetail: "hidden" },
    },
  ]);
  const [before] = await w.items.summaries([cron!.id]);
  assert.equal(before!.inboxPreview!.automated, undefined);
  const feed = (await w.call("GET", null, "filter=all")).data;
  assert.equal(feed.items[0].sourcePayload.automated, true);
  assert.equal(feed.items[0].sourcePayload.privateDetail, undefined);
  assert.deepEqual((await w.items.summaries([cron!.id]))[0], before);
  const disabled = world(false);
  t.mock.method(disabled.items, "byCron", async () => {
    assert.fail("flag-disabled inbox read payloads");
  });
  t.mock.method(disabled.items, "summaries", async () => {
    assert.fail("flag-disabled inbox read summaries");
  });
  for (const filter of ["all", "human", "triaged"]) {
    assert.equal((await disabled.call("GET", null, `filter=${filter}`)).status, 403);
  }
});

test("inbox viewers are exactly the active candidates who can administer the cron, including shared group scopes and aliases", async (t) => {
  const { crons, app } = inboxApp();
  const base = { owner: "alice", createdBy: "alice", schedule: { everyMs: 3_600_000 }, inbox: {} };
  const personal = await crons.create({ ...base, ownerScopeId: "personal:alice" });
  const group = await crons.create({ ...base, ownerScopeId: "group:core" });
  const grants = new Set(["bob"]);
  const members = new Set(["alice", "bob", "carol"]);
  const route = inboxRoutes.find((r) => "path" in r && r.path === "/v1/inbox/viewers")!;
  const ask = async (body: unknown, capability: unknown = null) => {
    let status = 0;
    let data: any;
    await route.handle({
      method: "POST",
      body,
      url: new URL("http://local/v1/inbox/viewers"),
      capability,
      deps: {
        identity: {
          refresh: async () => {},
          classify: (id: string) => ({ id, type: id === "carol" ? "deactivated" : "internal" }),
        },
      },
      app: {
        ...app,
        membershipControlsScope: async (scope: string) => scope.startsWith("group:"),
        managesScope: async (who: string, scope: string) => scope === "group:core" && members.has(who),
        artifactGrantPermission: async (_scope: string, _ref: string, who: string) =>
          grants.has(who) ? "write" : null,
      },
      res: {
        getHeader: () => undefined,
        writeHead: (value: number) => {
          status = value;
        },
        end: (value: string) => {
          data = JSON.parse(value);
        },
      },
    } as unknown as ApiCtx);
    return { status, data };
  };
  const candidates = ["alice", "bob-slack", "carol", "mallory"];
  installPrincipalLinks({ canonical: (key) => (key === "bob-slack" ? "bob" : undefined), aliases: () => [] });
  t.after(() => installPrincipalLinks(null));
  assert.deepEqual((await ask({ cronId: personal.id, candidates })).data.viewers, ["alice"]);
  assert.deepEqual((await ask({ cronId: group.id, candidates })).data.viewers, ["alice", "bob-slack"]);
  members.delete("alice");
  assert.deepEqual((await ask({ cronId: group.id, candidates })).data.viewers, ["bob-slack"]);
  assert.equal((await ask({ cronId: "missing", candidates })).status, 404);
  assert.equal((await ask({ cronId: group.id, candidates }, { actorId: "mallory" })).status, 403);
});

test("the visible Slack feed includes fresh and cached avatars without returning message context", async () => {
  const calls: string[][] = [];
  const w = world(true, async (owner, items, mode) => {
    if (mode !== "avatars") return;
    assert.equal(owner, "alice");
    calls.push(items.map((item) => item.id));
    for (const item of items)
      await w.items.annotate(item.id, {
        participants: [{ id: "U1", name: "Alex", avatarUrl: "https://avatars.slack-edge.com/alex.png" }],
        slackAvatarsRefreshAt: Date.now() + 86_400_000,
      });
  });
  const [, slack] = await w.defaults();
  await w.items.ingest(
    Array.from({ length: 45 }, (_, n) => ({
      cronId: slack!.id,
      dedupeKey: `slack-${n}`,
      source: "slack",
      sourceAt: 1000 + n,
      sourcePayload: {
        from: "Alex",
        slack: { channelId: "D1", ts: `${n}.0`, userId: "U1" },
        context: [{ author: "Alex", text: "private context" }],
      },
      proposal: { by: "agent" as const, data: { body: "draft" } },
    })),
  );
  const feed = await w.call();
  assert.equal(feed.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.length, 40);
  assert.equal(feed.data.items.length, 40);
  assert.deepEqual(new Set(calls[0]), new Set(feed.data.items.map((item: any) => item.id)));
  assert.equal(feed.data.items[0].sourcePayload.participants[0].avatarUrl, "https://avatars.slack-edge.com/alex.png");
  assert.equal(feed.data.items[0].sourcePayload.context, undefined);
  assert.equal(feed.data.items[0].sourcePayload.slack, undefined);
  await w.call("GET", null, `itemId=${feed.data.items[0].id}`);
  assert.equal(calls.length, 1);
  const get = w.items.get.bind(w.items);
  let fullReads = 0;
  w.items.get = async (id) => {
    fullReads++;
    return get(id);
  };
  const cachedFeed = await w.call();
  assert.equal(
    cachedFeed.data.items[0].sourcePayload.participants[0].avatarUrl,
    "https://avatars.slack-edge.com/alex.png",
  );
  assert.equal(fullReads, 0);
  assert.deepEqual(calls.at(-1), []);
});
