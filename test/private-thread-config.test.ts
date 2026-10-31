import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  ConfigConflictError,
  ConfigInheritedError,
  configStoreMaps,
  type ScopedConfigStore,
} from "../src/resolution/config-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { scopeId, type Conversation, type Principal, type TurnRequest } from "../src/types.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import { startSession } from "../src/api/start-session.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createServer } from "../src/api/server.ts";
import { createControlService } from "../src/api/control-service.ts";
import { serverDeps } from "../src/wiring.ts";
import {
  BROWSER_MODEL_AUD,
  CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  mintCapabilityToken,
} from "../src/auth/capability-token.ts";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createChannelLookup } from "../src/discord/context.ts";
import { createDiscordChannels, createDiscordHistoryReader, type ThreadLinker } from "../src/discord/gateway.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { testConfigStore, testDatabaseUrl, testMap } from "./support/test-database.ts";

const PARENT_ID = "1300000000000000010";
const THREAD_ID = "1300000000000000077";
const PARENT = scopeId("channel", PARENT_ID);
const THREAD = scopeId("channel", THREAD_ID);
const ORG = scopeId("org", "default-org");
const actor: Principal = { id: "U1", type: "internal" };

async function strictParent(config = testConfigStore("default-org"), linked = true) {
  if (linked) await config.linkConfigParent(THREAD, PARENT);
  await config.setSoul(PARENT, "PARENT_SOUL");
  await config.setCommandPolicy(PARENT, {
    mode: "denylist",
    rules: [{ pattern: "parent-gated", decision: "require_approval", reason: "parent rule" }],
  });
  await config.setSecurityPosture(PARENT, "strict");
  await config.setSharingPosture(ORG, "open");
  await config.setSharingPosture(PARENT, "isolated");
  await config.setApprovalGrantModes(PARENT, { session: false, always: false });
  await config.setEgress(PARENT, { allowedHosts: [], deniedHosts: ["parent-bad.test"] });
  return config;
}

async function assertParentConfig(config: ScopedConfigStore, conversation: Conversation) {
  const r = await createResolutionService(
    "default-org",
    config,
    createAclStore(createPostgresGrantStore(testDatabaseUrl())),
  ).resolve(conversation, actor);
  assert.deepEqual(
    r.layers.map((l) => [l.scopeId, l.mode]),
    [
      [ORG, "ro"],
      [THREAD, "rw"],
    ],
  );
  assert.match(r.systemPrompt, /PARENT_SOUL/);
  assert.ok(r.commandPolicy.rules.some((rule) => rule.pattern === "parent-gated"));
  assert.equal(r.securityPolicy.toolApprovals, "all");
  assert.equal(r.sharingPosture, "isolated");
  assert.deepEqual(r.approvalGrantModes, { session: false, always: false });
  assert.deepEqual(r.egress.deniedHosts, ["parent-bad.test"]);
}

const threadConversation = (extra: Record<string, unknown> = {}): Conversation =>
  ({
    kind: "channel",
    threadRef: `discord:th:${THREAD_ID}`,
    channelRef: THREAD_ID,
    audience: [actor],
    ...extra,
  }) as Conversation;

test("a linked private thread resolves every config layer from its parent and keeps its own workspace scope", async () => {
  await assertParentConfig(await strictParent(), threadConversation());
});

test("a request cannot choose the config scope: a spoofed parentChannelRef is ignored", async () => {
  const config = testConfigStore("default-org");
  await config.setSecurityPosture(scopeId("channel", "C_STRICT"), "strict");
  await config.setEgress(scopeId("channel", "C_STRICT"), { allowedHosts: [], deniedHosts: ["bad.test"] });
  const res = createResolutionService(
    "default-org",
    config,
    createAclStore(createPostgresGrantStore(testDatabaseUrl())),
  );
  const base = { kind: "channel", threadRef: "web:U1:1", channelRef: "C_STRICT", audience: [actor] } as Conversation;
  const spoofed = await res.resolve({ ...base, parentChannelRef: "C_ANY" } as Conversation, actor);
  assert.equal(spoofed.securityPolicy.toolApprovals, "all");
  assert.deepEqual(spoofed.egress.deniedHosts, ["bad.test"]);
});

