import { test } from "node:test";
import assert from "node:assert/strict";
import bolt from "@slack/bolt";
import { createMirror } from "../src/slack/mirror.ts";
import { registerSlackEvents } from "../src/slack/events.ts";
import { createDirectory, type BotIdentity } from "../src/slack/directory.ts";
import { createTurnHandler, type TurnHandler } from "../src/slack/turn-handler.ts";
import { createSlackHistoryReader } from "../src/slack/history.ts";
import { createMemorySurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { createDeduper, createThreadTracker } from "../src/slack/lib.ts";
import { createDeferredEnvelopeAck } from "../src/slack/deferred-ack.ts";

const ids: BotIdentity = {
  botUserId: "UBOT",
  ownBotId: "BBOT",
  ownTeamId: "T1",
  botHandle: "qm",
  ownWorkspaceUrl: "",
  identityMode: "slack-id",
};

function fixture(
  options: {
    ingest?: (events: any[]) => Promise<void>;
    external?: boolean;
    directory?: any;
    stake?: TurnHandler["botHasStakeInThread"];
  } = {},
) {
  const events: any[] = [];
  const dispatches: any[] = [];
  const refreshes: any[] = [];
  const inbox: any[] = [];
  const directory = options.directory ?? {
    forceDirectorySync: async (...args: any[]) => {
      refreshes.push(args);
    },
    getChannelInfo: async () => ({ id: "C1" }),
    allInternalRosters: async () =>
      new Map([
        ["C1", []],
        ["D1", []],
      ]),
    classifyUserCached: async (_client: unknown, id: string) => ({
      ok: true,
      actor: { externalId: id, displayName: "Teammate" },
    }),
  };
  const mirror = createMirror({
    core: {
      ingestSurfaceEvents:
        options.ingest ??
        (async (batch: any[]) => {
          events.push(...batch);
        }),
    } as any,
    ids,
    directory,
    externalParticipantsEnabled: async () => options.external ?? false,
  });
  const app = new bolt.App({
    receiver: { init() {}, async start() {}, async stop() {} } as any,
    authorize: async () => ({
      botToken: "xoxb-test",
      botId: ids.ownBotId,
      botUserId: ids.botUserId,
      teamId: ids.ownTeamId,
    }),
    ignoreSelf: false,
  });
  app.error(async () => {});
  registerSlackEvents(app, {
    inboxMessage: (...args: any[]) => {
      inbox.push(args);
    },
    ids,
    mirror,
    directory,
    deduper: createDeduper(),
    handler: {
      dispatch: async (...args: any[]) => {
        dispatches.push(args);
      },
      botHasStakeInThread: options.stake ?? (async () => false),
      handleReactionEvent: async (...args: any[]) => {
        dispatches.push(args);
      },
    } as any,
  });
  async function fire(event: Record<string, unknown>, gate?: ReturnType<typeof createDeferredEnvelopeAck>) {
    await app.processEvent({
      body: { type: "event_callback", team_id: "T1", event_id: "Ev1", event },
      ack: gate?.ack ?? (async () => {}),
      customProperties: { ackGate: gate?.gate },
    });
    gate?.gate.persisted();
  }
  return { mirror, events, dispatches, refreshes, inbox, fire };
}

test("visible Slack system messages and their edits mirror without agent dispatch", async () => {
  const f = fixture();
  for (const subtype of [
    "channel_join",
    "channel_leave",
    "channel_topic",
    "channel_purpose",
    "channel_name",
    "channel_convert_to_private",
    "channel_convert_to_public",
    "group_join",
    "group_leave",
  ]) {
    const base = {
      type: "message",
      subtype,
      channel: "C1",
      channel_type: subtype.startsWith("group_") ? "mpim" : "channel",
      user: "U1",
      ts: "3.000001",
      text: "system context",
    };
    await f.fire(base);
    await f.fire({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      channel_type: base.channel_type,
      ts: "4.000001",
      message: { ...base, text: "updated context", edited: { ts: "4.000001" } },
    });
  }
  assert.equal(f.events.length, 18);
  assert.equal(f.refreshes.length, 4);
  assert.equal(f.dispatches.length, 0);
  assert.ok(f.events.every((e) => e.handled === true));
  assert.ok(f.events.filter((_, i) => i % 2 === 1).every((e) => e.text === "updated context" && e.editedAt === 4000));
});

test("hidden messages never enter context or dispatch", async () => {
  const f = fixture();
  const message = {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    ts: "3.000001",
    text: "hidden control",
    hidden: true,
  };
  await f.fire(message);
  await f.fire({ ...message, subtype: "channel_topic" });
  await f.fire({ ...message, hidden: false, subtype: "message_replied" });
  await f.fire({ type: "message", subtype: "message_changed", channel: "C1", channel_type: "channel", message });
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.dispatches, []);
  assert.deepEqual(f.inbox, []);
});

