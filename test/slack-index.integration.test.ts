import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { SlackCoreClient } from "../src/slack/index.ts";
import type { SlackAgentRequestContext } from "../src/api/slack-core-client.ts";
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
    add: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
    get: async () => ({}),
  };
  readonly filesById = new Map<string, any>();
  readonly fileInfoCalls: string[] = [];
  readonly files = {
    uploadV2: async () => ({ ok: true }),
    info: async ({ file }: { file: string }) => {
      this.fileInfoCalls.push(file);
      return { file: this.filesById.get(file) ?? {} };
    },
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

  async emitMessage(message: any, eventId = `Ev-${message.channel}-${message.ts}`, context: any = {}): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler({ message, body: { event_id: eventId }, client: this.client, context });
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
mock.module("@slack/web-api", {
  namedExports: {
    WebClient: class {
      get conversations() {
        return FakeApp.instances.at(-1)!.client.conversations;
      }
    },
  },
});

const { slackPluginConfigFromEnv, startSlackPlugin } = await import("../src/slack/index.ts");

class FakeCore implements SlackCoreClient {
  async decideDeploymentAccess(): Promise<string> {
    throw new Error("not used");
  }
  async inboxSlackMessage(): Promise<void> {}
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
  engageRun = false;
  sessionStatus?: SlackCoreClient["sessionStatus"];
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
  async internalMemberOverrides(): Promise<string[]> {
    return [];
  }
  async ackEmojiOverride(): Promise<string[] | null> {
    return null;
  }
  readonly publishedEmojiCatalogs: Array<Record<string, string>> = [];
  async publishEmojiCatalog(emoji: Record<string, string>): Promise<void> {
    this.publishedEmojiCatalogs.push(emoji);
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
      const steered = this.heldRunClaimed;
      this.heldRunClaimed = true;
      return { status: "queued", runId: this.queuedRunId, ...(steered ? { steered: true as const } : {}) };
    }
    return this.result;
  }
  async waitRun(runId: string, hooks?: { onReplying?(): void }): Promise<TurnResult | null> {
    this.polled.push(runId);
    if (this.engageRun) hooks?.onReplying?.();
    if (this.runGate) await this.runGate;
    return this.result;
  }
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
  async stopConversation(): Promise<boolean> {
    if (!this.activeRun) return false;
    await this.signalRunAbort(this.activeRun);
    return true;
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
  readonly agentRequests = new Map<string, SlackAgentRequestContext>();
  async putAgentRequest(requestId: string, record: SlackAgentRequestContext): Promise<void> {
    this.agentRequests.set(requestId, record);
  }
  async getAgentRequest(requestId: string): Promise<SlackAgentRequestContext | null> {
    return this.agentRequests.get(requestId) ?? null;
  }
  async takeAgentRequest(requestId: string): Promise<SlackAgentRequestContext | null> {
    const record = this.agentRequests.get(requestId) ?? null;
    this.agentRequests.delete(requestId);
    return record;
  }
  async agentRequestForApproval(approvalRequestId: string): Promise<SlackAgentRequestContext | null> {
    for (const record of this.agentRequests.values()) {
      if (record.approvalRequestIds?.includes(approvalRequestId)) return record;
    }
    return null;
  }
  async pushDirectory(body: any): Promise<boolean> {
    this.directories.push(body);
    return true;
  }
  holdDeliveryDispatch<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
    return fn(new Promise<void>(() => {}));
  }
  holdDirectorySync<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
    return fn(new Promise<void>(() => {}));
  }

  holdEnvelopeReplay<T>(_account: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
    return fn(new Promise<void>(() => {}));
  }

  async claimDeliveries(): Promise<[]> {
    return [];
  }
  async ackDelivery(): Promise<void> {}
  deliverySubscriptions = 0;
  onDeliveryEnqueued(): () => void {
    this.deliverySubscriptions++;
    return () => {};
  }
  async pendingContextRequests(): Promise<[]> {
    return [];
  }
  contextSubscriptions = 0;
  onContextRequest(): () => void {
    this.contextSubscriptions++;
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
    allowFrom?: string[];
    denyMessage?: string;
    coreSingleton?: boolean;
  } = {},
) {
  const core = new FakeCore();
  core.externalParticipants = options.externalParticipants ?? false;
  const started = startSlackPlugin(
    {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      identityEmail: options.identityEmail ?? "0",
      ...(options.allowFrom ? { allowFrom: options.allowFrom } : {}),
      ...(options.denyMessage ? { denyMessage: options.denyMessage } : {}),
      ...(options.coreSingleton === undefined ? {} : { coreSingleton: options.coreSingleton }),
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

function addGroup(client: FakeSlackClient, id: string, members = ["U1", "U2", "UBOT"]): void {
  client.channelsById.set(id, { id, name: "", is_member: true, is_private: true, is_mpim: true });
  client.membersByChannel.set(id, members);
}

async function inFixture(
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  options: Parameters<typeof fixture>[0] = {},
): Promise<void> {
  const f = await fixture(options);
  try {
    await run(f);
  } finally {
    await f.stop();
  }
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

test("a core failure the user is told about counts as handled; a quiet one reports failure and forgets the dedup key", () =>
  inFixture(async (f) => {
    const gate: string[] = [];
    const ackGate = {
      persisted: () => gate.push("persisted"),
      failed: (reason?: string) => gate.push(`failed:${typeof reason}`),
    };
    f.core.submitError = new Error("db down");
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "ask", ts: "700.1" }, "Ev-700", {
      ackGate,
    });
    assert.deepEqual(gate, [], "the error note the user saw is the outcome; nothing is left for replay");
    assert.ok(
      f.client.posts.some((m: any) => String(m.text).includes("⚠️")) ||
        f.client.ephemerals.some((m: any) => String(m.text).includes("⚠️")),
    );

    addGroup(f.client, "G1");
    f.client.messagesByChannel.set("G1", [
      { channel: "G1", user: "U1", text: "kick off", ts: "300.1" },
      { channel: "G1", user: "UBOT", text: "on it", ts: "300.2", thread_ts: "300.1" },
    ]);
    const quiet = {
      channel: "G1",
      channel_type: "mpim",
      user: "U2",
      text: "also this",
      ts: "300.3",
      thread_ts: "300.1",
    };
    await f.app.emitMessage(quiet, "Ev-300", { ackGate });
    assert.deepEqual(gate, ["failed:string"], "a quiet failure keeps the staged envelope for replay");
    const turnsBefore = f.core.turns.length;
    f.core.submitError = undefined;
    f.core.queuedRunId = "R9";
    await f.app.emitMessage(quiet, "Ev-300-replay", { ackGate });
    assert.equal(f.core.turns.length, turnsBefore + 1, "the replay is not swallowed by the in-process deduper");
    assert.deepEqual(gate, ["failed:string", "persisted"]);
  }));

test("a redelivery of a message still in flight on this instance is not treated as handled", () =>
  inFixture(async (f) => {
    const gate: string[] = [];
    const ackGate = {
      persisted: () => gate.push("persisted"),
      failed: (reason?: string) => gate.push(`failed:${reason}`),
    };
    f.core.holdRun("R1");
    const first = f.app.emitMessage(
      { channel: "D1", channel_type: "im", user: "U1", text: "slow ask", ts: "800.1" },
      "Ev-800",
    );
    await new Promise((resolve) => setImmediate(resolve));
    await f.app.emitMessage(
      { channel: "D1", channel_type: "im", user: "U1", text: "slow ask", ts: "800.1" },
      "Ev-800-again",
      {
        ackGate,
      },
    );
    assert.deepEqual(
      gate,
      ["failed:already in flight on this instance"],
      "the row stays until the live handler accepts",
    );
    assert.equal(f.core.turns.length, 1, "the in-flight turn is not run a second time");
    f.core.finishRun({ status: "ok", reply: "done" });
    await first;
  }));

test("a mid-turn message that STEERS the live run does not post the reply twice", () =>
  inFixture(async (f) => {
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
  }));

test("a queued run's ok reply carries the recovery delivery's marker, so a replay reuses it", () =>
  inFixture(async (f) => {
    f.core.holdRun("R7");
    const turn = f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "ask", ts: "600.1" });
    await waitFor(() => f.core.polled.length === 1);
    f.core.finishRun({ status: "ok", reply: "agent reply" });
    await turn;

    const reply = f.client.posts.find((p) => p.text === "agent reply");
    assert.deepEqual(reply?.metadata, {
      event_type: "qm_delivery",
      event_payload: { idempotency_key: "run:R7" },
    });

    f.client.messagesByChannel.set("D1", [{ ts: "posted-1", metadata: reply.metadata }]);
    const postsBefore = f.client.posts.length;
    const { postWithVerify } = await import("../src/slack/delivery.ts");
    const replayed = await postWithVerify(f.client as any, { channel: "D1", text: "agent reply" }, "run:R7", {
      verifyFirst: true,
      verifyOldest: "0",
    });
    assert.equal(replayed.ts, "posted-1", "the recovery probe finds the live handler's reply");
    assert.equal(f.client.posts.length, postsBefore, "an already-posted reply is never re-posted");
  }));