test("every config getter of a linked private thread answers with its parent's value", async () => {
  const config = await strictParent();
  await config.setCommandPolicy(scopeId("channel", "C_OTHER"), { mode: "denylist", rules: [] });
  assert.equal(config.getSoul(THREAD), "PARENT_SOUL");
  assert.equal(config.soulVersion(THREAD), config.soulVersion(PARENT));
  assert.deepEqual(config.soulHistory(THREAD), config.soulHistory(PARENT));
  assert.deepEqual(config.getCommandPolicy(THREAD), config.getCommandPolicy(PARENT));
  assert.equal(await config.getSecurityPostureDurable(THREAD), "strict");
  assert.equal(await config.getSharingPostureDurable(THREAD), "isolated");
  assert.equal(await config.getSharingPostureOwnDurable(THREAD), "isolated");
  assert.equal(await config.resolveSharingPostureDurable(scopeId("personal", "U1"), THREAD), "isolated");
  assert.deepEqual(await config.getApprovalGrantModesDurable(THREAD), { session: false, always: false });
  assert.deepEqual(config.getEgress(THREAD)?.deniedHosts, ["parent-bad.test"]);
});

test("a link written by another instance is honoured by durable reads and refuses writes", async () => {
  const maps = configStoreMaps(() => testMap());
  const writer = testConfigStore("default-org", maps);
  const reader = testConfigStore("default-org", maps);
  await writer.setSecurityPosture(PARENT, "strict");
  await writer.linkConfigParent(THREAD, PARENT);
  assert.equal(await reader.getSecurityPostureDurable(THREAD), "strict");
  await assert.rejects(reader.setSecurityPosture(THREAD, "auto"), ConfigInheritedError);
});

test("every config write to a linked private thread is refused with a clear error", async () => {
  const config = await strictParent();
  const writes: Array<() => Promise<unknown>> = [
    () => config.setSoul(THREAD, "x"),
    () => config.setSoulIfVersion(THREAD, 0, "x"),
    () => config.setCommandPolicy(THREAD, { mode: "denylist", rules: [] }),
    () => config.setSecurityPosture(THREAD, "auto"),
    () => config.setSharingPosture(THREAD, "open"),
    () => config.clearSharingPosture(THREAD),
    () => config.setApprovalGrantModes(THREAD, { session: true, always: true }),
    () => config.setEgress(THREAD, { allowedHosts: ["*"] }),
  ];
  for (const write of writes) {
    await assert.rejects(write(), (e: unknown) => {
      assert.ok(e instanceof ConfigInheritedError);
      assert.match(e.message, new RegExp(`takes its configuration from ${PARENT}`));
      return true;
    });
  }
  assert.equal(config.getSoul(THREAD), "PARENT_SOUL");
});

test("a trigger homed in a private Discord thread resolves the parent's config", async () => {
  const runs: TurnRequest[] = [];
  await runTrigger(
    {
      deliveries: createDeliveryStore(),
      idempotency: createIdempotencyStore(testMap()),
      identity: createIdentityService(testMap(), { externalMembers: testMap() }),
      run: async (req: TurnRequest) => {
        runs.push(req);
        return { status: "ok", reply: "done" };
      },
      directory: {
        channelMember: async () => false,
        groupMember: async () => false,
        get: async () => null,
        channelPrivacy: async () => undefined,
        discordLookup: async () => ({ messages: [], channel: { channelId: THREAD_ID, name: "private" } }),
      },
      sessions: { participantScopes: async () => [] },
    } as never,
    { owner: "U1", ownerScopeId: THREAD, input: "check", fireKey: "cron:private-thread", surface: "cron" },
  );
  assert.equal(runs.length, 1);
  await assertParentConfig(await strictParent(), { ...runs[0]!.conversation, audience: [actor] } as Conversation);
});

