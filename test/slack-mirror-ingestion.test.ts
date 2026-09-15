import { test } from "node:test";
import assert from "node:assert/strict";
import bolt from "@slack/bolt";
import { createMirror } from "../src/slack/mirror.ts";
import { registerSlackEvents } from "../src/slack/events.ts";
import { createDirectory, type BotIdentity } from "../src/slack/directory.ts";
import { createDeduper } from "../src/slack/lib.ts";
import { createDeferredEnvelopeAck } from "../src/slack/deferred-ack.ts";

const ids: BotIdentity = {
  botUserId: "UBOT",
  ownBotId: "BBOT",
  ownTeamId: "T1",
  botHandle: "qm",
  ownWorkspaceUrl: "",
  identityMode: "slack-id",
};

function fixture(options: { ingest?: (events: any[]) => Promise<void>; external?: boolean; directory?: any } = {}) {
  const events: any[] = [];
  const dispatches: any[] = [];
  const directory = options.directory ?? {
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
    ids,
    mirror,
    directory,
    deduper: createDeduper(),
    handler: {
      dispatch: async (...args: any[]) => {
        dispatches.push(args);
      },
      botHasStakeInThread: async () => false,
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
  return { mirror, events, dispatches, fire };
}

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
