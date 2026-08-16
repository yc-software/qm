import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { SlackCoreClient } from "../src/slack/index.ts";
import type { TurnResult } from "../src/types.ts";

type Handler = (args: any) => Promise<void>;

class FakeSocketModeClient {
  on(): void {}
  async start(): Promise<void> {}
  async disconnect(): Promise<void> {}
}

class FakeSlackClient {
  readonly posts: any[] = [];
  readonly ephemerals: any[] = [];
  readonly updates: any[] = [];
  readonly deletes: any[] = [];
  readonly reactionsAdded: any[] = [];
  readonly reactionsRemoved: any[] = [];
  readonly usersById = new Map<string, any>();
  readonly channelsById = new Map<string, any>();
  readonly membersByChannel = new Map<string, string[]>();
  readonly messagesByChannel = new Map<string, any[]>();
  readonly membershipFailures = new Set<string>();
  readonly membershipListings = new Map<string, number>();
  readonly botsById = new Map<string, any>();
  membershipDelayMs = 0;
  activeMembershipListings = 0;
  maxActiveMembershipListings = 0;
  firstMembershipListingStartedAt: number | undefined;
  groupListings = 0;
  failGroupListing = false;
  private postSequence = 0;

  readonly auth = {
    test: async () => ({
      team_id: "T1",
      user_id: "UBOT",
      bot_id: "BBOT",
      user: "qmbot",
      team: "Acme",
      url: "https://acme.slack.com/",
    }),
  };
  readonly emoji = { list: async () => ({ emoji: {} }) };
  readonly users = {
    info: async ({ user }: { user: string }) => ({ user: this.usersById.get(user) }),
    lookupByEmail: async ({ email }: { email: string }) => ({
      user: [...this.usersById.values()].find((u) => u.profile?.email === email),
    }),
  };
  readonly conversations = {
    info: async ({ channel }: { channel: string }) => ({ channel: this.channelsById.get(channel) }),
    replies: async ({ channel, ts }: { channel: string; ts: string }) => ({
      messages: (this.messagesByChannel.get(channel) ?? []).filter((m) => m.ts === ts || m.thread_ts === ts),
      has_more: false,
    }),
    history: async ({ channel, latest }: { channel: string; latest?: string }) => ({
      messages: (this.messagesByChannel.get(channel) ?? []).filter((m) => !latest || m.ts === latest),
      has_more: false,
    }),
    open: async () => ({ channel: { id: "DOPEN" } }),
    setTopic: async ({ channel, topic }: { channel: string; topic: string }) => {
      this.topics.push({ channel, topic });
      const existing = this.channelsById.get(channel) ?? { id: channel };
      this.channelsById.set(channel, { ...existing, topic: { value: topic, creator: "UBOT" } });
      return { ok: true };
    },
  };
  readonly topics: { channel: string; topic: string }[] = [];
  readonly pinnedByChannel = new Map<string, { ts: string; user: string; text: string }[]>();
  readonly pins = {
    list: async ({ channel }: { channel: string }) => ({
      items: (this.pinnedByChannel.get(channel) ?? []).map((message) => ({ message })),
    }),
    add: async ({ channel, timestamp }: { channel: string; timestamp: string }) => {
      const lastPost = this.posts.filter((p) => p.channel === channel).at(-1);
      const pinned = this.pinnedByChannel.get(channel) ?? [];
      pinned.push({ ts: timestamp, user: "UBOT", text: lastPost?.text ?? "" });
      this.pinnedByChannel.set(channel, pinned);
      return { ok: true };
    },
    remove: async ({ channel, timestamp }: { channel: string; timestamp: string }) => {
      this.pinnedByChannel.set(
        channel,
        (this.pinnedByChannel.get(channel) ?? []).filter((m) => m.ts !== timestamp),
      );
      return { ok: true };
    },
  };
  readonly chat = {
    postMessage: async (body: any) => {
      this.posts.push(body);
      return { ok: true, ts: `posted-${++this.postSequence}` };
    },
    postEphemeral: async (body: any) => {
      this.ephemerals.push(body);
      return { ok: true, message_ts: `ephemeral-${this.ephemerals.length}` };
    },
    update: async (body: any) => {
      this.updates.push(body);
      return { ok: true, ts: body.ts };
    },
    delete: async (body: any) => {
      this.deletes.push(body);
      return { ok: true };
    },
  };
  readonly reactions = {
    add: async (body: any) => {
      this.reactionsAdded.push(body);
      return { ok: true };
    },
    remove: async (body: any) => {
      this.reactionsRemoved.push(body);
      return { ok: true };
    },
    get: async () => ({}),
  };
  readonly files = {
    uploadV2: async () => ({ ok: true }),
    info: async () => ({ file: {} }),
  };
  readonly bots = { info: async ({ bot }: { bot: string }) => ({ bot: this.botsById.get(bot) }) };

  async *paginate(method: string, args: any): AsyncGenerator<any> {
    if (method === "users.list") {
      yield { members: [...this.usersById.values()] };
      return;
    }
    if (method === "conversations.list") {
      const types = String(args.types ?? "");
      if (types === "mpim") {
        this.groupListings++;
        if (this.failGroupListing) throw new Error("missing mpim:read");
      }
      yield {
        channels: [...this.channelsById.values()].filter((c) => (types === "mpim" ? c.is_mpim : !c.is_mpim)),
      };
      return;
    }
    if (method === "conversations.members") {
      this.firstMembershipListingStartedAt ??= Date.now();
      this.membershipListings.set(args.channel, (this.membershipListings.get(args.channel) ?? 0) + 1);
      this.activeMembershipListings++;
      this.maxActiveMembershipListings = Math.max(this.maxActiveMembershipListings, this.activeMembershipListings);
      try {
        if (this.membershipDelayMs) await new Promise((resolve) => setTimeout(resolve, this.membershipDelayMs));
        if (this.membershipFailures.has(args.channel)) throw new Error("missing conversations:read");
        yield { members: this.membersByChannel.get(args.channel) ?? [] };
      } finally {
        this.activeMembershipListings--;
      }
      return;
    }
    throw new Error(`unexpected pagination method: ${method}`);
  }
}