test("a session started in a private Discord thread resolves the parent's config", async () => {
  const turns: TurnRequest[] = [];
  const session = { id: "s1", scopeId: THREAD, type: "channel", threadRef: `discord:th:${THREAD_ID}` };
  await startSession(
    {
      spawnSession: async () => ({ session }),
      turn: async (req: TurnRequest) => {
        turns.push(req);
        return { status: "ok" };
      },
    } as never,
    { get: async () => session } as never,
    "U1",
    { scopeId: THREAD, text: "hello" },
  );
  assert.equal(turns.length, 1);
  await assertParentConfig(await strictParent(), { ...turns[0]!.conversation, audience: [actor] } as Conversation);
});

async function serverWith(
  configure: (built: ReturnType<typeof buildApp>) => Promise<void>,
): Promise<{ base: string; built: ReturnType<typeof buildApp>; close: () => Promise<void> }> {
  const config = testConfig({ signingSecret: "private-thread-config-secret".repeat(2) });
  const built = buildApp(config);
  await built.app.upsertDirectory([{ principalId: "U1", displayName: "One", type: "internal" }]);
  await built.directory.replaceDiscordChannels(
    [{ channelId: THREAD_ID, name: "private", isPrivate: true }],
    [
      { channelId: THREAD_ID, principalId: "U1" },
      { channelId: THREAD_ID, principalId: "admin-alice" },
    ],
    Date.now(),
  );
  await configure(built);
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const capability = (claims: Record<string, unknown>) =>
  mintCapabilityToken(
    { actorId: "U1", scopeId: THREAD, aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS, ...claims } as never,
    TEST_CAPABILITY_SECRET,
  );

test("a strict parent blocks direct control-plane mutations from its private thread", async (t) => {
  const s = await serverWith(async (built) => void (await strictParent(built.config)));
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/soul`, {
    method: "POST",
    headers: { "x-agent-capability": await capability({}), "content-type": "application/json" },
    body: JSON.stringify({ content: "x" }),
  });
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { message: string }).message, /Strict posture/);
});

test("a strict parent disables browser model requests from its private thread", async (t) => {
  const s = await serverWith(async (built) => void (await strictParent(built.config)));
  t.after(s.close);
  const token = await capability({ aud: BROWSER_MODEL_AUD, browserModel: "m", browserAccount: "company" });
  const res = await fetch(`${s.base}/v1/browser-model/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-agent-capability": token, "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /strict posture/);
});

test("an isolated parent keeps private admin reads out of its private thread", async (t) => {
  const s = await serverWith(async (built) => void (await strictParent(built.config)));
  t.after(s.close);
  const token = await mintCapabilityToken(
    {
      actorId: "admin-alice",
      scopeId: THREAD,
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    TEST_CAPABILITY_SECRET,
  );
  const res = await fetch(`${s.base}/v1/admin/scopes/${encodeURIComponent(THREAD)}`, {
    headers: { "x-agent-capability": token },
  });
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { message: string }).message, /ask the agent in a DM/);
});

test("the agent reads its parent's SOUL in a private thread and cannot write a thread SOUL", async () => {
  const built = buildApp(testConfig());
  await built.config.linkConfigParent(THREAD, PARENT);
  await built.config.setSoul(PARENT, "PARENT_SOUL");
  const control = createControlService(built.app, built.scheduler, built.admin);
  const claims = { actorId: "U1", scopeId: THREAD, exp: Date.now() + CAPABILITY_TTL_MS };
  assert.equal((await control.readSoul(claims)).soul, "PARENT_SOUL");
  const write = await control.writeSoul("thread soul", claims);
  assert.equal(write.ok, false);
  assert.match(write.ok ? "" : write.message, /takes its configuration from/);
  assert.equal(built.config.getSoul(PARENT), "PARENT_SOUL");
});

