import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companySlackActor,
  externalSlackNamespace,
  extractPrivateContinuation,
  parseExternalSlackAccess,
} from "../src/slack/external-access.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv } from "../src/slack/config.ts";
import { continueInPrivate, PRIVATE_CONTINUATION_ACK } from "../src/slack/private-continuation.ts";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { TurnRequest } from "../src/types.ts";

const policy = { companyDomains: ["company.example"], serviceCredentials: ["public-search"] };
const employee = { id: "UEMPLOYEE", team_id: "TPARTNER", profile: { email: " Employee@Company.Example " } };

test("external workspace identity uses exact email domain, not Slack membership or guest status", () => {
  assert.equal(companySlackActor(employee, policy).externalId, "employee@company.example");
  assert.equal(
    companySlackActor({ ...employee, is_restricted: true, is_stranger: true, team_id: "TOTHER" }, policy)
      .isExternalGuest,
    false,
  );
  for (const user of [
    undefined,
    { id: "UNOEMAIL", team_id: "TPARTNER" },
    { ...employee, deleted: true },
    { ...employee, is_bot: true },
    ...["founder@outside.example", "e@company.example.evil", "e@sub.company.example", "e@@company.example"].map(
      (email) => ({ ...employee, profile: { email } }),
    ),
  ])
    assert.equal(companySlackActor(user, policy).isExternalGuest, true);
});

test("external access is opt-in per workspace and rejects malformed allowlists", () => {
  const base = { SLACK_BOT_TOKEN: "synthetic-bot", SLACK_APP_TOKEN: "synthetic-app" };
  assert.equal(slackPluginConfigFromEnv(base)?.externalAccess, undefined);
  const configs = slackAccountConfigsFromEnv({
    SLACK_ACCOUNTS: JSON.stringify([
      { id: "internal", botToken: base.SLACK_BOT_TOKEN, appToken: base.SLACK_APP_TOKEN },
      { id: "external", botToken: base.SLACK_BOT_TOKEN, appToken: base.SLACK_APP_TOKEN, externalAccess: policy },
      {
        id: "http",
        botToken: base.SLACK_BOT_TOKEN,
        eventsMode: "http",
        signingSecret: "synthetic",
        eventsPort: 3000,
        externalAccess: policy,
      },
    ]),
  });
  assert.equal(configs[0]?.externalAccess, undefined);
  assert.deepEqual(configs[1]?.externalAccess, policy);
  assert.deepEqual(configs[2]?.externalAccess, policy);
  assert.deepEqual(
    slackPluginConfigFromEnv({ ...base, SLACK_EXTERNAL_ACCESS: JSON.stringify(policy) })?.externalAccess,
    policy,
  );
  for (const value of [
    true,
    {},
    { companyDomains: [] },
    { companyDomains: ["*.company.example"] },
    { ...policy, serviceCredentials: "all" },
  ])
    assert.throws(() => parseExternalSlackAccess(value));
  assert.deepEqual(parseExternalSlackAccess({ companyDomains: ["COMPANY.EXAMPLE", "company.example"] }), {
    companyDomains: ["company.example"],
    serviceCredentials: [],
  });
});

test("scope namespace changes when workspace or authorization policy changes", () => {
  const original = externalSlackNamespace("TPARTNER", policy);
  assert.match(original, /^external-slack:TPARTNER:/);
  assert.notEqual(original, externalSlackNamespace("TOTHER", policy));
  assert.notEqual(original, externalSlackNamespace("TPARTNER", { ...policy, serviceCredentials: [] }));
});

test("private continuation directive is self-only and strips incomplete directives", () => {
  assert.deepEqual(extractPrivateContinuation("OK [[continue-private: schedule with the people above]]"), {
    text: "OK",
    task: "schedule with the people above",
  });
  assert.deepEqual(extractPrivateContinuation("OK [[continue-private: partial"), { text: "OK" });
});