class FakeApp {
  static instances: FakeApp[] = [];
  readonly client = new FakeSlackClient();
  readonly receiver: any;
  readonly messageHandlers: Handler[] = [];
  readonly eventHandlers = new Map<string, Handler[]>();
  readonly actionHandlers: Array<{ pattern: RegExp | string; handler: Handler }> = [];
  started = false;

  constructor(opts: any) {
    this.receiver = opts.receiver;
    FakeApp.instances.push(this);
  }

  message(handler: Handler): void {
    this.messageHandlers.push(handler);
  }

  event(name: string, handler: Handler): void {
    this.eventHandlers.set(name, [...(this.eventHandlers.get(name) ?? []), handler]);
  }

  action(pattern: RegExp | string, handler: Handler): void {
    this.actionHandlers.push({ pattern, handler });
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async emitMessage(message: any, eventId = `Ev-${message.channel}-${message.ts}`): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler({ message, body: { event_id: eventId }, client: this.client, context: {} });
    }
  }

  async emitEvent(name: string, event: any, eventId = `Ev-${name}-${event.channel}-${event.ts}`): Promise<void> {
    for (const handler of this.eventHandlers.get(name) ?? []) {
      await handler({ event, body: { event_id: eventId }, client: this.client, context: {} });
    }
  }
}

mock.module("@slack/bolt", { defaultExport: { App: FakeApp, LogLevel: { INFO: "info" } } });
mock.module("@slack/socket-mode", { namedExports: { SocketModeClient: FakeSocketModeClient } });
mock.module("@slack/web-api", { namedExports: { WebClient: class {} } });

const { slackPluginConfigFromEnv, startSlackPlugin } = await import("../src/slack/index.ts");

class FakeCore implements SlackCoreClient {
  readonly turns: any[] = [];
  readonly ingests: any[][] = [];
  readonly directories: any[] = [];
  readonly ackPicks: Array<{ text: string; candidates: readonly string[] }> = [];
  externalParticipants = false;
  result: TurnResult = { status: "ok", reply: "agent reply" };
  submitError: Error | undefined;
  activeRun: string | undefined;
  abortedRuns: string[] = [];
  queuedRunId: string | undefined;
  private heldRunClaimed = false;
  readonly polled: string[] = [];
  private runGate: Promise<void> | undefined;
  private releaseRun: (() => void) | undefined;
  readonly modelChangeListeners: Array<(scope: any) => void> = [];
  readonly headerPinChangeListeners: Array<(scope: any) => void> = [];
  readonly headerPinScopes = new Set<string>();