test("a system-message edit arriving first is already handled", async () => {
  const f = fixture();
  await f.fire({
    type: "message",
    subtype: "message_changed",
    channel: "C1",
    channel_type: "channel",
    ts: "4.000001",
    message: { subtype: "channel_topic", ts: "3.000001", user: "U1", text: "new topic", edited: { ts: "4.000001" } },
  });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].handled, true);
  assert.deepEqual(f.dispatches, []);
});

test("real Bolt ingests own channel/DM messages and edits without responses or self reactions", async () => {
  const f = fixture();
  for (const channel of ["C1", "D1"]) {
    const base = {
      type: "message",
      channel,
      channel_type: channel === "D1" ? "im" : "channel",
      ts: "2.000001",
      thread_ts: "1.000001",
      user: "UBOT",
      bot_id: "BBOT",
      subtype: "bot_message",
      text: "reply",
      files: [{ id: "F1", name: "report" }],
    };
    await f.fire(base);
    await f.fire({
      type: "message",
      channel,
      channel_type: base.channel_type,
      subtype: "message_changed",
      message: { ...base, text: "edited", files: [], edited: { ts: "3.000001" } },
      previous_message: base,
    });
  }
  await f.fire({ type: "app_mention", user: "UBOT", bot_id: "BBOT", channel: "C1", ts: "4", text: "<@UBOT>" });
  await f.fire({
    type: "reaction_added",
    user: "UBOT",
    reaction: "eyes",
    item: { type: "message", channel: "C1", ts: "4" },
  });
  assert.equal(f.events.length, 4);
  assert.equal(f.dispatches.length, 0);
  assert.ok(f.events.every((e) => e.self && e.handled && e.sub === "1.000001"));
  assert.equal(f.events[1].editedAt, 3000);
  assert.deepEqual(f.events[1].files, []);
  assert.equal(f.events[0].files[0].fileId, "F1");
});

test("canonical root snapshots clear parent", async () => {
  const f = fixture();
  await f.fire({
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "UBOT",
    ts: "2",
    thread_ts: "2",
    text: "canonical",
  });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].sub, null);
  assert.equal(f.events[0].text, "canonical");
});

test("actual Bolt swallowed listener errors still withhold ack and preserve staged replay", async () => {
  let fail = true;
  let acknowledged = 0;
  let withheld = 0;
  let cleared = 0;
  const f = fixture({
    ingest: async () => {
      if (fail) throw new Error("database unavailable");
    },
  });
  const event = { type: "message", channel: "C1", channel_type: "channel", user: "UBOT", ts: "2", text: "reply" };
  const gate = createDeferredEnvelopeAck(
    async () => {
      acknowledged++;
    },
    {
      gated: true,
      onWithhold: () => {
        withheld++;
      },
      staging: {
        stage: async () => true,
        accepted: () => {
          cleared++;
        },
      },
    },
  );
  await f.fire(event, gate);
  assert.equal(acknowledged, 0);
  assert.equal(withheld, 1);
  assert.equal(cleared, 0);
  fail = false;
  const retry = createDeferredEnvelopeAck(
    async () => {
      acknowledged++;
    },
    { gated: true },
  );
  await f.fire(event, retry);
  assert.equal(acknowledged, 1);
});

test("unavailable room authorization retries; genuine room denial never ingests", async () => {
  for (const unavailable of [true, false]) {
    let withheld = 0;
    const f = fixture({
      directory: {
        getChannelInfo: async () => (unavailable ? undefined : {}),
        allInternalRosters: async () => new Map(),
      },
    });
    const gate = createDeferredEnvelopeAck(async () => {}, {
      gated: true,
      onWithhold: () => {
        withheld++;
      },
    });
    await f.fire(
      { type: "message", channel: "C1", channel_type: "channel", user: "UBOT", ts: "2", text: "reply" },
      gate,
    );
    assert.equal(f.events.length, 0);
    assert.equal(withheld, Number(unavailable));
  }
});

test("strict directory roster distinguishes unavailable members from denied rooms", async () => {
  const directory = createDirectory({ core: {} as any, ids });
  const client = {
    conversations: { members: {} },
    paginate: async function* () {
      yield await Promise.reject(new Error("rate limited"));
    },
  };
  await assert.rejects(
    directory.allInternalRosters(client, [{ id: "C1" }], {
      plural: "rooms",
      authz: "mirror",
      item: "room",
      requireComplete: true,
    }),
    /rate limited/,
  );
});

