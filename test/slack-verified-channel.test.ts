import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { SocketModeClient } from "@slack/socket-mode";
import type { App as BoltApp, ReceiverEvent } from "@slack/bolt";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createEnvelopeStaging, type StagedEnvelope } from "../src/slack/envelope-staging.ts";
import { createDeferredAckReceiver, type AckGate } from "../src/slack/deferred-ack.ts";
import { createHttpEventsReceiver } from "../src/slack/http-events.ts";
import { createDeduper, dedupedRun } from "../src/slack/message-gating.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createDirectory } from "../src/slack/directory.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

function fixture(options: { secondary?: boolean; failWrite?: boolean; throwWrite?: boolean } = {}) {
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
        if (options.throwWrite) throw new Error("directory transport unavailable");
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

test("failed persistence propagates to envelope recovery instead of declaring an external audience", async () => {
  for (const options of [{ failWrite: true }, { throwWrite: true }]) {
    const { observe } = fixture(options);
    await assert.rejects(observe(), /not persisted before admission|directory transport unavailable/);
  }
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
  await assert.rejects(observe(), /not persisted before admission/);
  assert.equal(await store.channelPrivacy("C_ONE"), undefined);
});

test("equal observation stamps trigger recovery without changing the internal roster", async (t) => {
  t.mock.method(Date, "now", () => 100_000);
  const { store, observe } = fixture();
  assert.ok((await observe()).publishMembers);
  await assert.rejects(observe(), /not persisted before admission/);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
});

for (const mode of ["socket", "http"] as const)
  for (const afterCap of [false, true])
    test(`${mode} roster failure ${afterCap ? "after" : "before"} ack cap recovers without false external admission`, async (t) => {
      const options = { failWrite: true };
      const { observe } = fixture(options);
      const deduper = createDeduper();
      const map = createMemoryMap<StagedEnvelope>();
      const staging = createEnvelopeStaging(map, { account: "test", staleAfterMs: 0 });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      let eventDone: (() => void) | undefined;
      let attempts = 0;
      let admitted = 0;
      let externalRefusals = 0;
      let acks = 0;
      const retries: Array<number | undefined> = [];
      const processEvent = async (event: ReceiverEvent) => {
        await event.ack();
        retries.push(event.retryNum);
        const gate = event.customProperties!.ackGate as AckGate;
        await dedupedRun(
          deduper,
          "message-key",
          async () => {
            if (++attempts === 1 && afterCap) await blocked;
            const membership = await observe();
            if (!membership.publishMembers) {
              externalRefusals++;
              gate.persisted();
              return;
            }
            admitted++;
            gate.persisted();
          },
          (error) => gate.failed(String(error)),
        );
        eventDone?.();
        eventDone = undefined;
        complete();
      };
      const receiver =
        mode === "socket"
          ? createDeferredAckReceiver({ appToken: "xapp-test", capMs: afterCap ? 1 : 5000, staging })
          : createHttpEventsReceiver({ signingSecret: "test-secret", port: 0, capMs: afterCap ? 1 : 5000, staging });
      receiver.init?.({ processEvent } as unknown as BoltApp);
      const body = {
        type: "event_callback",
        event_id: "EvTest",
        event: { type: "app_mention", channel: "C_ONE", ts: "1.1" },
      };
      let acked!: () => void;
      const acknowledgement = new Promise<void>((resolve) => {
        acked = resolve;
      });
      const deliver = async (retryNum = 0): Promise<number | undefined> => {
        if ("client" in receiver) {
          const processed = new Promise<void>((resolve) => {
            eventDone = resolve;
          });
          (receiver.client as SocketModeClient).emit("slack_event", {
            body,
            retry_num: retryNum,
            ack: async () => {
              acks++;
              acked();
            },
          });
          if (afterCap && retryNum === 0) await acknowledgement;
          else await processed;
          return undefined;
        }
        const address = (receiver as ReturnType<typeof createHttpEventsReceiver>).server.address() as AddressInfo;
        const timestamp = String(Math.floor(Date.now() / 1000));
        const raw = JSON.stringify(body);
        const signature = `v0=${createHmac("sha256", "test-secret").update(`v0:${timestamp}:${raw}`).digest("hex")}`;
        const response = await fetch(`http://127.0.0.1:${address.port}/slack/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-signature": signature,
            "x-slack-request-timestamp": timestamp,
            "x-slack-retry-num": String(retryNum),
          },
          body: raw,
        });
        if (response.status === 200) acks++;
        else assert.deepEqual(await response.json(), { error: "not_persisted" });
        return response.status;
      };
      if ("server" in receiver) {
        await receiver.start(0 as never);
        t.after(() => receiver.stop(0 as never));
      }
      const status = await deliver();
      if (mode === "http") assert.equal(status, afterCap ? 200 : 503);
      assert.equal(acks, afterCap ? 1 : 0);
      release();
      await completed;
      assert.equal(admitted, 0);
      assert.equal(externalRefusals, 0);
      assert.equal(deduper.seen("message-key"), false);
      deduper.forget("message-key");
      options.failWrite = false;
      if (afterCap) {
        assert.equal((await map.entries()).length, 1);
        assert.equal(
          await staging.sweep((replayed, ackGate) =>
            processEvent({ body: replayed, ack: async () => {}, customProperties: { ackGate } }),
          ),
          1,
        );
      } else {
        assert.equal((await map.entries()).length, 0);
        const retryStatus = await deliver(1);
        if (mode === "http") assert.equal(retryStatus, 200);
        assert.equal(retries.at(-1), 1);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(admitted, 1);
      assert.equal(attempts, 2);
      assert.equal((await map.entries()).length, 0);
    });