  async externalSlackParticipants(): Promise<boolean> {
    return this.externalParticipants;
  }
  async surfaceHeaderFacts(): Promise<{ agentLabel?: string; modelName: string }> {
    return { agentLabel: "Quartermaster", modelName: "Claude Opus 4.8" };
  }
  onScopeModelChanged(listener: (scope: any) => void): void {
    this.modelChangeListeners.push(listener);
  }
  async channelHeaderPinEnabled(scope: any): Promise<boolean> {
    return this.headerPinScopes.has(String(scope));
  }
  onChannelHeaderPinChanged(listener: (scope: any) => void): void {
    this.headerPinChangeListeners.push(listener);
  }
  async stageBlob(bytes: Uint8Array): Promise<{ blobId: string; sizeBytes: number }> {
    return { blobId: "blob-1", sizeBytes: bytes.byteLength };
  }
  async readBlob(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async readFileArtifact(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async pickAckEmoji(text: string, candidates: readonly string[]): Promise<undefined> {
    this.ackPicks.push({ text, candidates });
    return undefined;
  }
  async recordAckPick(): Promise<void> {}
  async ingestSurfaceEvents(events: any[]): Promise<void> {
    this.ingests.push(events);
  }
  async submitTurn(body: any): Promise<TurnResult> {
    this.turns.push(body);
    if (this.submitError) throw this.submitError;
    if (this.queuedRunId) {
      // The first submit enqueues the run; a later one arrives while it is live, so core folds
      // it in as a steer and answers with the LIVE run's id (src/api/app-turn.ts).
      const steered = this.heldRunClaimed;
      this.heldRunClaimed = true;
      return { status: "queued", runId: this.queuedRunId, ...(steered ? { steered: true as const } : {}) };
    }
    return this.result;
  }
  async waitRun(runId: string): Promise<TurnResult | null> {
    this.polled.push(runId);
    if (this.runGate) await this.runGate;
    return this.result;
  }
  /** Enqueue `runId` on the first submit and hold waitRun open; every later submit is a
   *  mid-turn STEER answered with that same live run's id. `finishRun` releases the waiters. */
  holdRun(runId: string): void {
    this.queuedRunId = runId;
    this.heldRunClaimed = false;
    this.runGate = new Promise<void>((resolve) => (this.releaseRun = resolve));
  }
  finishRun(result: TurnResult): void {
    this.result = result;
    this.releaseRun?.();
  }
  async activeRunForThread(): Promise<string | undefined> {
    return this.activeRun;
  }
  async signalRunAbort(runId: string): Promise<void> {
    this.abortedRuns.push(runId);
  }
  async ackRunDelivery(): Promise<void> {}
  async reportTurnMetrics(): Promise<void> {}
  async reportRunEditRef(): Promise<void> {}
  async getApproval(): Promise<null> {
    return null;
  }
  async pushDirectory(body: any): Promise<void> {
    this.directories.push(body);
  }
  async claimDeliveries(): Promise<[]> {
    return [];
  }
  async ackDelivery(): Promise<void> {}
  onDeliveryEnqueued(): () => void {
    return () => {};
  }
  async pendingContextRequests(): Promise<[]> {
    return [];
  }
  onContextRequest(): () => void {
    return () => {};
  }
  async fulfillContextRequest(): Promise<void> {}
}

const internalUser = (id: string, name: string) => ({
  id,
  team_id: "T1",
  name: name.toLowerCase(),
  real_name: name,
  profile: { display_name: name, real_name: name, email: `${name.toLowerCase()}@example.com` },
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(
  options: {
    externalParticipants?: boolean;
    webUiPublicUrl?: string;
    identityEmail?: "0" | "1";
    extraChannels?: number;
    membershipDelayMs?: number;
  } = {},
) {
  const core = new FakeCore();
  core.externalParticipants = options.externalParticipants ?? false;
  const started = startSlackPlugin(
    {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      identityEmail: options.identityEmail ?? "0",
      ...(options.webUiPublicUrl ? { webUiPublicUrl: options.webUiPublicUrl } : {}),
    },
    core,
  );
  const app = FakeApp.instances.at(-1)!;
  app.client.membershipDelayMs = options.membershipDelayMs ?? 0;
  app.client.usersById.set("U1", internalUser("U1", "Alice"));
  app.client.usersById.set("U2", internalUser("U2", "Bob"));
  app.client.usersById.set("UX", { id: "UX", team_id: "T2", name: "mallory", profile: { display_name: "Mallory" } });
  app.client.channelsById.set("C1", { id: "C1", name: "engineering", is_member: true, is_private: false });
  app.client.channelsById.set("CX", {
    id: "CX",
    name: "shared",
    is_member: true,
    is_private: false,
    is_ext_shared: true,
  });
  app.client.channelsById.set("CPX", {
    id: "CPX",
    name: "private-shared",
    is_member: true,
    is_private: true,
    is_ext_shared: true,
  });
  app.client.membersByChannel.set("C1", ["U1", "U2", "UBOT"]);
  app.client.membersByChannel.set("CX", ["U1", "UX", "UBOT"]);
  app.client.membersByChannel.set("CPX", ["U1", "UX", "UBOT"]);
  for (let i = 0; i < (options.extraChannels ?? 0); i++) {
    const id = `CE${i}`;
    app.client.channelsById.set(id, { id, name: `extra-${i}`, is_member: true, is_private: false });
    app.client.membersByChannel.set(id, ["U1", "UBOT"]);
  }
  const plugin = await started;
  await new Promise((resolve) => setImmediate(resolve));
  return { app, client: app.client, core, stop: () => plugin.stop() };
}

test("config is all-or-nothing and numeric tuning fails closed", () => {
  assert.equal(slackPluginConfigFromEnv({ SLACK_BOT_TOKEN: "xoxb" }), null);
  assert.equal(slackPluginConfigFromEnv({ SLACK_APP_TOKEN: "xapp" }), null);
  const config = slackPluginConfigFromEnv({
    SLACK_BOT_TOKEN: "xoxb",
    SLACK_APP_TOKEN: "xapp",
    SLACK_USER_SNAPSHOT_TTL_MS: "-1",
    SLACK_CHANNEL_MEMBERS_TTL_MS: "NaN",
    SLACK_MAX_PRIVATE_CHANNELS: "10",
  });
  assert.deepEqual(config, { botToken: "xoxb", appToken: "xapp", maxPrivateChannels: 10 });
});

test("a mid-turn message that STEERS the live run does not post the reply twice", async () => {
  const f = await fixture();
  try {
    // Core folds a message that lands mid-run into the LIVE run and answers the steering
    // request with that run's id, flagged `steered` (src/api/app-turn.ts). Only the handler
    // that started R1 owns its reply; the one that joined must not deliver it a second time.
    f.core.holdRun("R1");
    const first = f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "first ask", ts: "300.1" });
    await waitFor(() => f.core.polled.length === 1);
    const steer = f.app.emitMessage({
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "and also this",
      ts: "300.2",
    });
    await waitFor(() => f.core.turns.length === 2);
    assert.deepEqual(f.core.polled, ["R1"], "only the handler that started the run waits on it");

    f.core.finishRun({ status: "ok", reply: "agent reply" });
    await Promise.all([first, steer]);

    assert.equal(
      f.client.posts.filter((p) => p.text === "agent reply").length,
      1,
      "the shared run's reply is posted once, by the handler that owns it",
    );
  } finally {
    await f.stop();
  }
});

test("a DM becomes one scoped live turn and one Slack reply", async () => {
  const f = await fixture();
  try {
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello agent", ts: "100.1" });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].text, "hello agent");
    assert.equal(f.core.turns[0].conversation.kind, "dm");
    assert.equal(f.core.turns[0].conversation.threadRef, "dm:D1");
    assert.equal(f.core.turns[0].conversation.audience[0].externalId, "U1");
    assert.equal(f.core.turns[0].deliveryTarget, "D1");
    assert.equal(f.core.turns[0].liveActor, true);
    assert.equal(f.core.turns[0].triggerTs, "100.1");
    assert.equal(f.core.turns[0].gatewayContext.botHandle, "qmbot");
    assert.equal(f.core.ackPicks.length, 1);
    assert.equal(f.core.ackPicks[0]?.text, "hello agent");
    assert.ok((f.core.ackPicks[0]?.candidates.length ?? 0) > 0);
    assert.deepEqual(
      f.client.posts.map((p) => p.text),
      ["agent reply"],
    );
  } finally {
    await f.stop();
  }
});

test("public channel rosters stay current in the core directory", async () => {
  const f = await fixture();
  try {
    assert.ok(f.core.directories.some((d: any) => d.channelMembers));
    assert.deepEqual(
      f.core.directories
        .at(-1)
        .channelMembers.filter((m: any) => m.channelId === "C1")
        .map((m: any) => m.principalId)
        .sort(),
      ["U1", "U2"],
    );

    f.client.membersByChannel.set("C1", ["U1", "UBOT"]);
    const pushes = f.core.directories.length;
    await f.app.emitEvent("member_left_channel", { user: "U2", channel: "C1", event_ts: "100.2" }, "Ev-u2-left");
    await waitFor(() => f.core.directories.length > pushes);
    assert.deepEqual(
      f.core.directories
        .at(-1)
        .channelMembers.filter((m: any) => m.channelId === "C1")
        .map((m: any) => m.principalId),
      ["U1"],
    );
  } finally {
    await f.stop();
  }
});

test("full directory refreshes bound concurrent Slack roster reads", async () => {
  const f = await fixture({ extraChannels: 5, membershipDelayMs: 10 });
  try {
    assert.equal(f.client.membershipListings.size, 8);
    assert.ok(f.client.maxActiveMembershipListings > 1);
    assert.ok(f.client.maxActiveMembershipListings <= 4);
    assert.ok(f.core.directories.at(-1).channelsSyncedAt <= f.client.firstMembershipListingStartedAt!);
  } finally {
    await f.stop();
  }
});

test("large public channels publish their complete roster and accept internal turns", async () => {
  const f = await fixture();
  try {
    const members = Array.from({ length: 201 }, (_, i) => `UL${i}`);
    for (const id of members) f.client.usersById.set(id, internalUser(id, id));
    f.client.membersByChannel.set("C1", [...members, "UBOT"]);
    const pushes = f.core.directories.length;
    await f.app.emitEvent("member_joined_channel", { user: members[0], channel: "C1", event_ts: "100.3" });
    await waitFor(() => f.core.directories.length > pushes);
    assert.equal(
      f.core.directories.at(-1).channelMembers.filter((m: any) => m.channelId === "C1").length,
      members.length,
    );

    await f.app.emitEvent("app_mention", {
      channel: "C1",
      channel_type: "channel",
      user: members[0],
      text: "<@UBOT> hello",
      ts: "100.4",
    });
    assert.equal(f.core.turns.length, 1);
  } finally {
    await f.stop();
  }
});

test("failed background roster reads are marked unknown instead of clearing known capabilities", async () => {
  const f = await fixture();
  try {
    assert.ok(f.core.directories.at(-1).channelRosterIds.includes("CPX"));
    f.client.membershipFailures.add("CPX");
    const pushes = f.core.directories.length;
    await f.app.emitEvent("channel_rename", { channel: { id: "CPX" }, event_ts: "100.5" });
    await waitFor(() => f.core.directories.length > pushes);
    assert.ok(!f.core.directories.at(-1).channelRosterIds.includes("CPX"));
  } finally {
    await f.stop();
  }
});

test("a failed refresh after a leave event revokes only the departing member", async () => {
  const f = await fixture();
  try {
    f.client.membershipFailures.add("CPX");
    const pushes = f.core.directories.length;
    await f.app.emitEvent("member_left_channel", { user: "U1", channel: "CPX", event_ts: "100.6" });
    await waitFor(() => f.core.directories.length > pushes);
    const pushed = f.core.directories.at(-1);
    assert.ok(!pushed.channelRosterIds.includes("CPX"));
    assert.deepEqual(pushed.channelRevocations, [{ channelId: "CPX", principalId: "U1" }]);
  } finally {
    await f.stop();
  }
});

test("a failed email-mode refresh revokes the departing canonical principal", async () => {
  const f = await fixture({ identityEmail: "1" });
  try {
    f.client.membershipFailures.add("CPX");
    const pushes = f.core.directories.length;
    await f.app.emitEvent("member_left_channel", { user: "U1", channel: "CPX", event_ts: "100.7" });
    await waitFor(() => f.core.directories.length > pushes);
    assert.deepEqual(f.core.directories.at(-1).channelRevocations, [
      { channelId: "CPX", principalId: "alice@example.com" },
    ]);
  } finally {
    await f.stop();
  }
});

test("Slack Connect directory rosters contain only internal principals", async () => {
  const f = await fixture({ externalParticipants: true });
  try {
    const pushed = f.core.directories.at(-1);
    assert.ok(pushed.channelRosterIds.includes("CX"));
    assert.ok(pushed.channelRosterIds.includes("CPX"));
    assert.equal(pushed.channels.find((channel: any) => channel.channelId === "CPX")?.isExternal, true);
    assert.deepEqual(
      pushed.channelMembers.filter((m: any) => m.channelId === "CX").map((m: any) => m.principalId),
      ["U1"],
    );
    assert.deepEqual(
      pushed.channelMembers.filter((m: any) => m.channelId === "CPX").map((m: any) => m.principalId),
      ["U1"],
    );
    assert.ok(pushed.channelRosterIds.includes("CPX"));
    f.client.membershipListings.set("CPX", 0);
    f.client.membershipListings.set("C1", 0);
    const pushes = f.core.directories.length;
    await f.app.emitEvent("channel_rename", { channel: { id: "CPX" }, event_ts: "100.7" });
    await waitFor(() => f.core.directories.length > pushes);
    assert.equal(f.client.membershipListings.get("CPX"), 1);
    assert.equal(f.client.membershipListings.get("C1"), 0);
  } finally {
    await f.stop();
  }
});

test("a human's DM sets the conversation header to the serving model + web surface", async () => {
  const f = await fixture({ webUiPublicUrl: "https://claw.example.dev" });
  try {
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "100.1" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.client.topics, [
      {
        channel: "D1",
        topic: "Using Claude Opus 4.8 here. <https://claw.example.dev/contexts?scope=personal%3AU1|More settings>",
      },
    ]);
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "again", ts: "100.2" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.client.topics.length, 1);
  } finally {
    await f.stop();
  }
});