test("late ingestion failure keeps an already staged envelope for replay", async () => {
  let acknowledged = 0;
  let staged = 0;
  let cleared = 0;
  const f = fixture({
    ingest: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("database unavailable");
    },
  });
  const gate = createDeferredEnvelopeAck(
    async () => {
      acknowledged++;
    },
    {
      gated: true,
      capMs: 1,
      staging: {
        stage: async () => {
          staged++;
          return true;
        },
        accepted: () => {
          cleared++;
        },
      },
    },
  );
  await f.fire({ type: "message", channel: "C1", channel_type: "channel", user: "UBOT", ts: "2", text: "reply" }, gate);
  assert.equal(staged, 1);
  assert.equal(acknowledged, 1);
  assert.equal(cleared, 0);
});

test("self message deletions reach the mirror without dispatch", async () => {
  const f = fixture();
  await f.fire({
    type: "message",
    subtype: "message_deleted",
    channel: "D1",
    channel_type: "im",
    deleted_ts: "2",
    previous_message: { user: "UBOT", bot_id: "BBOT", thread_ts: "1" },
  });
  assert.deepEqual(f.events, [{ container: "D1", ts: "2", deleted: true, sub: "1", self: true }]);
  assert.equal(f.dispatches.length, 0);
});

test("strict roster rejects incomplete user classification rather than treating it as denied", async () => {
  const directory = createDirectory({ core: {} as any, ids });
  const client = {
    conversations: { members: {} },
    users: {
      info: async () => {
        throw new Error("unavailable");
      },
    },
    paginate: async function* () {
      yield { members: ["U1"] };
    },
  };
  await assert.rejects(
    directory.allInternalRosters(client, [{ id: "C1" }], {
      plural: "rooms",
      authz: "mirror",
      item: "room",
      requireComplete: true,
    }),
    /classification unavailable/,
  );
});

test("file-only changes keep Slack edit version and missing edit versions use envelope time", async () => {
  const f = fixture();
  const message = { user: "UBOT", bot_id: "BBOT", ts: "2", text: "unchanged", edited: { ts: "3.500" }, files: [] };
  await f.fire({
    type: "message",
    subtype: "message_changed",
    channel: "C1",
    channel_type: "channel",
    ts: "4",
    message,
    previous_message: { text: "unchanged" },
  });
  assert.equal(f.events[0].editedAt, 3500);
  assert.deepEqual(f.events[0].files, []);
  await f.fire({
    type: "message",
    subtype: "message_changed",
    channel: "C1",
    channel_type: "channel",
    ts: "5.500",
    message: { ...message, edited: undefined, text: "changed" },
    previous_message: { text: "unchanged" },
  });
  assert.equal(f.events[1].editedAt, 5500);
});

test("thread broadcast snapshots retain broadcast membership through metadata updates", async () => {
  const f = fixture();
  await f.fire({
    type: "message",
    subtype: "thread_broadcast",
    channel: "C1",
    channel_type: "channel",
    user: "UBOT",
    ts: "2",
    thread_ts: "1",
    text: "reply",
  });
  assert.equal(f.events[0].broadcast, true);
  await f.fire({
    type: "message",
    subtype: "message_changed",
    channel: "C1",
    channel_type: "channel",
    ts: "3",
    message: { user: "UBOT", ts: "2", thread_ts: "1", text: "edited" },
    previous_message: { text: "reply" },
  });
  assert.equal(f.events[1].broadcast, undefined);
});

test("real message handler checks prior stake before ingesting the current reply without a shadow miss", async (t) => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([
    { container: "C1", ts: "1.000001", text: "root", authorId: "U1" },
    { container: "C1", ts: "2.000001", sub: "1.000001", text: "prior reply", authorId: "UBOT", self: true },
  ]);
  const calls: any[] = [];
  const records: any[] = [];
  t.mock.method(console, "info", (text: string) => {
    records.push(JSON.parse(text));
  });
  const currentTs = "3.000001";
  const client = {
    conversations: {
      replies: async (args: any) => {
        calls.push(args);
        assert.deepEqual(args, { channel: "C1", ts: "1.000001", limit: 200, latest: currentTs, inclusive: false });
        assert.equal((await cache.readMessages("C1", { at: currentTs })).length, 0);
        return {
          messages: [
            { ts: "1.000001", user: "U1", text: "root" },
            { ts: "2.000001", thread_ts: "1.000001", user: "UBOT", text: "prior reply" },
          ],
          has_more: false,
        };
      },
    },
  };
  const reader = createSlackHistoryReader({
    source: "shadow",
    ids,
    core: { readSurfaceMessages: (channel: string, opts: any) => cache.readMessages(channel, opts) } as any,
    historyClient: client as never,
  });
  const threads = createThreadTracker();
  const handler = createTurnHandler({ directory: {}, mirror: {}, flow: {}, ids, threads, readHistory: reader } as any);
  const f = fixture({
    stake: handler.botHasStakeInThread,
    ingest: async (events) => {
      await cache.ingest(events);
    },
  });
  await f.fire({
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    ts: currentTs,
    thread_ts: "1.000001",
    text: "follow-up",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.dispatches.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].liveMessages, 2);
  assert.equal(records[0].matchingMessages, 2);
  assert.equal(records[0].liveMessagesMissingFromStorage, 0);
  assert.equal(records[0].liveMessagesMissingFromMirror, 0);
  assert.equal(await handler.botHasStakeInThread(client, "C1", "1.000001", "4.000001"), true);
  assert.equal(calls.length, 1);
});

