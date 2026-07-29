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
    setPurpose: async ({ channel, purpose }: { channel: string; purpose: string }) => {
      this.purposes.push({ channel, purpose });
      const existing = this.channelsById.get(channel) ?? { id: channel };
      this.channelsById.set(channel, { ...existing, purpose: { value: purpose, creator: "UBOT" } });
      return { ok: true };
    },
  };
  readonly topics: { channel: string; topic: string }[] = [];
  readonly purposes: { channel: string; purpose: string }[] = [];
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
  readonly bots = { info: async () => ({ bot: {} }) };

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
      if (this.membershipFailures.has(args.channel)) throw new Error("missing conversations:read");
      yield { members: this.membersByChannel.get(args.channel) ?? [] };
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

  async externalSlackParticipants(): Promise<boolean> {
    return this.externalParticipants;
  }
  async effectiveModelName(): Promise<string> {
    return "Claude Opus 4.8";
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

async function fixture(options: { externalParticipants?: boolean; webUiPublicUrl?: string } = {}) {
  const core = new FakeCore();
  core.externalParticipants = options.externalParticipants ?? false;
  const started = startSlackPlugin(
    {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      identityEmail: "0",
      ...(options.webUiPublicUrl ? { webUiPublicUrl: options.webUiPublicUrl } : {}),
    },
    core,
  );
  const app = FakeApp.instances.at(-1)!;
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
  app.client.membersByChannel.set("C1", ["U1", "U2", "UBOT"]);
  app.client.membersByChannel.set("CX", ["U1", "UX", "UBOT"]);
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

test("a human's DM sets the conversation header to the serving model + web surface", async () => {
  const f = await fixture({ webUiPublicUrl: "https://claw.example.dev" });
  try {
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "100.1" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.client.topics, [
      {
        channel: "D1",
        topic: "Model: Claude Opus 4.8 · https://claw.example.dev/contexts?scope=personal%3AU1",
      },
    ]);
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "again", ts: "100.2" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.client.topics.length, 1);
  } finally {
    await f.stop();
  }
});

test("a channel's description names the channel's own default model and project page", async () => {
  const f = await fixture({ webUiPublicUrl: "https://claw.example.dev" });
  try {
    const mention = { channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> hi", ts: "100.1" };
    f.client.messagesByChannel.set("C1", [mention]);
    await f.app.emitEvent("app_mention", mention, "Ev-channel-header");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.client.purposes, [
      {
        channel: "C1",
        purpose: "Model: Claude Opus 4.8 · https://claw.example.dev/contexts?scope=channel%3AC1",
      },
    ]);
    assert.deepEqual(f.client.topics, [], "a channel's topic stays the members' own scratch space");
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

test("a Slack Connect mention is refused ephemerally and never mirrored", async () => {
  const f = await fixture();
  try {
    const event = { channel: "CX", channel_type: "channel", user: "U1", text: "<@UBOT> share secrets", ts: "103.1" };
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 0);
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