test("joining a channel posts the welcome and a pinned header naming the model and project page", async () => {
  const f = await fixture({ webUiPublicUrl: "https://claw.example.dev" });
  try {
    f.core.headerPinScopes.add("channel:C1");
    await f.app.emitEvent("member_joined_channel", { user: "UBOT", channel: "C1", event_ts: "100.1" }, "Ev-bot-join");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      f.client.pinnedByChannel.get("C1")?.map((m) => m.text),
      ["Using Claude Opus 4.8 here. <https://claw.example.dev/projects/channel/C1|More settings>"],
    );
    assert.deepEqual(f.client.topics, [], "a channel's topic stays the members' own scratch space");
  } finally {
    await f.stop();
  }
});

test("joining a channel with the toggle off (the default) posts only the welcome — no pin", async () => {
  const f = await fixture({ webUiPublicUrl: "https://claw.example.dev" });
  try {
    await f.app.emitEvent("member_joined_channel", { user: "UBOT", channel: "C1", event_ts: "100.1" }, "Ev-bot-join");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.client.posts.length, 1, "only the welcome message lands");
    assert.equal(f.client.pinnedByChannel.get("C1"), undefined);
  } finally {
    await f.stop();
  }
});

test("flipping the toggle on creates the pinned header; flipping it off removes it", async () => {
  const f = await fixture({ webUiPublicUrl: "https://claw.example.dev" });
  try {
    assert.equal(f.core.headerPinChangeListeners.length, 1, "the plugin subscribes to toggle changes");
    f.core.headerPinScopes.add("channel:C1");
    for (const listener of f.core.headerPinChangeListeners) listener("channel:C1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      f.client.pinnedByChannel.get("C1")?.map((m) => m.text),
      ["Using Claude Opus 4.8 here. <https://claw.example.dev/projects/channel/C1|More settings>"],
      "toggle-on posts and pins the header",
    );
    f.core.headerPinScopes.delete("channel:C1");
    for (const listener of f.core.headerPinChangeListeners) listener("channel:C1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.client.pinnedByChannel.get("C1"), [], "toggle-off unpins the header");
    assert.equal(f.client.deletes.length, 1, "and deletes the bot's header message");
  } finally {
    await f.stop();
  }
});

test("a mention in a channel with no pinned header never creates one", async () => {
  const f = await fixture({ webUiPublicUrl: "https://claw.example.dev" });
  try {
    const mention = { channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> hi", ts: "100.1" };
    f.client.messagesByChannel.set("C1", [mention]);
    await f.app.emitEvent("app_mention", mention, "Ev-channel-header");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.client.pinnedByChannel.get("C1"), undefined);
    assert.deepEqual(f.client.updates, []);
  } finally {
    await f.stop();
  }
});

test("a scope's model change rewrites its channel's pinned header without waiting for a message", async () => {
  const f = await fixture({ webUiPublicUrl: "https://claw.example.dev" });
  try {
    assert.equal(f.core.modelChangeListeners.length, 1, "the plugin subscribes to core's model changes");
    f.core.headerPinScopes.add("channel:C1");
    f.client.pinnedByChannel.set("C1", [
      {
        ts: "50.0",
        user: "UBOT",
        text: "Using Claude Sonnet 5 here. <https://claw.example.dev/projects/channel/C1|More settings>",
      },
    ]);
    for (const listener of f.core.modelChangeListeners) listener("channel:C1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      f.client.updates.map((u) => ({ channel: u.channel, ts: u.ts, text: u.text })),
      [
        {
          channel: "C1",
          ts: "50.0",
          text: "Using Claude Opus 4.8 here. <https://claw.example.dev/projects/channel/C1|More settings>",
        },
      ],
    );
    for (const listener of f.core.modelChangeListeners) listener("personal:alice@example.com");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.client.topics, [], "a DM's topic settles on the person's next message, not on a push");
  } finally {
    await f.stop();
  }
});