test("stake fallback bounds Slack replies while omitted cutoff and negative tracking remain unchanged", async () => {
  const calls: any[] = [];
  const client = {
    conversations: {
      replies: async (args: any) => {
        calls.push(args);
        return { messages: [] };
      },
    },
  };
  const handler = createTurnHandler({
    directory: {},
    mirror: {},
    flow: {},
    ids,
    threads: createThreadTracker(),
  } as any);
  assert.equal(await handler.botHasStakeInThread(client, "C1", "1", "3"), false);
  assert.deepEqual(calls[0], { channel: "C1", ts: "1", limit: 200, latest: "3", inclusive: false });
  assert.equal(await handler.botHasStakeInThread(client, "C1", "1", "4"), false);
  assert.equal(calls.length, 1);
  assert.equal(await handler.botHasStakeInThread(client, "C1", "5"), false);
  assert.deepEqual(calls[1], { channel: "C1", ts: "5", limit: 200 });
});

test("reaction turns preserve the reacted message in the mirror", async () => {
  const cache = createMemorySurfaceCache();
  const f = fixture({
    ingest: async (events) => {
      await cache.ingest(events);
    },
  });
  const client = { reactions: { get: async () => ({ message: { text: "Original bot answer", user: "UBOT" } }) } };
  await f.mirror.mirrorMessageEvent(
    { channel: "D1", channel_type: "im", ts: "100.001", text: "Original bot answer", user: "UBOT" },
    client,
    { kind: "dm" },
  );
  const before = await cache.readMessages("D1", { limit: 10 });
  const turns: any[] = [];
  const handler = createTurnHandler({
    core: {},
    flow: {
      callCore: async (turn: any) => {
        turns.push(turn);
        return { status: "silent" };
      },
    },
    directory: { classifyUserCached: async () => ({ actor: { externalId: "U1", displayName: "Teammate" } }) },
    mirror: f.mirror,
    ids,
    threads: createThreadTracker(),
    deduper: createDeduper(),
  } as any);
  for (const added of [true, false]) {
    await handler.handleReactionEvent(
      { user: "U1", reaction: "thumbsup", item_user: "UBOT", item: { type: "message", channel: "D1", ts: "100.001" } },
      `reaction-${added}`,
      client,
      added,
    );
  }
  assert.equal(turns.length, 2);
  assert.match(turns[0].text, /\[Slack reaction\].*reacted/);
  assert.match(turns[1].text, /\[Slack reaction\].*removed/);
  assert.deepEqual(await cache.readMessages("D1", { limit: 10 }), before);
});

test("synthetic reaction turns preserve the canonical message snapshot", async () => {
  const cache = createMemorySurfaceCache();
  const directory = {
    getChannelInfo: async () => ({ id: "D1" }),
    allInternalRosters: async () => new Map([["D1", []]]),
    classifyUserCached: async (_client: unknown, id: string) => ({
      ok: true,
      actor: { externalId: id, displayName: id },
    }),
  };
  const mirror = createMirror({
    core: { ingestSurfaceEvents: cache.ingest } as any,
    ids,
    directory: directory as any,
    externalParticipantsEnabled: async () => false,
  });
  await mirror.mirrorMessageEvent(
    {
      channel: "D1",
      channel_type: "im",
      ts: "2",
      thread_ts: "1",
      user: "UAUTHOR",
      text: "original message",
      files: [{ id: "F1", name: "report.txt" }],
    },
    {},
    { kind: "dm" },
  );
  const before = await cache.readMessages("D1", { at: "2" });
  assert.equal(before[0]?.files?.length, 1);
  const stop = new Error("serialization boundary reached");
  const handler = createTurnHandler({
    core: {},
    flow: {},
    directory,
    mirror,
    ids,
    threads: createThreadTracker(),
    serializer: {
      serializeSlackConversation: async () => {
        throw stop;
      },
    },
    externalParticipantsEnabled: async () => false,
  } as any);
  await assert.rejects(
    handler.handleIncoming(
      {
        kind: "dm",
        channel: "D1",
        userId: "UREACTOR",
        ts: "2",
        threadTs: "1",
        rawText: "Reactor reacted with thumbs up",
        files: [],
        unprompted: true,
        synthetic: true,
      },
      {},
    ),
    (error: unknown) => error === stop,
  );
  assert.deepEqual(await cache.readMessages("D1", { at: "2" }), before);
});
