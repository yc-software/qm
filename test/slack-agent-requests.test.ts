import { test } from "node:test";
import assert from "node:assert/strict";
import { createThreadTracker } from "../src/slack/lib.ts";
import { agentRequestMessage } from "../src/slack/agent-requests.ts";
import { createApprovals } from "../src/slack/approvals.ts";
import { createTurnFlow } from "../src/slack/turn-flow.ts";
import {
  createAgentRequestStore,
  type SlackAgentRequestContext,
  type SlackCoreClient,
} from "../src/api/slack-core-client.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { TurnResult } from "../src/types.ts";
import { extractReactions } from "../src/slack/reactions.ts";

test("agentRequestMessage builds a personal-agent approval prompt", () => {
  const msg = agentRequestMessage({
    requestId: "agent-req-1",
    originAgentLabel: "#project-alpha agent",
    targetAgentLabel: "Carol's personal agent",
    task: "Check whether browse-agent works with the personal ANTHROPIC_API_KEY, but do not reveal the key.",
  });
  assert.match(msg.text, /asking Carol's personal agent/);
  const section = msg.blocks.find((b: any) => b.type === "section") as any;
  assert.match(section.text.text, /#project-alpha agent → Carol's personal agent/);
  const actions = msg.blocks.find((b: any) => b.type === "actions") as any;
  assert.deepEqual(
    actions.elements.map((e: any) => [e.text.text, e.action_id, e.value]),
    [
      ["Run with my setup", "agent_request_run", "agent-req-1"],
      ["Decline", "agent_request_deny", "agent-req-1"],
    ],
  );
});

const CHANNEL_RUN = {
  request: {
    surface: "slack",
    actor: { id: "una@example.com", type: "internal" },
    conversation: {
      kind: "channel",
      threadRef: "C1:1.1",
      channelRef: "C1",
      channelName: "proj",
      audience: [
        { id: "una@example.com", type: "internal" },
        { id: "carol@example.com", type: "internal" },
      ],
    },
    deliveryTarget: "C1:1.1",
  },
};

function durableFixture(
  opts: { turnResults?: TurnResult[]; coreOverrides?: Record<string, unknown>; actor?: Record<string, unknown> } = {},
) {
  const store = new Map<string, SlackAgentRequestContext>();
  const storedApprovals = new Map<string, unknown>();
  const submitted: any[] = [];
  const turnResults = [...(opts.turnResults ?? [])];
  const core = {
    submitTurn: async (body: any) => {
      submitted.push(body);
      return turnResults.shift() ?? ({ status: "ok", reply: "personal result" } as TurnResult);
    },
    ackRunDelivery: async () => {},
    reportRunEditRef: async () => {},
    getApproval: async (id: string) => storedApprovals.get(id) ?? null,
    putAgentRequest: async (id: string, record: SlackAgentRequestContext) => void store.set(id, record),
    getAgentRequest: async (id: string) => store.get(id) ?? null,
    takeAgentRequest: async (id: string) => {
      const record = store.get(id) ?? null;
      store.delete(id);
      return record;
    },
    getAgentRequestRun: async (runId: string) => (runId === "run-1" ? CHANNEL_RUN : null),
    agentRequestForApproval: async (approvalId: string) => {
      for (const record of store.values()) {
        if (record.approvalRequestIds?.includes(approvalId)) return record;
      }
      return null;
    },
    ...opts.coreOverrides,
  } as unknown as SlackCoreClient;
  const directory = {
    classifyActor: async () => opts.actor ?? { externalId: "carol@example.com", displayName: "Carol" },
    classifyUserCached: async () => ({ actor: { externalId: "carol@example.com", displayName: "Carol" } }),
  } as never;
  const posts: any[] = [];
  const updates: any[] = [];
  const ephemerals: any[] = [];
  let nextTs = 0;
  const client = {
    conversations: { open: async () => ({ channel: { id: "D-CAROL" } }) },
    chat: {
      postMessage: async (body: any) => {
        posts.push(body);
        nextTs += 1;
        return { ok: true, ts: `100.${nextTs}` };
      },
      update: async (body: any) => {
        updates.push(body);
        return { ok: true };
      },
      postEphemeral: async (body: any) => {
        ephemerals.push(body);
        return { ok: true };
      },
    },
  };
  const newInstance = () => {
    const approvals = createApprovals({
      core,
      flow: createTurnFlow(core),
      directory,
      threads: createThreadTracker(),
      ids: {} as never,
    });
    const handlers: Array<{ pattern: RegExp; handler: (args: any) => Promise<void> }> = [];
    approvals.registerActions({ action: (pattern, handler) => void handlers.push({ pattern, handler }) });
    const click = (actionId: string, value: string, click2: { user?: string; ts?: string } = {}) =>
      handlers
        .find((h) => h.pattern.test(actionId))!
        .handler({
          ack: async () => {},
          body: {
            user: { id: click2.user ?? "U2" },
            channel: { id: "D-CAROL" },
            ...(click2.ts ? { message: { ts: click2.ts } } : {}),
          },
          action: { action_id: actionId, value },
          client,
        });
    return { approvals, click };
  };
  const ask = (runId = "run-1") =>
    newInstance().approvals.handoffs.askFromRun(client, { runId, targetUserId: "U2", task: "run the check" });
  const postRequest = async () => {
    const outcome = await ask();
    assert.ok("handoff" in outcome, JSON.stringify(outcome));
    const card = posts.find((p) => p.channel === "D-CAROL");
    const actions = card.blocks.find((b: any) => b.type === "actions");
    return { requestId: String(actions.elements[0].value), cardTs: "100.1", statusTs: "100.2" };
  };
  return { core, store, storedApprovals, submitted, posts, updates, ephemerals, client, newInstance, postRequest, ask };
}

test("asking a personal agent from a channel turn sends the consent DM, posts the status in the thread, and reports success", async () => {
  const f = durableFixture();
  const outcome = await f.ask();
  assert.deepEqual(Object.keys(outcome), ["handoff"]);
  assert.equal((outcome as any).handoff.target, "Carol's personal agent");
  assert.deepEqual(
    f.posts.map((p) => [p.channel, p.thread_ts ?? null]),
    [
      ["D-CAROL", null],
      ["C1", "1.1"],
    ],
  );
  assert.match(String(f.posts[1].text), /#proj agent → Carol's personal agent[\s\S]*Waiting for Carol to approve/);
  assert.equal(f.store.size, 1);
});

test("asking a personal agent is refused without posting anything when the target or conversation doesn't qualify", async () => {
  const cases: Array<[string, Parameters<typeof durableFixture>[0], string]> = [
    ["finished run", {}, "run-gone"],
    ["bot target", { actor: { externalId: "B1", displayName: "Helper", isBot: true } }, "run-1"],
    ["outsider", { actor: { externalId: "dave@example.com", displayName: "Dave" } }, "run-1"],
    ["guest", { actor: { externalId: "carol@example.com", displayName: "Carol", isExternalGuest: true } }, "run-1"],
  ];
  for (const kind of ["dm", "group"]) {
    cases.push([
      kind,
      {
        coreOverrides: {
          getAgentRequestRun: async () => ({
            request: { ...CHANNEL_RUN.request, conversation: { ...CHANNEL_RUN.request.conversation, kind } },
          }),
        },
      },
      "run-1",
    ]);
  }
  cases.push([
    "external",
    {
      coreOverrides: {
        getAgentRequestRun: async () => ({ request: { ...CHANNEL_RUN.request, externalSlack: { teamId: "T2" } } }),
      },
    },
    "run-1",
  ]);
  for (const [label, opts, runId] of cases) {
    const f = durableFixture(opts);
    const outcome = await f.ask(runId);
    assert.ok("error" in outcome, label);
    assert.equal(f.posts.length, 0, label);
    assert.equal(f.store.size, 0, label);
  }
});

test("a consent DM that Slack rejects is reported as a failure and leaves no waiting status behind", async () => {
  const f = durableFixture();
  f.client.chat.postMessage = async () => {
    throw new Error("channel_not_found");
  };
  const outcome = await f.ask();
  assert.match((outcome as any).error, /couldn't send the request to Carol: channel_not_found/);
  assert.equal(f.store.size, 0);
});

test("a Run click on an instance that did not post the card recovers the request and completes the handoff", async () => {
  const f = durableFixture();
  const { requestId, cardTs, statusTs } = await f.postRequest();
  assert.equal(f.store.size, 1, "posting the card persists the request durably");
  assert.equal(f.store.get(requestId)?.originStatusTs, statusTs);

  await f.newInstance().click("agent_request_run", requestId, { ts: cardTs });

  assert.equal(f.submitted.length, 1, "the personal turn runs despite the empty in-memory state");
  assert.match(String(f.submitted[0].text), /run the check/);
  const cardEdits = f.updates.filter((u) => u.channel === "D-CAROL" && u.ts === cardTs);
  assert.match(String(cardEdits[0]?.text), /Approved\. Running with Carol's personal agent now/);
  const statusEdits = f.updates.filter((u) => u.channel === "C1" && u.ts === statusTs);
  assert.match(String(statusEdits.at(-1)?.text), /personal result/, "the origin status message carries the outcome");
  assert.equal(f.store.size, 0, "the durable record is settled on resolution");
});

test("a Deny click after a restart recovers the request and updates both the card and the origin status", async () => {
  const f = durableFixture();
  const { requestId, cardTs, statusTs } = await f.postRequest();

  await f.newInstance().click("agent_request_deny", requestId, { ts: cardTs });

  assert.equal(f.submitted.length, 0);
  const cardEdit = f.updates.find((u) => u.channel === "D-CAROL" && u.ts === cardTs);
  assert.match(String(cardEdit?.text), /Declined/);
  const statusEdit = f.updates.find((u) => u.channel === "C1" && u.ts === statusTs);
  assert.match(String(statusEdit?.text), /declined the personal-agent handoff/);
  assert.equal(f.store.size, 0);
});

test("a click on a request that no longer exists anywhere edits the card to the expired notice", async () => {
  const f = durableFixture();
  await f.newInstance().click("agent_request_run", "missing-req", { ts: "42.1" });
  assert.match(String(f.updates[0]?.text), /That agent request expired/);
  assert.equal(f.submitted.length, 0);
});

test("a click that loses the claim race to another instance stays silent", async () => {
  const f = durableFixture({ coreOverrides: { takeAgentRequest: async () => null } });
  const { requestId, cardTs } = await f.postRequest();
  const updatesBefore = f.updates.length;

  await f.newInstance().click("agent_request_run", requestId, { ts: cardTs });

  assert.equal(f.submitted.length, 0);
  assert.equal(f.updates.length, updatesBefore);
  assert.equal(f.ephemerals.length, 0);
});

test("a store outage answers the click with a retry nudge instead of expiring the card", async () => {
  const f = durableFixture({
    coreOverrides: {
      getAgentRequest: async () => {
        throw new Error("db down");
      },
    },
  });
  const { requestId, cardTs } = await f.postRequest();

  await f.newInstance().click("agent_request_run", requestId, { ts: cardTs });

  assert.equal(f.updates.length, 0);
  assert.match(String(f.ephemerals[0]?.text), /try the button again/);
  assert.equal(f.store.size, 1, "the pending request is left intact");
});

test("a click by anyone but the target user is rejected and leaves the request pending", async () => {
  const f = durableFixture();
  const { requestId, cardTs } = await f.postRequest();

  await f.newInstance().click("agent_request_run", requestId, { user: "U-EVIL", ts: cardTs });

  assert.equal(f.submitted.length, 0);
  assert.equal(f.updates.length, 0);
  assert.match(String(f.ephemerals[0]?.text), /Only the person whose personal agent was asked/);
  assert.equal(f.store.size, 1);
});

test("a handoff fails loudly when the command-approval link cannot be recorded", async () => {
  const f = durableFixture({
    turnResults: [
      {
        status: "pending_approval",
        pendingApprovals: [{ requestId: "req-9", command: "deploy", reason: "flagged" }],
      },
    ],
  });
  const { requestId, cardTs, statusTs } = await f.postRequest();
  const put = f.core.putAgentRequest.bind(f.core);
  f.core.putAgentRequest = async (id: string, record: SlackAgentRequestContext) => {
    if (record.approvalRequestIds?.length) throw new Error("db down");
    await put(id, record);
  };

  await f.newInstance().click("agent_request_run", requestId, { ts: cardTs });

  const statusEdit = f.updates.filter((u) => u.channel === "C1" && u.ts === statusTs).at(-1);
  assert.match(String(statusEdit?.text), /could not be completed[\s\S]*couldn't be recorded/);
  const approvalCards = f.posts.filter((p) => JSON.stringify(p.blocks ?? []).includes("hilo_allow_once"));
  assert.equal(approvalCards.length, 0, "no approval card is posted without a durable link");
  assert.equal(f.store.size, 0);
});

test("the agent-request store expires stale records and sweeps them on put", async () => {
  const map = createMemoryMap<SlackAgentRequestContext>();
  const store = createAgentRequestStore(map);
  const record = (id: string, ageMs: number, approvalIds?: string[]): SlackAgentRequestContext => ({
    requestId: id,
    requesterId: "U1",
    targetUserId: "U2",
    originChannel: "C1",
    originThreadOnly: true,
    dmChannel: "D1",
    task: "t",
    originAgentLabel: "o",
    targetAgentLabel: "t",
    createdAt: Date.now() - ageMs,
    ...(approvalIds ? { approvalRequestIds: approvalIds } : {}),
  });
  const eightDays = 8 * 24 * 60 * 60 * 1000;

  await map.put("stale", record("stale", eightDays, ["req-old"]));
  assert.equal(await store.getAgentRequest("stale"), null);
  assert.equal(await store.agentRequestForApproval("req-old"), null);
  assert.equal(await store.takeAgentRequest("stale"), null);

  await map.put("stale2", record("stale2", eightDays));
  await store.putAgentRequest("fresh", record("fresh", 0, ["req-new"]));
  assert.deepEqual(
    (await map.entries()).map(([id]) => id),
    ["fresh"],
  );

  await map.put("stale3", record("stale3", eightDays));
  const brittle = createAgentRequestStore({
    ...map,
    delete: async () => {
      throw new Error("gc hiccup");
    },
  });
  await brittle.putAgentRequest("fresh2", record("fresh2", 0));
  assert.equal((await brittle.getAgentRequest("fresh2"))?.requestId, "fresh2", "a failed sweep never aborts the put");
  assert.equal((await store.getAgentRequest("fresh"))?.requestId, "fresh");
  assert.equal((await store.agentRequestForApproval("req-new"))?.requestId, "fresh");
  assert.equal((await store.takeAgentRequest("fresh"))?.requestId, "fresh");
  assert.equal(await map.get("fresh"), null);
});

test("a handoff command approval recovered on a fresh instance still reports back to the origin channel", async () => {
  const f = durableFixture({
    turnResults: [
      {
        status: "pending_approval",
        pendingApprovals: [{ requestId: "req-9", command: "deploy", reason: "flagged" }],
      },
      { status: "ok", reply: "deploy finished" },
    ],
  });
  const { requestId, cardTs, statusTs } = await f.postRequest();

  await f.newInstance().click("agent_request_run", requestId, { ts: cardTs });
  const continuationId = f.submitted[0].gatewayContext.details.agent_request_id;
  assert.notEqual(continuationId, requestId);
  assert.deepEqual(f.store.get(continuationId)?.approvalRequestIds, ["req-9"]);
  const waiting = f.updates.filter((u) => u.channel === "C1" && u.ts === statusTs);
  assert.match(String(waiting.at(-1)?.text), /approve a command/);

  f.storedApprovals.set("req-9", {
    requestId: "req-9",
    command: "deploy",
    reason: "flagged",
    request: { ...f.submitted[0], surface: "slack" },
  });
  await f.newInstance().click("hilo_allow_once", "req-9", { ts: "100.9" });

  assert.equal(f.submitted.length, 2, "the approved command re-runs on the fresh instance");
  assert.equal(f.submitted[1].approval.requestId, "req-9");
  const statusEdits = f.updates.filter((u) => u.channel === "C1" && u.ts === statusTs);
  assert.match(String(statusEdits.at(-1)?.text), /deploy finished/, "the origin status message gets the result");
  assert.equal(f.store.size, 0, "the durable record is settled once the handoff completes");
});

test("a react directive followed by a huge whitespace run strips in linear time", () => {
  const start = process.hrtime.bigint();
  extractReactions("thanks [[react:" + " ".repeat(100000) + "]x");
  extractReactions("[[react: eyes]] tail" + " ".repeat(100000) + "no newline");
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 200);
});

test("an early approval has durable handoff context without making the original Run button reusable", async () => {
  const f = durableFixture();
  const { requestId, cardTs } = await f.postRequest();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.core.submitTurn = async (body) => {
    f.submitted.push(body);
    const continuationId = body.gatewayContext?.details?.agent_request_id;
    assert.equal(typeof continuationId, "string");
    assert.notEqual(continuationId, requestId);
    assert.ok(f.store.has(String(continuationId)));
    assert.equal(f.store.has(requestId), false);
    started();
    await pending;
    return { status: "ok", reply: "done" };
  };
  const first = f.newInstance().click("agent_request_run", requestId, { ts: cardTs });
  await ready;
  await f.newInstance().click("agent_request_run", requestId, { ts: cardTs });
  assert.equal(f.submitted.length, 1);
  release();
  await first;
  assert.equal(f.store.size, 0);
});