test("an external guest's DM never reveals the model or the web surface", async () => {
  const f = await fixture({ externalParticipants: true, webUiPublicUrl: "https://claw.example.dev" });
  try {
    await f.app.emitMessage({ channel: "DX", channel_type: "im", user: "UX", text: "hello", ts: "100.1" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.client.topics, []);
  } finally {
    await f.stop();
  }
});

test("a DM containing !version follows the ordinary turn path", async () => {
  const f = await fixture();
  try {
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "!version", ts: "100.2" });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].text, "!version");
    assert.deepEqual(
      f.client.posts.map((p) => p.text),
      ["agent reply"],
    );
  } finally {
    await f.stop();
  }
});

test("Slack redelivery and app_mention/message fan-out cannot duplicate a turn", async () => {
  const f = await fixture();
  try {
    const dm = { channel: "D1", channel_type: "im", user: "U1", text: "once", ts: "101.1" };
    await f.app.emitMessage(dm, "Ev-first-delivery");
    await f.app.emitMessage(dm, "Ev-second-delivery");

    const mention = { channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> once too", ts: "101.2" };
    f.client.messagesByChannel.set("C1", [mention]);
    await f.app.emitEvent("app_mention", mention, "Ev-mention");
    await f.app.emitMessage(mention, "Ev-message-copy");

    assert.equal(f.core.turns.length, 2);
    assert.equal(f.client.posts.length, 2);
  } finally {
    await f.stop();
  }
});

test("an unknown user fails closed even when Slack lookup returns no record", async () => {
  const f = await fixture();
  try {
    await f.app.emitMessage({ channel: "DU", channel_type: "im", user: "UUNKNOWN", text: "hello", ts: "101.3" });
    assert.equal(f.core.turns.length, 0);
    assert.equal(
      f.core.ingests.flat().some((event) => event.text === "hello"),
      false,
    );
    assert.match(f.client.posts[0].text, /isn't fully internal/);
  } finally {
    await f.stop();
  }
});

test("an external principal is refused in a DM before core sees the text", async () => {
  const f = await fixture();
  try {
    await f.app.emitMessage({ channel: "DX", channel_type: "im", user: "UX", text: "exfiltrate this", ts: "102.1" });
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.client.posts.length, 1);
    assert.match(f.client.posts[0].text, /isn't fully internal/);
    assert.equal(
      f.core.ingests.flat().some((event) => event.text === "exfiltrate this"),
      false,
    );
  } finally {
    await f.stop();
  }
});

test("a bot-authored mention can become a turn", async () => {
  const f = await fixture();
  try {
    f.client.usersById.set("B1", {
      id: "B1",
      team_id: "T1",
      is_bot: true,
      name: "peerbot",
      profile: { display_name: "Peer Bot" },
    });
    f.client.membersByChannel.set("C1", ["U1", "U2", "B1", "UBOT"]);
    await f.app.emitEvent("app_mention", {
      channel: "C1",
      channel_type: "channel",
      user: "B1",
      bot_id: "B-PEER",
      text: "<@UBOT> hello",
      ts: "102.2",
    });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].actor.externalId, "B1");
    assert.equal(f.client.posts[0].text, "agent reply");
  } finally {
    await f.stop();
  }
});