function handoffFixture() {
  const source: TurnRequest = {
    surface: "slack",
    actor: { externalId: "employee@company.example" },
    externalSlack: { accountId: "partner", teamId: "TPARTNER", userId: "UEMPLOYEE", ...policy },
    conversation: {
      kind: "group",
      threadRef: "external-slack:TPARTNER:policy:group:CEXTERNAL:1",
      channelRef: "external-slack:TPARTNER:policy:CEXTERNAL",
    },
    deliveryTarget: "CEXTERNAL:1.0",
    text: "Invite Alex and Morgan next Tuesday.",
    priorTurns: [{ role: "user", text: "Alex: alex@outside.example; Morgan: morgan@outside.example" }],
    attachments: [{ name: "agenda.txt", mimetype: "text/plain", blobId: "public-agenda", sizeBytes: 8 }],
    triggerTs: "1.0",
  };
  const submissions: Omit<TurnRequest, "surface">[] = [];
  const work = new Set<string>();
  const posts: Record<string, any>[] = [];
  const opened: string[] = [];
  const client = {
    users: { info: async () => ({ user: employee }) },
    conversations: {
      open: async ({ users }: { users: string }) => {
        opened.push(users);
        return { channel: { id: "DPRIVATE" } };
      },
      replies: async () => ({ messages: posts }),
      history: async () => ({ messages: posts }),
    },
    chat: {
      postMessage: async (args: Record<string, any>) => {
        posts.push({ ...args, ts: "2.0" });
        return { ts: "2.0" };
      },
    },
  };
  const core = {
    privateContinuationSource: async () => source,
    waitRun: async () => ({ status: "ok", reply: "Synthetic private answer" }),
    ackRunDelivery: async () => {},
    submitTurn: async (request: Omit<TurnRequest, "surface">) => {
      submissions.push(request);
      work.add(request.idempotencyKey!);
      return { status: "queued", runId: "dm-run" };
    },
  } as unknown as SlackCoreClient;
  return { source, submissions, work, posts, opened, client, core };
}

test("handoff preserves request and participant list, runs in requester DM, and retries one work item", async () => {
  const f = handoffFixture();
  const lookup = (id: string) => {
    assert.equal(id, "partner");
    return { client: f.client, teamId: "TPARTNER", policy };
  };
  await continueInPrivate(f.core, "source-run", "Create the invite using my calendar", lookup);
  await continueInPrivate(f.core, "source-run", "Create the invite using my calendar", lookup);
  assert.deepEqual(f.opened, ["UEMPLOYEE", "UEMPLOYEE"]);
  assert.equal(f.work.size, 1);
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0]?.text, PRIVATE_CONTINUATION_ACK);
  assert.equal(f.posts[1]?.channel, "DPRIVATE");
  assert.equal(f.posts[1]?.text, "Synthetic private answer");
  const request = f.submissions[0]!;
  assert.equal(request.actor.externalId, f.source.actor.externalId);
  assert.equal(request.conversation.kind, "dm");
  assert.equal(request.externalSlack, undefined);
  assert.equal(request.deliveryTarget, "DPRIVATE");
  assert.match(request.conversation.threadRef, /^slack-account:TPARTNER:/);
  assert.match(request.text, /Invite Alex and Morgan/);
  assert.deepEqual(request.priorTurns, f.source.priorTurns);
  assert.deepEqual(request.attachments, f.source.attachments);
  assert.equal(request.liveActor, true);
  assert.equal(request.origin?.kind, "human");
  assert.equal(request.triggerDestination, undefined);
  assert.equal(request.deliveryCandidates, undefined);
});

test("handoff fails closed on revoked identity, wrong workspace, and missing DM", async () => {
  for (const scenario of ["revoked", "workspace", "no-dm"]) {
    const f = handoffFixture();
    if (scenario === "revoked")
      f.client.users.info = async () => ({ user: { ...employee, profile: { email: "outside@outside.example" } } });
    if (scenario === "no-dm") f.client.conversations.open = async () => ({ channel: { id: "CNOTADM" } });
    await assert.rejects(
      continueInPrivate(f.core, "source", "private task", () => ({
        client: f.client,
        teamId: scenario === "workspace" ? "TOTHER" : "TPARTNER",
        policy,
      })),
    );
    assert.equal(f.submissions.length, 0);
    assert.equal(f.posts.length, 0);
  }
});