test("an admin write to a private thread scope is refused with a clear 409", async (t) => {
  const s = await serverWith(async (built) => built.config.linkConfigParent(THREAD, PARENT));
  t.after(s.close);
  const token = await mintCapabilityToken(
    {
      actorId: "admin-alice",
      scopeId: scopeId("personal", "admin-alice"),
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    TEST_CAPABILITY_SECRET,
  );
  const res = await fetch(`${s.base}/v1/admin/scopes/${encodeURIComponent(THREAD)}/security-posture`, {
    method: "PUT",
    headers: { "x-agent-capability": token, "content-type": "application/json" },
    body: JSON.stringify({ posture: "auto" }),
  });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { message: string }).message, /takes its configuration from/);
});

test("a thread with config of its own is refused a link until that config is cleared", async () => {
  const maps = configStoreMaps(() => testMap());
  const config = testConfigStore("default-org", maps);
  await config.setEgress(THREAD, { allowedHosts: [], deniedHosts: ["thread-bad.test"] });
  await assert.rejects(config.linkConfigParent(THREAD, PARENT), (e: unknown) => {
    assert.ok(e instanceof ConfigConflictError);
    assert.match(e.message, /an admin must clear this thread's configuration/);
    return true;
  });
  assert.equal(await maps.configParents.get(THREAD), null);
  await maps.egressPolicies.delete(THREAD);
  await config.clearSharingPosture(THREAD);
  await config.linkConfigParent(THREAD, PARENT);
  await assertParentConfig(await strictParent(config), threadConversation());
});

test("SOUL reads follow the link to the parent's durable SOUL even when this instance's cache is stale", async () => {
  const built = buildApp(testConfig());
  await built.config.linkConfigParent(THREAD, PARENT);
  await built.config.setSoul(PARENT, "PARENT_SOUL");
  built.config.restoreSoulCacheSnapshot(PARENT, null);
  assert.equal(built.config.getSoul(THREAD), null);
  const control = createControlService(built.app, built.scheduler, built.admin);
  const read = await control.readSoul({ actorId: "U1", scopeId: THREAD, exp: Date.now() + CAPABILITY_TTL_MS });
  assert.equal(read.soul, "PARENT_SOUL");
  assert.equal(read.soulVersion, 1);
  assert.equal(built.config.soulHistory(THREAD)[0]?.content, "PARENT_SOUL");
});

test("one resolve reads the thread link once, and a Slack channel resolve never reads it", async () => {
  const reads: string[] = [];
  const maps = configStoreMaps((table) => {
    const map = testMap<never>();
    if (table !== "config_parents") return map;
    return {
      ...map,
      get: (id: string) => {
        reads.push(id);
        return map.get(id);
      },
    };
  });
  const config = await strictParent(testConfigStore("default-org", maps));
  const res = createResolutionService(
    "default-org",
    config,
    createAclStore(createPostgresGrantStore(testDatabaseUrl())),
  );
  reads.length = 0;
  await res.resolve(
    { kind: "channel", threadRef: "slack:C123:1", channelRef: "C0123SLACK", audience: [actor] } as Conversation,
    actor,
  );
  assert.deepEqual(reads, []);
  await res.resolve(threadConversation(), actor);
  assert.deepEqual(reads, [THREAD]);
});

function unseenPrivateThread(link: ThreadLinker) {
  const guild = { id: "g1", members: { cache: new Map([["111", { id: "111" }]]) } };
  const perms = { has: (p: unknown) => p !== PermissionFlagsBits.ManageThreads };
  const parent = {
    id: PARENT_ID,
    name: "ops",
    guildId: "g1",
    guild,
    type: ChannelType.GuildText,
    isThread: () => false,
    isTextBased: () => true,
    permissionsFor: () => perms,
  };
  const thread = {
    id: THREAD_ID,
    name: "private",
    guildId: "g1",
    guild,
    parent,
    parentId: PARENT_ID,
    type: ChannelType.PrivateThread,
    isThread: () => true,
    isTextBased: () => true,
    members: { cache: new Map([["111", {}]]), fetch: async () => ({}) },
  };
  const cache = new Map<string, unknown>([[PARENT_ID, parent]]);
  const client = {
    channels: { cache, fetch: async (id: string) => cache.get(id) ?? (id === THREAD_ID ? thread : null) },
  };
  const reader = createDiscordHistoryReader({
    channels: createDiscordChannels(client as never, link),
    guildIds: new Set(["g1"]),
    hydrator: { ready: () => true },
  });
  const outcomes: Array<{ result?: unknown }> = [];
  const ask = createChannelLookup({
    core: {
      fulfillContextRequest: async (_id, outcome) => void outcomes.push(outcome as never),
      discordUserIdsFor: () => ["111"],
    },
    reader,
    guard: { mayPost: async () => ({ ok: true }) },
  });
  const discordLookup = async (query: Record<string, unknown>) => {
    await ask({ id: "q", source: "discord", createdAt: 0, status: "pending", query } as never);
    return (outcomes.at(-1)?.result ?? null) as never;
  };
  return { reader, discordLookup };
}

async function cronInThread(discordLookup: (query: Record<string, unknown>) => Promise<never>) {
  const runs: TurnRequest[] = [];
  const out = await runTrigger(
    {
      deliveries: createDeliveryStore(),
      idempotency: createIdempotencyStore(testMap()),
      identity: createIdentityService(testMap(), { externalMembers: testMap() }),
      run: async (req: TurnRequest) => {
        runs.push(req);
        return { status: "ok", reply: "done" };
      },
      directory: {
        channelMember: async () => false,
        groupMember: async () => false,
        get: async () => null,
        channelPrivacy: async () => undefined,
        discordLookup,
      },
      sessions: { participantScopes: async () => [] },
    } as never,
    { owner: "U1", ownerScopeId: THREAD, input: "check", fireKey: "cron:unseen-private-thread", surface: "cron" },
  );
  return { out, runs };
}

test("a cron homed in a private thread the bot never saw links it on lookup and runs under the parent's config", async () => {
  const config = await strictParent(testConfigStore("default-org"), false);
  const link: ThreadLinker = (threadId, parentId) =>
    config.linkConfigParent(scopeId("channel", threadId), scopeId("channel", parentId));
  const { runs } = await cronInThread(unseenPrivateThread(link).discordLookup);
  assert.equal(runs.length, 1);
  await assertParentConfig(config, { ...runs[0]!.conversation, audience: [actor] } as Conversation);
});

test("a private thread whose link cannot be written is not visible to a lookup and its cron does not run", async () => {
  const failing: ThreadLinker = async () => {
    throw new Error("config store down");
  };
  const gateway = unseenPrivateThread(failing);
  await assert.rejects(gateway.reader.find(THREAD_ID), /config store down/);
  assert.equal(await gateway.reader.canView(THREAD_ID, "111"), undefined);
  const { out, runs } = await cronInThread(gateway.discordLookup);
  assert.equal(runs.length, 0);
  assert.equal(out.status, "refused");
  assert.equal(out.readersUnknown, true);
});

test("durable posture and grant reads leave no unhandled rejection when the link read fails first", async () => {
  let unhandled = 0;
  const onUnhandled = () => void unhandled++;
  process.on("unhandledRejection", onUnhandled);
  try {
    const maps = configStoreMaps(() => testMap());
    const slow = <M extends { get: (id: never) => Promise<unknown> }>(m: M): M => ({
      ...m,
      get: async (id: never) => {
        await new Promise((r) => setTimeout(r, 20));
        return m.get(id);
      },
    });
    const config = testConfigStore("default-org", {
      ...maps,
      securityPostures: slow(maps.securityPostures),
      approvalGrantModes: slow(maps.approvalGrantModes),
      configParents: {
        ...maps.configParents,
        get: async () => {
          throw new Error("pg blip");
        },
      },
    });
    await assert.rejects(config.getSecurityPostureDurable(THREAD), /pg blip/);
    await assert.rejects(config.getApprovalGrantModesDurable(THREAD), /pg blip/);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled, 0);
});
