import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createDirectory } from "../src/slack/directory.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

const channel = (id: string, isPrivate = false) => ({
  id,
  name: id.toLowerCase(),
  is_member: true,
  is_private: isPrivate,
});

function fixture(t: TestContext) {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const advance = (ms = 301_000) => {
    now += ms;
  };
  const store = createDirectoryStore();
  function core(channels = [channel("C_ONE")]) {
    const state = {
      channels,
      memberIds: ["U_ONE"],
      failMembers: false,
      failList: false,
      memberCalls: 0,
      rejectPush: false,
    };
    const pushes: Parameters<SlackCoreClient["pushDirectory"]>[0][] = [];
    const user = { id: "U_ONE", team_id: "T_TEST" };
    const client = {
      async *paginate(method: string, args: { types?: string }) {
        if (method === "users.list") yield { members: [user] };
        else if (method === "conversations.list") {
          if (state.failList) throw Error("list unavailable");
          yield { channels: args.types === "mpim" ? [] : state.channels };
        } else if (method === "conversations.members") {
          state.memberCalls++;
          if (state.failMembers) throw Error("members unavailable");
          yield { members: state.memberIds };
        }
      },
      users: { info: async () => ({ user }) },
    };
    const directory = createDirectory({
      core: {
        holdDirectorySync: async (fn: (lost: Promise<void>) => Promise<boolean>) => fn(new Promise(() => {})),
        pushDirectory: async (body: Parameters<SlackCoreClient["pushDirectory"]>[0]) => {
          if (state.rejectPush) {
            pushes.push(body);
            return false;
          }
          const members = await store.replace(body.members ?? [], body.membersSyncedAt);
          const channels = body.channels
            ? await store.replaceChannels(
                body.channels,
                body.channelMembers,
                body.channelsSyncedAt,
                body.channelRosterIds,
                body.channelRevocations,
              )
            : true;
          const groups = body.groupMembers
            ? await store.replaceGroups(body.groupMembers, body.groupsSyncedAt, body.groupIds, body.groupRosterIds)
            : true;
          pushes.push(body);
          return members && channels && groups;
        },
      } as SlackCoreClient,
      ids: {
        ownTeamId: "T_TEST",
        botUserId: "U_BOT",
        ownBotId: "B_BOT",
        botHandle: "bot",
        ownWorkspaceUrl: "",
        identityMode: "slack-id",
      },
    });
    async function refresh() {
      const count = pushes.length;
      await directory.getUserSnapshot(client);
      for (let i = 0; i < 100 && pushes.length === count; i++) await setImmediate();
      assert.equal(pushes.length, count + 1);
      await setImmediate();
      return pushes.at(-1)!;
    }
    return { state, directory, client, refresh, pushes };
  }
  return { store, core, advance };
}

test("a fresh listing discovers channels without replaying cached rosters", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  await a.refresh();
  advance();
  a.state.channels.push(channel("C_NEW"));
  const pushed = await a.refresh();
  assert.equal(await store.channelPrivacy("C_NEW"), false);
  assert.equal(pushed.channelsSyncedAt, Date.now());
  assert.deepEqual(pushed.channelRosterIds, []);
  assert.deepEqual(pushed.channelMembers, []);
  assert.equal(pushed.groupMembers, undefined);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  assert.equal(a.state.memberCalls, 1);
});

test("fresh listings update names and privacy while roster refresh is throttled", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  await a.refresh();
  advance();
  a.state.channels = [{ ...channel("C_ONE", true), name: "renamed" }];
  const pushed = await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), true);
  assert.equal(pushed.channels?.[0]?.name, "renamed");
  advance();
  a.state.channels = [channel("C_ONE")];
  await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), false);
});

test("two cores recover a successful omission through healthy periodic listings", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  await a.refresh();
  advance(1);
  const b = core([channel("C_OTHER")]);
  await b.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), undefined);
  b.state.channels = [channel("C_ONE")];
  for (const node of [a, b, a, b]) {
    advance();
    await node.refresh();
    assert.equal(await store.channelPrivacy("C_ONE"), false);
    assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
  }
});

test("periodic and unrelated targeted refreshes cannot resurrect another core's revocation", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core([channel("C_ONE", true), channel("C_OTHER")]);
  await a.refresh();
  advance(1);
  const b = core([channel("C_ONE", true), channel("C_OTHER")]);
  await b.refresh();
  advance(1);
  await b.directory.forceDirectorySync(b.client, "C_ONE", "U_ONE");
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
  advance(1);
  await a.directory.forceDirectorySync(a.client, "C_OTHER");
  advance();
  await a.refresh();
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
  assert.equal(await store.channelMember("C_OTHER", "U_ONE"), true);
});

test("targeted refresh does not postpone the next full roster refresh", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core([channel("C_ONE"), channel("C_OTHER")]);
  await a.refresh();
  advance(1_500_000);
  await a.refresh();
  advance(299_000);
  await a.directory.forceDirectorySync(a.client, "C_OTHER");
  a.state.memberIds = [];
  advance(2_000);
  const pushed = await a.refresh();
  assert.deepEqual(pushed.channelRosterIds?.sort(), ["C_ONE", "C_OTHER"]);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
});

test("API errors preserve stored rosters and metadata but successful omissions remove them", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  await a.refresh();
  advance();
  a.state.failMembers = true;
  a.state.channels = [channel("C_ONE", true)];
  await a.directory.forceDirectorySync(a.client, "C_ONE");
  assert.equal(await store.channelPrivacy("C_ONE"), true);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  advance();
  a.state.failList = true;
  await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), true);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  advance();
  a.state.failList = false;
  a.state.channels = [];
  await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), undefined);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
});

test("a rejected full crawl is retried instead of throttling unpublished rosters", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  a.state.rejectPush = true;
  await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), undefined);
  a.state.rejectPush = false;
  advance();
  await a.refresh();
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  assert.equal(a.state.memberCalls, 2);
});