test("delivery recovery routes private result only through its originating account", async () => {
  const posts: unknown[] = [];
  const acks: string[] = [];
  let pending = true;
  const client = {
    conversations: { history: async () => ({ messages: [] }) },
    chat: {
      postMessage: async (args: unknown) => {
        posts.push(args);
        return { ts: "3" };
      },
    },
  };
  const core = {
    holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
    claimDeliveries: async (type: string) => {
      if (type !== "slack" || !pending) return [];
      pending = false;
      return [
        {
          id: "delivery",
          idempotencyKey: "run:dm-run",
          text: "Synthetic private result",
          createdAt: Date.now() - 30_000,
          destination: { type: "slack", target: "DPRIVATE", slackAccountId: "partner" },
        },
      ];
    },
    ackDelivery: async (id: string) => {
      acks.push(id);
    },
  };
  const poller = createDeliveryPoller({
    core: core as never,
    flow: { inFlightRuns: new Set() } as never,
    threads: { mark: () => {} } as never,
    clientForIdentity: () => {
      throw new Error("wrong identity route");
    },
    clientForAccount: (id) => {
      assert.equal(id, "partner");
      return client;
    },
  });
  await poller.pollDeliveries({
    chat: {
      postMessage: () => {
        throw new Error("default account used");
      },
    },
  });
  assert.equal(posts.length, 1);
  assert.equal((posts[0] as { channel: string }).channel, "DPRIVATE");
  assert.deepEqual(acks, ["delivery"]);
});

test("external workspace refuses legacy personal-agent approval before reading its stored request", async () => {
  const { createApprovals } = await import("../src/slack/approvals.ts");
  const handlers: Array<{ pattern: RegExp; handler: (args: any) => Promise<void> }> = [];
  const approvals = createApprovals({
    externalAccess: true,
    core: {
      getAgentRequest: async () => {
        throw new Error("legacy private request read");
      },
    } as never,
    flow: {} as never,
    directory: {} as never,
    threads: {} as never,
    ids: {} as never,
  });
  approvals.registerActions({
    action: (pattern, handler) => {
      handlers.push({ pattern, handler });
    },
  });
  let acknowledged = false;
  await handlers
    .find(({ pattern }) => pattern.test("agent_request_run"))!
    .handler({
      ack: async () => {
        acknowledged = true;
      },
      body: {},
      action: { action_id: "agent_request_run", value: "legacy-private-bridge" },
      client: {},
    });
  assert.equal(acknowledged, true);
});

test("external account poller neither claims default identity nor releases pre-policy shared answers", async () => {
  for (const hasDefault of [false, true]) {
    let pending = true;
    const acks: string[] = [];
    const core = {
      holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
      claimDeliveries: async (type: string) => {
        if (type !== "slack" || !pending) return [];
        pending = false;
        return [
          {
            id: "legacy",
            idempotencyKey: "run:legacy",
            text: "Synthetic pre-policy private answer",
            createdAt: 1,
            destination: { type: "slack", target: "CSHARED" },
          },
        ];
      },
      ackDelivery: async (id: string) => {
        acks.push(id);
      },
    };
    const client = {
      chat: {
        postMessage: () => {
          throw new Error("legacy data released");
        },
      },
    };
    const poller = createDeliveryPoller({
      core: core as never,
      flow: { inFlightRuns: new Set() } as never,
      threads: {} as never,
      clientForIdentity: () => client,
      clientForAccount: (id) => {
        assert.equal(id, "default");
        return hasDefault ? client : undefined;
      },
      externalAccount: () => true,
    });
    await poller.pollDeliveries(client);
    assert.deepEqual(acks, hasDefault ? ["legacy"] : []);
  }
});
