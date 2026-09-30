import assert from "node:assert/strict";
import { test } from "node:test";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createDirectory } from "../src/slack/directory.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

function fixture(options: { secondary?: boolean; failWrite?: boolean } = {}) {
  const store = createDirectoryStore();
  const state = { memberIds: ["U_ONE"], failMembers: false, failUser: false, writes: 0 };
  const client = {
    async *paginate(method: string) {
      if (method === "conversations.members") {
        if (state.failMembers) throw Error("unavailable");
        yield { members: state.memberIds };
      } else if (method === "users.list") yield { members: [] };
      else yield { channels: [] };
    },
    users: {
      info: async ({ user }: { user: string }) => {
        if (state.failUser) throw Error("unavailable");
        return { user: { id: user, team_id: "T_TEST" } };
      },
    },
  };
  const directory = createDirectory({
    core: {
      holdDirectorySync: async () => null,
      pushDirectory: async (body: Parameters<SlackCoreClient["pushDirectory"]>[0]) => {
        state.writes++;
        if (options.failWrite) return false;
        return store.replaceChannels(
          body.channels!,
          body.channelMembers,
          body.channelsSyncedAt,
          body.channelRosterIds,
          body.channelRevocations,
          body.partialChannels,
        );
      },
    } as unknown as SlackCoreClient,
    coreSingleton: !options.secondary,
    ids: {
      ownTeamId: "T_TEST",
      botUserId: "U_BOT",
      ownBotId: "B_BOT",
      botHandle: "bot",
      ownWorkspaceUrl: "",
      identityMode: "slack-id",
    },
  });
  const observe = (
    info: import("../src/slack/identity.ts").ChannelMeta | undefined = { name: "room", is_private: true },
  ) => directory.channelMembership(client, "C_ONE", { externalId: "U_ONE" }, "U_ONE", info, Date.now());
  return { store, state, observe };
}

test("verified channel membership persists before admission without deleting another room", async () => {
  const { store, observe } = fixture();
  await store.replaceChannels([{ channelId: "C_OTHER", name: "other" }], [], 1);
  const result = await observe();
  assert.ok(result.publishMembers);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  assert.equal(await store.channelPrivacy("C_ONE"), true);
  assert.equal(await store.channelPrivacy("C_OTHER"), false);
});

test("live observation repairs stale privacy", async () => {
  const { store, observe } = fixture();
  await store.replaceChannels([{ channelId: "C_ONE", name: "old", isPrivate: true }], [], 1);
  await observe({ name: "room", is_private: false });
  assert.equal(await store.channelPrivacy("C_ONE"), false);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
});

test("secondary accounts never publish live channels", async () => {
  const { state, observe } = fixture({ secondary: true });
  assert.ok((await observe()).publishMembers);
  assert.equal(state.writes, 0);
});

test("failed persistence fails closed", async () => {
  const { observe } = fixture({ failWrite: true });
  const result = await observe();
  assert.equal(result.publishMembers, undefined);
  assert.ok(result.audience.some((actor) => actor.isExternalGuest));
});

test("removed speakers and failed member classification do not publish", async () => {
  for (const failure of ["removed", "members", "user"]) {
    const { state, observe } = fixture();
    if (failure === "removed") state.memberIds = [];
    if (failure === "members") state.failMembers = true;
    if (failure === "user") state.failUser = true;
    assert.equal((await observe()).publishMembers, undefined);
    assert.equal(state.writes, 0);
  }
});

test("unknown, external and group metadata never publish an ordinary channel", async () => {
  for (const info of [
    {},
    { name: "room" },
    { name: "room", is_private: true, is_member: false },
    { name: "room", is_private: true, is_ext_shared: true },
    { name: "room", is_private: true, is_mpim: true },
  ]) {
    const { state, observe } = fixture();
    await observe(info);
    assert.equal(state.writes, 0);
  }
});

test("newer removal rejects an older in-flight live observation", async () => {
  const { store, observe } = fixture();
  await store.replaceChannels([], [], Date.now() + 60_000);
  const result = await observe();
  assert.equal(result.publishMembers, undefined);
  assert.ok(result.audience.some((actor) => actor.isExternalGuest));
  assert.equal(await store.channelPrivacy("C_ONE"), undefined);
});