test("a bot-authored mention without a user resolves its bot principal", async () => {
  const f = await fixture();
  try {
    f.client.usersById.set("B1", {
      id: "B1",
      team_id: "T1",
      is_bot: true,
      name: "peerbot",
      profile: { display_name: "Peer Bot" },
    });
    f.client.botsById.set("B-PEER", { id: "B-PEER", user_id: "B1", name: "Peer Bot" });
    f.client.membersByChannel.set("C1", ["U1", "U2", "B1", "UBOT"]);
    await f.app.emitEvent("app_mention", {
      channel: "C1",
      channel_type: "channel",
      bot_id: "B-PEER",
      text: "<@UBOT> hello",
      ts: "102.25",
    });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].actor.externalId, "B1");
  } finally {
    await f.stop();
  }
});

test("a verified legacy bot without a user principal can become a turn", async () => {
  const f = await fixture();
  try {
    f.client.botsById.set("B-LEGACY", { id: "B-LEGACY", name: "Legacy Bot" });
    await f.app.emitEvent("app_mention", {
      channel: "C1",
      channel_type: "channel",
      bot_id: "B-LEGACY",
      text: "<@UBOT> hello",
      ts: "102.26",
    });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].actor.externalId, "B-LEGACY");
  } finally {
    await f.stop();
  }
});

test("a bot-authored stop can abort a live run", async () => {
  const f = await fixture();
  try {
    f.client.usersById.set("B1", {
      id: "B1",
      team_id: "T1",
      is_bot: true,
      name: "peerbot",
      profile: { display_name: "Peer Bot" },
    });
    f.core.activeRun = "run-active";
    await f.app.emitMessage({
      channel: "D1",
      channel_type: "im",
      subtype: "bot_message",
      user: "B1",
      bot_id: "B-PEER",
      text: "stop",
      ts: "102.3",
    });
    assert.deepEqual(f.core.abortedRuns, ["run-active"]);
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.core.ackPicks.length, 0);
  } finally {
    await f.stop();
  }
});

test("a Slack Connect mention is refused ephemerally and never mirrored", async () => {
  const f = await fixture();
  try {
    f.core.activeRun = "run-active";
    const event = { channel: "CX", channel_type: "channel", user: "U1", text: "<@UBOT> stop", ts: "103.1" };
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.core.abortedRuns.length, 0);
    assert.equal(f.core.ackPicks.length, 0);
    assert.equal(f.core.ingests.length, 0);
    assert.equal(f.client.posts.length, 0);
    assert.equal(f.client.ephemerals.length, 1);
    assert.match(f.client.ephemerals[0].text, /isn't fully internal/);
  } finally {
    await f.stop();
  }
});

test("an unreadable channel roster fails closed before core or mirror ingestion", async () => {
  const f = await fixture();
  try {
    f.client.membershipFailures.add("C1");
    await f.app.emitEvent("app_mention", {
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "<@UBOT> hello",
      ts: "103.2",
    });
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.core.ingests.length, 0);
    assert.equal(f.client.ephemerals.length, 1);
  } finally {
    await f.stop();
  }
});

