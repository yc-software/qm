import assert from "node:assert/strict";
import { test } from "node:test";
import { registerSlackEvents } from "../src/slack/events.ts";
import { createDeduper } from "../src/slack/message-gating.ts";
import { createMirror } from "../src/slack/mirror.ts";
import { createConversationSerializer, MAX_NAME_LOOKUPS } from "../src/slack/conversation-view.ts";
import { resolveMentions } from "../src/slack/conversation.ts";
import type { BotIdentity, Directory } from "../src/slack/directory.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { IngestEvent } from "../src/surface-cache/surface-cache.ts";

const ids: BotIdentity = {
  ownTeamId: "T1",
  botUserId: "UBOT",
  ownBotId: "BBOT",
  botHandle: "qm",
  ownWorkspaceUrl: "https://example.slack.com",
  identityMode: "slack-id",
};
const message = {
  channel: "C1",
  channel_type: "channel",
  user: "U1",
  ts: "100.2",
  text: "<@BBOT|qm> ping",
  thread_ts: "100.1",
};

function eventsFixture(
  classify: Directory["classifyUserCached"] = async () => ({ ok: true, actor: { externalId: "U1" } }),
  ownBotId = "BBOT",
) {
  let receive: (args: any) => Promise<void>;
  const dispatched: any[] = [];
  let stakes = 0;
  registerSlackEvents(
    {
      event: () => {},
      message: (fn) => {
        receive = fn;
      },
    },
    {
      ids: { ...ids, ownBotId },
      deduper: createDeduper(),
      directory: {
        classifyUserCached: classify,
        syncForUnseenGroup: () => {},
        forceDirectorySync: async () => {},
      } as unknown as Directory,
      mirror: {
        mirrorMessageEvent: async () => {},
        pushSurfaceEvents: async () => {},
        mirrorSelfPost: () => {},
        resolveTextMentions: async (_c, text) => ({ text, mentions: {} }),
      },
      handler: {
        dispatch: async (key, inc) => {
          dispatched.push({ key, inc });
        },
        handleIncoming: async () => {},
        handleReactionEvent: async () => {},
        botHasStakeInThread: async () => {
          stakes++;
          return true;
        },
      },
    },
  );
  return {
    dispatched,
    stakes: () => stakes,
    send: (m = message) => receive!({ message: m, body: {}, client: {}, context: {} }),
  };
}

test("B-only fallback is addressed without querying stake and preserves the existing dispatch key", async () => {
  const f = eventsFixture();
  await f.send();
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].key, "C1:100.2");
  assert.equal(f.dispatched[0].inc.unprompted, undefined);
  assert.equal(f.dispatched[0].inc.botAuthored, undefined);
  assert.equal(f.dispatched[0].inc.actor, undefined);
  assert.equal(f.stakes(), 0);
});

test("B fallback fails closed on failed, missing, empty, or bot author classification", async () => {
  const classifications: Directory["classifyUserCached"][] = [
    async () => ({ ok: false, actor: { externalId: "U1" } }),
    async () => ({ ok: true, actor: { externalId: "" } }),
    async () => ({ ok: true, actor: { externalId: "U1", isBot: true } }),
    async () => {
      throw new Error("lookup unavailable");
    },
  ];
  for (const classify of classifications) {
    const f = eventsFixture(classify);
    await f.send();
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.stakes(), 0);
  }
});

test("B fallback requires a complete human event and never falls through as ambient", async () => {
  for (const change of [
    { user: "" },
    { channel: "" },
    { ts: "" },
    { bot_id: "BPEER" },
    { bot_profile: {} },
    { subtype: "bot_message" },
    { user: "UBOT" },
    { bot_id: "BBOT" },
  ]) {
    const f = eventsFixture(async () => {
      throw new Error("must not classify malformed or bot-marked input");
    });
    await f.send({ ...message, ...change });
    assert.equal(f.dispatched.length, 0, JSON.stringify(change));
  }
  const missingId = eventsFixture(undefined, "");
  await missingId.send({ ...message, thread_ts: "" });
  assert.equal(missingId.dispatched.length, 0);
});