test("a DM becomes one scoped live turn and one Slack reply", () =>
  inFixture(async (f) => {
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello agent", ts: "100.1" });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].text, "hello agent");
    assert.equal(f.core.turns[0].conversation.kind, "dm");
    assert.equal(f.core.turns[0].conversation.threadRef, "dm:D1");
    assert.match(f.core.turns[0].redeliveryKey, /^slack:[^:]+:D1:100\.1$/);
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
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "!version", ts: "100.2" });
    assert.equal(f.core.turns.length, 2);
    assert.equal(f.core.turns[1].text, "!version", "a DM containing !version follows the ordinary turn path");
    assert.deepEqual(
      f.client.posts.map((p) => p.text),
      ["agent reply", "agent reply"],
    );
  }));

test("a forwarded Slack message reaches the turn with labeled nested content and files", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("data", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "4" },
      }),
  );
  const f = await fixture();
  try {
    f.client.filesById.set("F1", {
      id: "F1",
      name: "notes.txt",
      mimetype: "text/plain",
      size: 4,
      url_private_download: "https://files.slack.com/files-pri/F1/notes.txt",
    });
    await f.app.emitMessage({
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "please review",
      ts: "100.15",
      attachments: [
        {
          is_msg_unfurl: true,
          author_id: "U2",
          author_name: "Bob",
          channel_name: "project-notes",
          text: "outer message",
          files: [
            {
              id: "F1",
              name: "notes.txt",
              is_hidden_by_limit: 1,
            },
          ],
          message_blocks: [
            {
              message: {
                attachments: [
                  {
                    is_msg_unfurl: true,
                    author_name: "Carol",
                    channel_name: "research",
                    text: "nested message",
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    assert.deepEqual(f.client.fileInfoCalls, ["F1"]);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(f.core.turns.length, 1);
    assert.equal(
      f.core.turns[0].text,
      "please review\n[forwarded message from Bob in #project-notes] outer message\n" +
        "[forwarded message from Carol in #research] nested message",
    );
    assert.deepEqual(f.core.turns[0].attachments, [
      {
        name: "notes.txt",
        mimetype: "text/plain",
        sizeBytes: 4,
        blobId: "blob-1",
        sourceId: "F1",
        author: "Bob",
      },
    ]);
  } finally {
    await f.stop();
  }
});

test("public channel rosters stay current in the core directory", () =>
  inFixture(async (f) => {
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
  }));

test("full directory refreshes bound concurrent Slack roster reads", () =>
  inFixture(
    async (f) => {
      assert.equal(f.client.membershipListings.size, 8);
      assert.ok(f.client.maxActiveMembershipListings > 1);
      assert.ok(f.client.maxActiveMembershipListings <= 4);
      assert.ok(f.core.directories.at(-1).channelsSyncedAt <= f.client.firstMembershipListingStartedAt!);
    },
    { extraChannels: 5, membershipDelayMs: 10 },
  ));

test("large public channels publish their complete roster and accept internal turns", () =>
  inFixture(async (f) => {
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
  }));

test("failed background roster reads are marked unknown instead of clearing known capabilities", () =>
  inFixture(async (f) => {
    assert.ok(f.core.directories.at(-1).channelRosterIds.includes("CPX"));
    f.client.membershipFailures.add("CPX");
    const pushes = f.core.directories.length;
    await f.app.emitEvent("channel_rename", { channel: { id: "CPX" }, event_ts: "100.5" });
    await waitFor(() => f.core.directories.length > pushes);
    assert.ok(!f.core.directories.at(-1).channelRosterIds.includes("CPX"));
  }));

for (const leave of [
  { name: "a failed refresh after a leave event revokes only the departing member", principalId: "U1", ts: "100.6" },
  {
    name: "a failed email-mode refresh revokes the departing canonical principal",
    principalId: "alice@example.com",
    ts: "100.7",
    identityEmail: "1" as const,
  },
]) {
  test(leave.name, () =>
    inFixture(
      async (f) => {
        f.client.membershipFailures.add("CPX");
        const pushes = f.core.directories.length;
        await f.app.emitEvent("member_left_channel", { user: "U1", channel: "CPX", event_ts: leave.ts });
        await waitFor(() => f.core.directories.length > pushes);
        const pushed = f.core.directories.at(-1);
        assert.ok(!pushed.channelRosterIds.includes("CPX"));
        assert.deepEqual(pushed.channelRevocations, [{ channelId: "CPX", principalId: leave.principalId }]);
      },
      { identityEmail: leave.identityEmail },
    ),
  );
}

test("Slack Connect directory rosters contain only internal principals", () =>
  inFixture(
    async (f) => {
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
    },
    { externalParticipants: true },
  ));

test("a human's DM sets the conversation header to the serving model + web surface", () =>
  inFixture(
    async (f) => {
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
    },
    { webUiPublicUrl: "https://claw.example.dev" },
  ));

for (const join of [
  {
    name: "joining a channel posts the welcome and a pinned header naming the model and project page",
    pin: true,
    posts: 2,
    pinned: ["Using Claude Opus 4.8 here. <https://claw.example.dev/projects/channel/C1|More settings>"],
  },
  { name: "joining a channel with the toggle off (the default) posts only the welcome — no pin", posts: 1 },
  {
    name: "a gated account joining a channel stays silent — no welcome, no header",
    pin: true,
    posts: 0,
    options: { identityEmail: "1" as const, allowFrom: ["staff@example.com"] },
  },
]) {
  test(join.name, () =>
    inFixture(
      async (f) => {
        if (join.pin) f.core.headerPinScopes.add("channel:C1");
        await f.app.emitEvent(
          "member_joined_channel",
          { user: "UBOT", channel: "C1", event_ts: "100.1" },
          "Ev-bot-join",
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(f.client.posts.length, join.posts);
        assert.deepEqual(
          f.client.pinnedByChannel.get("C1")?.map((m) => m.text),
          join.pinned,
        );
        assert.deepEqual(f.client.topics, [], "a channel's topic stays the members' own scratch space");
      },
      { webUiPublicUrl: "https://claw.example.dev", ...join.options },
    ),
  );
}

test("flipping the toggle on creates the pinned header; flipping it off removes it", () =>
  inFixture(
    async (f) => {
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
    },
    { webUiPublicUrl: "https://claw.example.dev" },
  ));

test("a mention in a channel with no pinned header never creates one", () =>
  inFixture(
    async (f) => {
      const mention = { channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> hi", ts: "100.1" };
      f.client.messagesByChannel.set("C1", [mention]);
      await f.app.emitEvent("app_mention", mention, "Ev-channel-header");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(f.client.pinnedByChannel.get("C1"), undefined);
      assert.deepEqual(f.client.updates, []);
    },
    { webUiPublicUrl: "https://claw.example.dev" },
  ));

test("a scope's model change rewrites its channel's pinned header without waiting for a message", () =>
  inFixture(
    async (f) => {
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
    },
    { webUiPublicUrl: "https://claw.example.dev" },
  ));

test("an external guest's DM never reveals the model or the web surface", () =>
  inFixture(
    async (f) => {
      await f.app.emitMessage({ channel: "DX", channel_type: "im", user: "UX", text: "hello", ts: "100.1" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(f.client.topics, []);
    },
    { externalParticipants: true, webUiPublicUrl: "https://claw.example.dev" },
  ));

test("Slack redelivery and app_mention/message fan-out cannot duplicate a turn", () =>
  inFixture(async (f) => {
    const dm = { channel: "D1", channel_type: "im", user: "U1", text: "once", ts: "101.1" };
    await f.app.emitMessage(dm, "Ev-first-delivery");
    await f.app.emitMessage(dm, "Ev-second-delivery");

    const mention = { channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> once too", ts: "101.2" };
    f.client.messagesByChannel.set("C1", [mention]);
    await f.app.emitEvent("app_mention", mention, "Ev-mention");
    await f.app.emitMessage(mention, "Ev-message-copy");

    assert.equal(f.core.turns.length, 2);
    assert.equal(f.client.posts.length, 2);
  }));

for (const { name, ...refused } of [
  {
    name: "an unknown user fails closed even when Slack lookup returns no record",
    channel: "DU",
    user: "UUNKNOWN",
    ts: "101.3",
  },
  {
    name: "an external principal is refused in a DM before core sees the text",
    channel: "DX",
    user: "UX",
    ts: "102.1",
  },
]) {
  test(name, () =>
    inFixture(async (f) => {
      await f.app.emitMessage({ channel_type: "im", text: "exfiltrate this", ...refused });
      assert.equal(f.core.turns.length, 0);
      assert.equal(f.client.posts.length, 1);
      assert.match(f.client.posts[0].text, /isn't fully internal/);
      assert.equal(
        f.core.ingests.flat().some((event) => event.text === "exfiltrate this"),
        false,
      );
    }),
  );
}

const peerBot = { id: "B1", team_id: "T1", is_bot: true, name: "peerbot", profile: { display_name: "Peer Bot" } };

for (const bot of [
  { name: "a bot-authored mention can become a turn", user: "B1", ts: "102.2", actor: "B1" },
  {
    name: "a bot-authored mention without a user resolves its bot principal",
    record: { id: "B-PEER", user_id: "B1", name: "Peer Bot" },
    ts: "102.25",
    actor: "B1",
  },
  {
    name: "a verified legacy bot without a user principal can become a turn",
    record: { id: "B-LEGACY", name: "Legacy Bot" },
    ts: "102.26",
    actor: "B-LEGACY",
  },
]) {
  test(bot.name, () =>
    inFixture(async (f) => {
      if (bot.actor === "B1") {
        f.client.usersById.set("B1", peerBot);
        f.client.membersByChannel.set("C1", ["U1", "U2", "B1", "UBOT"]);
      }
      if (bot.record) f.client.botsById.set(bot.record.id, bot.record);
      await f.app.emitEvent("app_mention", {
        channel: "C1",
        channel_type: "channel",
        ...(bot.user ? { user: bot.user } : {}),
        bot_id: bot.record?.id ?? "B-PEER",
        text: "<@UBOT> hello",
        ts: bot.ts,
      });
      assert.equal(f.core.turns.length, 1);
      assert.equal(f.core.turns[0].actor.externalId, bot.actor);
      assert.equal(f.client.posts[0].text, "agent reply");
    }),
  );
}

for (const stop of [
  {
    name: "a bot-authored stop can abort a live run",
    message: { subtype: "bot_message", user: "B1", bot_id: "B-PEER", ts: "102.3" },
  },
  { name: "stop aborts the active run without enqueuing a second turn", message: { user: "U1", ts: "107.1" } },
]) {
  test(stop.name, () =>
    inFixture(async (f) => {
      f.client.usersById.set("B1", peerBot);
      f.core.activeRun = "run-active";
      await f.app.emitMessage({ channel: "D1", channel_type: "im", text: "stop", ...stop.message });
      assert.deepEqual(f.core.abortedRuns, ["run-active"]);
      assert.equal(f.core.turns.length, 0);
      assert.equal(f.core.ackPicks.length, 0);
      assert.equal(f.client.posts.length, 0);
    }),
  );
}

test("a Slack Connect mention is refused ephemerally and never mirrored", () =>
  inFixture(async (f) => {
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
  }));

test("an unreadable channel roster fails closed before core or mirror ingestion", () =>
  inFixture(async (f) => {
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
  }));

test("the admin external-participant toggle permits capability without hiding the guest audience", () =>
  inFixture(
    async (f) => {
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
    },
    { externalParticipants: true },
  ));

test("a core boundary refusal stays requester-only in a channel", () =>
  inFixture(
    async (f) => {
      f.core.result = { status: "refused", reason: "conversation must be fully internal" };
      const event = { channel: "CX", channel_type: "channel", user: "U1", text: "<@UBOT> collaborate", ts: "103.4" };
      f.client.messagesByChannel.set("CX", [event]);
      await f.app.emitEvent("app_mention", event);
      assert.equal(f.core.turns.length, 1);
      assert.equal(f.client.posts.length, 0);
      assert.equal(f.client.ephemerals.length, 1);
      assert.match(f.client.ephemerals[0].text, /fully internal/);
    },
    { externalParticipants: true },
  ));

test("a blocked-thread result without approval details tells only the sender instead of posting a dead approval card", () =>
  inFixture(async (f) => {
    f.core.result = {
      status: "pending_approval",
      sessionId: "S1",
      reason: "This conversation is waiting for someone else to resolve a pending approval.",
    };
    const event = { channel: "C1", channel_type: "channel", user: "U2", text: "<@UBOT> any update?", ts: "105.1" };
    f.client.messagesByChannel.set("C1", [event]);
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.client.posts.length, 0, "no public post and no approval buttons for a non-requester");
    assert.equal(f.client.ephemerals.length, 1);
    assert.match(f.client.ephemerals[0].text, /waiting for someone else/);
    assert.equal(f.client.ephemerals[0].blocks, undefined);
  }));

test("an internal channel mention carries the complete audience and thread context", () =>
  inFixture(async (f) => {
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
  }));

test("an unaddressed top-level channel message is mirrored but never becomes a turn", () =>
  inFixture(async (f) => {
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
  }));

test("a group-DM thread-follow runs unprompted yet attests its author's liveness", () =>
  inFixture(async (f) => {
    addGroup(f.client, "G1");
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
  }));

test("a message from an unseen group DM resyncs the directory so it becomes addressable", () =>
  inFixture(async (f) => {
    addGroup(f.client, "G9");
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
  }));

test("a failed group listing pushes its fallback rows under the OLD stamp, never a fresh one", () =>
  inFixture(async (f) => {
    addGroup(f.client, "G7");
    await f.app.emitMessage({ channel: "G7", channel_type: "mpim", user: "U1", text: "hi", ts: "402.1" });
    await waitFor(() =>
      f.core.directories.some((d: any) => (d.groupMembers ?? []).some((g: any) => g.groupId === "G7")),
    );
    const goodStamp = f.core.directories.findLast((d: any) => d.groupsSyncedAt !== undefined).groupsSyncedAt;
    assert.ok(goodStamp > 0);

    f.client.failGroupListing = true;
    addGroup(f.client, "G6", []);
    await f.app.emitMessage({ channel: "G6", channel_type: "mpim", user: "U1", text: "hi", ts: "402.2" });
    await waitFor(() => f.core.directories.findLast((d: any) => d.channels)?.channelsSyncedAt > goodStamp);
    const last = f.core.directories.findLast((d: any) => d.channels);
    assert.equal(
      last.groupMembers,
      undefined,
      "a failed group listing must omit the groups section, never ship rows under a fresh stamp",
    );
  }));

test("a failed group member read marks only that roster unknown", () =>
  inFixture(async (f) => {
    addGroup(f.client, "G5");
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
  }));

test("all listed group DMs reach the directory past the legacy private-channel cap", () =>
  inFixture(async (f) => {
    for (let i = 0; i < 51; i++) addGroup(f.client, `G${i}`);
    const pushes = f.core.directories.length;
    await f.app.emitMessage({ channel: "G0", channel_type: "mpim", subtype: "group_join", ts: "403.3" });
    await waitFor(() => f.core.directories.length > pushes);
    assert.equal(new Set(f.core.directories.at(-1).groupMembers.map((member: any) => member.groupId)).size, 51);
  }));

test("a group DM whose listing fails is retried at most once, never once per message", () =>
  inFixture(async (f) => {
    addGroup(f.client, "G8");
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
  }));

test("a peer bot's thread reply dispatches without attesting liveness", () =>
  inFixture(async (f) => {
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
  }));

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

test("message edits and deletes update the mirror without creating turns", () =>
  inFixture(async (f) => {
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
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: { channel_type: "channel", user: "U1", text: "unfurled", ts: "105.7" },
      previous_message: { user: "U1", text: "unfurled" },
      ts: "105.8",
    });
    const unfurl = f.core.ingests.flat().find((e: any) => e.ts === "105.7");
    assert.ok(unfurl, "an unchanged message_changed still refreshes the mirror");
    assert.equal(unfurl.editedAt, undefined, "but it is not stamped as an edit");
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: {
        channel_type: "channel",
        subtype: "tombstone",
        user: "USLACKBOT",
        text: "This message was deleted.",
        ts: "105.9",
      },
      ts: "106.0",
    });
    const tombstone = f.core.ingests.flat().find((e: any) => e.ts === "105.9");
    assert.equal(tombstone?.deleted, true, "a tombstoned thread root reads as a deletion");
  }));

test("a stalled run keeps its still-working wording instead of the generic failure", () =>
  inFixture(async (f) => {
    f.core.submitError = Object.assign(new Error("run stalled"), { code: "run_stalled" });
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "106.0" });
    assert.equal(f.client.posts.length, 1);
    assert.match(f.client.posts[0].text, /taking unusually long/);
  }));

test("raw core failures never leak through Slack", () =>
  inFixture(async (f) => {
    f.core.submitError = new Error("password=super-secret postgres://internal-db/run/abc");
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "106.1" });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.client.posts.length, 1);
    assert.match(f.client.posts[0].text, /Something went wrong on my end/);
    assert.doesNotMatch(f.client.posts[0].text, /super-secret|postgres|run\/abc/);
  }));

test("an allowFrom account answers listed members and is silent to everyone else", () =>
  inFixture(
    async (f) => {
      await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello agent", ts: "300.1" });
      assert.equal(f.core.turns.length, 1);
      assert.equal(f.core.turns[0].conversation.audience[0].externalId, "alice@example.com");
    },
    { identityEmail: "1", allowFrom: ["example.com"] },
  ));

test("an allowFrom account drops unlisted members before any core work", () =>
  inFixture(
    async (f) => {
      await f.app.emitMessage({ channel: "D2", channel_type: "im", user: "U2", text: "hey there", ts: "301.1" });
      await f.app.emitEvent("app_mention", { channel: "C1", user: "U2", text: "<@UBOT> ping", ts: "301.2" });
      assert.equal(f.core.turns.length, 0);
      assert.equal(f.core.ackPicks.length, 0);
      assert.deepEqual(f.core.ingests, []);
      assert.deepEqual(f.client.posts, []);
      assert.deepEqual(f.client.ephemerals, []);
    },
    { identityEmail: "1", allowFrom: ["staff@example.com"] },
  ));

for (const coreSingleton of [false, true]) {
  test(
    coreSingleton
      ? "the default account keeps every core-singleton subsystem and pushes the core directory"
      : "a non-singleton account still serves turns but runs no core-singleton subsystems",
    () =>
      inFixture(
        async (f) => {
          const expected = coreSingleton ? 1 : 0;
          if (coreSingleton) await waitFor(() => f.core.publishedEmojiCatalogs.length === 1);
          assert.equal(f.core.directories.length > 0, coreSingleton);
          assert.equal(f.core.deliverySubscriptions, expected);
          assert.equal(f.core.contextSubscriptions, expected);
          assert.equal(f.core.modelChangeListeners.length, expected);
          assert.equal(f.core.headerPinChangeListeners.length, expected);
          assert.equal(f.core.publishedEmojiCatalogs.length, expected);
          await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello agent", ts: "302.1" });
          assert.equal(f.core.turns.length, 1);
        },
        coreSingleton ? {} : { coreSingleton },
      ),
  );
}
test("a gated account with a denyMessage answers direct approaches with it, once per user", () =>
  inFixture(
    async (f) => {
      await f.app.emitEvent("app_mention", { channel: "C1", user: "U2", text: "<@UBOT> help", ts: "500.1" });
      assert.equal(f.client.ephemerals.length, 1);
      assert.equal(f.client.ephemerals[0].user, "U2");
      assert.equal(f.client.ephemerals[0].text, "I only work with Acme staff — ask your administrator.");
      await f.app.emitEvent("app_mention", { channel: "C1", user: "U2", text: "<@UBOT> hello?", ts: "500.2" });
      assert.equal(f.client.ephemerals.length, 1);
      await f.app.emitMessage({ channel: "D2", channel_type: "im", user: "U2", text: "hi", ts: "500.3" });
      assert.equal(f.client.posts.length, 1);
      assert.equal(f.client.posts[0].channel, "D2");
      assert.equal(f.client.posts[0].text, "I only work with Acme staff — ask your administrator.");
      await f.app.emitMessage({ channel: "D2", channel_type: "im", user: "U2", text: "hello??", ts: "500.4" });
      assert.equal(f.client.posts.length, 1);
      assert.equal(f.core.turns.length, 0);
      assert.deepEqual(f.core.ingests, []);
    },
    {
      identityEmail: "1",
      allowFrom: ["staff@example.com"],
      denyMessage: "I only work with Acme staff — ask your administrator.",
    },
  ));

test("a denyMessage account stays silent on ambient channel chatter from unlisted members", () =>
  inFixture(
    async (f) => {
      await f.app.emitMessage({ channel: "C1", channel_type: "channel", user: "U2", text: "morning all", ts: "501.1" });
      assert.deepEqual(f.client.posts, []);
      assert.deepEqual(f.client.ephemerals, []);
      assert.deepEqual(f.core.ingests, []);
    },
    {
      identityEmail: "1",
      allowFrom: ["staff@example.com"],
      denyMessage: "Staff only, I fear.",
    },
  ));

test("thread status is detached from reply delivery and steering cannot take ownership", async () => {
  const f = await fixture({ coreSingleton: false });
  const starts: unknown[][] = [];
  let release!: () => void;
  const network = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.core.sessionStatus = {
    start: async (...args) => {
      starts.push(args.slice(1));
      await network;
    },
    reconcile: async () => {},
  };
  f.core.engageRun = true;
  f.core.holdRun("r1");
  try {
    const original = f.app.emitEvent("app_mention", { channel: "C1", user: "U1", text: "<@UBOT> work", ts: "700.1" });
    await waitFor(() => starts.length === 1);
    await f.app.emitEvent("app_mention", {
      channel: "C1",
      thread_ts: "700.1",
      user: "U1",
      text: "<@UBOT> also this",
      ts: "700.2",
    });
    assert.deepEqual(starts, [["T1:UBOT", "r1", "C1", "700.1"]]);
    f.core.finishRun({ status: "ok", reply: "finished" });
    await original;
    assert.ok(f.client.posts.some((post) => post.text === "finished" && post.thread_ts === "700.1"));
    assert.equal(starts.length, 1);
  } finally {
    release();
    await f.stop();
  }
});

test("top-level DM replies remain top-level and never start native thread status", async () => {
  const f = await fixture();
  let starts = 0;
  f.core.sessionStatus = {
    start: async () => {
      starts++;
    },
    reconcile: async () => {},
  };
  f.core.engageRun = true;
  f.core.holdRun("r1");
  try {
    const incoming = f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "701.1" });
    await waitFor(() => f.core.polled.length === 1);
    f.core.finishRun({ status: "ok", reply: "hello back" });
    await incoming;
    assert.equal(starts, 0);
    assert.ok(f.client.posts.some((post) => post.text === "hello back" && !post.thread_ts));
  } finally {
    await f.stop();
  }
});

test("own task-card status events never enter the mirror, but ordinary bot edits remain", async () => {
  const f = await fixture();
  const status = {
    user: "UBOT",
    bot_id: "BBOT",
    text: "Working",
    ts: "200.1",
    blocks: [{ type: "task_card", task_id: "qm_status:test", title: "Working", status: "in_progress" }],
  };
  try {
    await f.app.emitMessage({ channel: "C1", channel_type: "channel", ...status });
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: { ...status, text: "Finished" },
      previous_message: status,
      ts: "200.2",
    });
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_deleted",
      previous_message: status,
      deleted_ts: status.ts,
      ts: "200.3",
    });
    assert.equal(f.core.ingests.flat().filter((event: any) => event.ts === status.ts).length, 0);
    assert.equal(f.core.turns.length, 0);
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: { user: "UBOT", bot_id: "BBOT", text: "Updated answer", ts: "201.1" },
      ts: "201.2",
    });
    assert.equal(f.core.ingests.flat().find((event: any) => event.ts === "201.1")?.text, "Updated answer");
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      user: "UBOT",
      bot_id: "BBOT",
      text: "ordinary malformed blocks",
      ts: "201.3",
      blocks: { unexpected: true },
    });
    assert.equal(f.core.ingests.flat().find((event: any) => event.ts === "201.3")?.text, "ordinary malformed blocks");
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      ...status,
      user: "U1",
      bot_id: undefined,
      ts: "202.1",
    });
    assert.ok(f.core.ingests.flat().some((event: any) => event.ts === "202.1"));
  } finally {
    await f.stop();
  }
});