test("the admin external-participant toggle permits capability without hiding the guest audience", async () => {
  const f = await fixture({ externalParticipants: true });
  try {
    const event = { channel: "CX", channel_type: "channel", user: "U1", text: "<@UBOT> collaborate", ts: "103.3" };
    f.client.messagesByChannel.set("CX", [event]);
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 1);
    assert.equal(
      f.core.turns[0].conversation.audience.some((a: any) => a.externalId === "UX" && a.isExternalGuest),
      true,
    );
    assert.equal(f.client.posts[0].text, "agent reply");
    assert.equal(
      f.core.ingests.flat().some((e: any) => e.ts === "103.3"),
      true,
    );
  } finally {
    await f.stop();
  }
});

test("a core boundary refusal stays requester-only in a channel", async () => {
  const f = await fixture({ externalParticipants: true });
  try {
    f.core.result = { status: "refused", reason: "conversation must be fully internal" };
    const event = { channel: "CX", channel_type: "channel", user: "U1", text: "<@UBOT> collaborate", ts: "103.4" };
    f.client.messagesByChannel.set("CX", [event]);
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.client.posts.length, 0);
    assert.equal(f.client.ephemerals.length, 1);
    assert.match(f.client.ephemerals[0].text, /fully internal/);
  } finally {
    await f.stop();
  }
});

test("an internal channel mention carries the complete audience and thread context", async () => {
  const f = await fixture();
  try {
    const event = { channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> status?", ts: "104.1" };
    f.client.messagesByChannel.set("C1", [event]);
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].text, "status?");
    assert.equal(f.core.turns[0].conversation.threadRef, "ch:C1:104.1");
    assert.equal(f.core.turns[0].conversation.channelRef, "C1");
    assert.deepEqual(f.core.turns[0].conversation.audience.map((a: any) => a.externalId).sort(), ["U1", "U2"]);
    assert.equal(f.core.turns[0].deliveryTarget, "C1:104.1");
    assert.equal(f.client.posts[0].thread_ts, "104.1");
    assert.equal(
      f.core.ingests.flat().some((e: any) => e.ts === "104.1" && e.handled && e.mentionsSelf),
      true,
    );
  } finally {
    await f.stop();
  }
});

test("an unaddressed top-level channel message is mirrored but never becomes a turn", async () => {
  const f = await fixture();
  try {
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      user: "U2",
      text: "ambient update",
      ts: "104.2",
    });
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.client.posts.length, 0);
    assert.equal(
      f.core.ingests.flat().some((e: any) => e.ts === "104.2" && e.text === "ambient update" && !e.handled),
      true,
    );
  } finally {
    await f.stop();
  }
});

test("a group-DM thread-follow runs unprompted yet attests its author's liveness", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G1", { id: "G1", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G1", ["U1", "U2", "UBOT"]);
    f.client.messagesByChannel.set("G1", [
      { channel: "G1", user: "U1", text: "kick off", ts: "300.1" },
      { channel: "G1", user: "UBOT", text: "on it", ts: "300.2", thread_ts: "300.1" },
    ]);
    await f.app.emitMessage({
      channel: "G1",
      channel_type: "mpim",
      user: "U2",
      text: "also update the skill",
      ts: "300.3",
      thread_ts: "300.1",
    });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].unprompted, true);
    assert.equal(f.core.turns[0].entryTs, "300.3");
    assert.equal(f.core.turns[0].liveActor, true, "a member's own verbatim follow-up is a live act");
    assert.equal(f.core.turns[0].conversation.kind, "group");
    assert.equal(f.core.turns[0].conversation.threadRef, "grp:G1:300.1");
  } finally {
    await f.stop();
  }
});

test("a message from an unseen group DM resyncs the directory so it becomes addressable", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G9", { id: "G9", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G9", ["U1", "U2", "UBOT"]);
    const listedBefore = f.client.groupListings;
    await f.app.emitMessage({ channel: "G9", channel_type: "mpim", user: "U1", text: "hi", ts: "400.1" });
    await waitFor(() => f.client.groupListings > listedBefore);
    await waitFor(() => (f.core.directories.at(-1)?.groupMembers ?? []).some((g: any) => g.groupId === "G9"));
    assert.deepEqual(
      f.core.directories
        .at(-1)
        .groupMembers.filter((g: any) => g.groupId === "G9")
        .map((g: any) => g.principalId)
        .sort(),
      ["U1", "U2"],
      "the new group's internal roster reaches core, bot excluded",
    );

    const listedAfter = f.client.groupListings;
    await f.app.emitMessage({ channel: "G9", channel_type: "mpim", user: "U1", text: "again", ts: "400.2" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.client.groupListings, listedAfter, "a group DM already seen does not resync on every message");
  } finally {
    await f.stop();
  }
});

test("a failed group listing pushes its fallback rows under the OLD stamp, never a fresh one", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G7", { id: "G7", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G7", ["U1", "U2", "UBOT"]);
    await f.app.emitMessage({ channel: "G7", channel_type: "mpim", user: "U1", text: "hi", ts: "402.1" });
    await waitFor(() =>
      f.core.directories.some((d: any) => (d.groupMembers ?? []).some((g: any) => g.groupId === "G7")),
    );
    const goodStamp = f.core.directories.findLast((d: any) => d.groupsSyncedAt !== undefined).groupsSyncedAt;
    assert.ok(goodStamp > 0);

    f.client.failGroupListing = true;
    f.client.channelsById.set("G6", { id: "G6", name: "", is_member: true, is_private: true, is_mpim: true });
    await f.app.emitMessage({ channel: "G6", channel_type: "mpim", user: "U1", text: "hi", ts: "402.2" });
    await waitFor(() => f.core.directories.findLast((d: any) => d.channels)?.channelsSyncedAt > goodStamp);
    const last = f.core.directories.findLast((d: any) => d.channels);
    assert.equal(
      last.groupMembers,
      undefined,
      "a failed group listing must omit the groups section, never ship rows under a fresh stamp",
    );
  } finally {
    await f.stop();
  }
});