test("mirror resolves own B beyond the lookup budget without calling users.info for any B ID", async () => {
  const lookedUp: string[] = [],
    ingested: IngestEvent[] = [];
  const mirror = createMirror({
    ids,
    externalParticipantsEnabled: async () => true,
    core: {
      ingestSurfaceEvents: async (events: IngestEvent[]) => {
        ingested.push(...events);
      },
    } as unknown as SlackCoreClient,
    directory: {
      classifyUserCached: async (_client: any, id: string) => {
        lookedUp.push(id);
        return { ok: true, actor: { externalId: id, displayName: `name-${id}` } };
      },
    } as unknown as Directory,
  });
  const prefix = Array.from({ length: MAX_NAME_LOOKUPS + 2 }, (_, i) => `<@U${i}>`).join(" ");
  await mirror.mirrorMessageEvent({ ...message, text: `${prefix} <@BOTHER> <@BBOT> <@BBOT|renamed>` }, {});
  assert.equal(lookedUp.length, MAX_NAME_LOOKUPS);
  assert.equal(
    lookedUp.some((id) => id.startsWith("B")),
    false,
  );
  assert.match(ingested[0]!.text!, /@BOTHER @qm @renamed$/);
  assert.equal(ingested[0]!.mentions?.BBOT, "qm");
  assert.equal(ingested[0]!.mentionsSelf, true);
  await mirror.mirrorMessageEvent({ ...message, text: "&lt;@BBOT&gt;" }, {});
  assert.equal(ingested[1]!.mentionsSelf, undefined);
});

test("history resolves self aliases without adding bot IDs to the authorized audience", async () => {
  const audience = [{ externalId: "U1", displayName: "Alice" }];
  const serializer = createConversationSerializer({
    ids,
    externalParticipantsEnabled: async () => true,
    directory: {} as Directory,
  });
  const { view } = await serializer.serializeSlackConversation(
    {
      conversations: { replies: async () => ({ messages: [{ ts: "100.1", user: "U1", text: "<@BBOT> <@UBOT|qm>" }] }) },
    },
    { kind: "channel", channel: "C1", ts: "100.2", threadTs: "100.1", files: [] },
    { audience },
  );
  assert.equal(resolveMentions(view.messages[0]!.text, view.nameById), "@qm @qm");
  assert.deepEqual(
    view.members.map((m) => m.id),
    ["U1"],
  );
  assert.deepEqual(audience, [{ externalId: "U1", displayName: "Alice" }]);
});

test("mirror flags and own-B names survive message/handled upserts in either order", async () => {
  const { createMemorySurfaceCache } = await import("../src/surface-cache/surface-cache.ts");
  for (const order of [
    [false, true],
    [true, false],
  ]) {
    const cache = createMemorySurfaceCache();
    const mirror = createMirror({
      ids,
      externalParticipantsEnabled: async () => true,
      core: {
        ingestSurfaceEvents: async (events: IngestEvent[]) => {
          await cache.ingest(events);
        },
      } as unknown as SlackCoreClient,
      directory: {} as Directory,
    });
    for (const handled of order) await mirror.mirrorMessageEvent(message, {}, { handled });
    const rows = await cache.readMessages("C1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.handled, true);
    assert.equal(rows[0]!.mentionsSelf, true);
    assert.equal(rows[0]!.mentions?.BBOT, "qm");
    assert.equal(rows[0]!.text, "@qm ping");
  }
});

test("mirror resolves W user IDs within the user budget and leaves pseudo tokens unchanged", async () => {
  const lookedUp: string[] = [];
  const mirror = createMirror({
    ids,
    externalParticipantsEnabled: async () => true,
    core: {} as SlackCoreClient,
    directory: {
      classifyUserCached: async (_client: any, id: string) => {
        lookedUp.push(id);
        return { ok: true, actor: { externalId: id, displayName: `name-${id}` } };
      },
    } as unknown as Directory,
  });
  const invalid = "<@qm> <@Q123|label> <@123> <@_name> <@U> <@B> <@W> <@U-1>";
  const prefix = Array.from({ length: MAX_NAME_LOOKUPS + 2 }, (_, i) => `<@W${i}>`).join(" ");
  const resolved = await mirror.resolveTextMentions({}, `${prefix} <@W0|legacy> <@BBOT> <@BOTHER> ${invalid}`);
  assert.deepEqual(
    lookedUp,
    Array.from({ length: MAX_NAME_LOOKUPS }, (_, i) => `W${i}`),
  );
  assert.equal(
    resolved.text,
    `${Array.from({ length: MAX_NAME_LOOKUPS }, (_, i) => `@name-W${i}`).join(" ")} @W10 @W11 @legacy @qm @BOTHER ${invalid}`,
  );
  assert.equal(resolved.mentions.BBOT, "qm");
  assert.equal(Object.keys(resolved.mentions).length, MAX_NAME_LOOKUPS + 1);
});