test("a failed group member read marks only that roster unknown", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G5", { id: "G5", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G5", ["U1", "U2", "UBOT"]);
    await f.app.emitMessage({ channel: "G5", channel_type: "mpim", user: "U1", text: "hi", ts: "403.1" });
    await waitFor(() =>
      f.core.directories.some((d: any) => (d.groupMembers ?? []).some((g: any) => g.groupId === "G5")),
    );
    const good = f.core.directories.findLast((d: any) => d.groupsSyncedAt !== undefined);
    f.client.membershipFailures.add("G5");
    const pushes = f.core.directories.length;
    await f.app.emitMessage({ channel: "G5", channel_type: "mpim", subtype: "group_join", ts: "403.2" });
    await waitFor(() => f.core.directories.length > pushes);
    const last = f.core.directories.at(-1);
    assert.ok(last.groupsSyncedAt > good.groupsSyncedAt);
    assert.ok(last.groupIds.includes("G5"));
    assert.ok(!last.groupRosterIds.includes("G5"));
    assert.equal(last.groupMembers.filter((member: any) => member.groupId === "G5").length, 0);
  } finally {
    await f.stop();
  }
});

test("all listed group DMs reach the directory past the legacy private-channel cap", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 51; i++) {
      const id = `G${i}`;
      f.client.channelsById.set(id, { id, name: "", is_member: true, is_private: true, is_mpim: true });
      f.client.membersByChannel.set(id, ["U1", "U2", "UBOT"]);
    }
    const pushes = f.core.directories.length;
    await f.app.emitMessage({ channel: "G0", channel_type: "mpim", subtype: "group_join", ts: "403.3" });
    await waitFor(() => f.core.directories.length > pushes);
    assert.equal(new Set(f.core.directories.at(-1).groupMembers.map((member: any) => member.groupId)).size, 51);
  } finally {
    await f.stop();
  }
});

test("a group DM whose listing fails is retried at most once, never once per message", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G8", { id: "G8", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G8", ["U1", "U2", "UBOT"]);
    f.client.failGroupListing = true;
    const listedBefore = f.client.groupListings;
    for (const ts of ["401.1", "401.2", "401.3"]) {
      await f.app.emitMessage({ channel: "G8", channel_type: "mpim", user: "U1", text: "hi", ts });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      f.client.groupListings - listedBefore,
      1,
      "a failing listing must not make every message trigger another full sync",
    );
  } finally {
    await f.stop();
  }
});

test("a peer bot's thread reply dispatches without attesting liveness", async () => {
  const f = await fixture();
  try {
    f.client.usersById.set("UB2", { id: "UB2", team_id: "T1", name: "copilot", is_bot: true });
    f.client.membersByChannel.set("C1", ["U1", "U2", "UB2", "UBOT"]);
    f.client.messagesByChannel.set("C1", [
      { channel: "C1", user: "U1", text: "kick off", ts: "301.1" },
      { channel: "C1", user: "UBOT", text: "on it", ts: "301.2", thread_ts: "301.1" },
    ]);
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "bot_message",
      user: "UB2",
      text: "automated status: done",
      ts: "301.3",
      thread_ts: "301.1",
    });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].unprompted, true);
    assert.equal(f.core.turns[0].entryTs, "301.3");
    assert.equal(f.core.turns[0].liveActor, undefined, "a bot author is automation, never a live act");
  } finally {
    await f.stop();
  }
});

test("an untrusted inbound file URL is never fetched and reaches core only as a missing-file note", async (t) => {
  const f = await fixture();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("untrusted URL was fetched");
  });
  try {
    await f.app.emitMessage({
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "inspect this",
      ts: "104.3",
      files: [{ id: "F1", name: "payload.txt", url_private_download: "https://evil.example/payload.txt" }],
    });
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].attachments, undefined);
    assert.match(f.core.turns[0].inboundNotes[0], /payload\.txt/);
  } finally {
    await f.stop();
  }
});

test("message edits and deletes update the mirror without creating turns", async () => {
  const f = await fixture();
  try {
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: { channel_type: "channel", user: "U1", text: "edited", ts: "105.1" },
      ts: "105.2",
    });
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_deleted",
      deleted_ts: "105.1",
      ts: "105.3",
    });
    assert.equal(f.core.turns.length, 0);
    const events = f.core.ingests.flat();
    assert.equal(
      events.some((e: any) => e.ts === "105.1" && e.text === "edited" && typeof e.editedAt === "number"),
      true,
    );
    assert.equal(
      events.some((e: any) => e.ts === "105.1" && e.deleted === true),
      true,
    );
  } finally {
    await f.stop();
  }
});

test("raw core failures never leak through Slack", async () => {
  const f = await fixture();
  try {
    f.core.submitError = new Error("password=super-secret postgres://internal-db/run/abc");
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "106.1" });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.client.posts.length, 1);
    assert.match(f.client.posts[0].text, /couldn't reach the agent core/);
    assert.doesNotMatch(f.client.posts[0].text, /super-secret|postgres|run\/abc/);
  } finally {
    await f.stop();
  }
});

test("stop aborts the active run without enqueuing a second turn", async () => {
  const f = await fixture();
  try {
    f.core.activeRun = "run-active";
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "stop", ts: "107.1" });
    assert.deepEqual(f.core.abortedRuns, ["run-active"]);
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.client.posts.length, 0);
  } finally {
    await f.stop();
  }
});
