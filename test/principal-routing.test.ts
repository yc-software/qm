import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createDeliveryStore, isPersonAddressed } from "../src/delivery/delivery-store.ts";
import {
  createDiscordPrincipalRoute,
  slackAccountOf,
  withPrincipalRouting,
} from "../src/delivery/principal-routing.ts";
import { linkedDiscordUserIds } from "../src/api/discord-core-client.ts";
import { principalDestination, relaySenderAttribution } from "../src/reach/reach.ts";
import { type PrincipalLinkService } from "../src/identity/principal-links.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { DISCORD_DM_DELIVERY_TYPE, discordExternalId } from "../src/discord/config.ts";
import { createDiscordDispatcher, DISCORD_DELIVERY_CLAIM_MS, type DeliveryGuard } from "../src/discord/deliveries.ts";
import type { DiscordSender } from "../src/discord/sender.ts";
import type { Delivery } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { installDiscord } from "./support/discord-channels.ts";
import { testPrincipalLinks } from "./support/principal-links.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";

const toDiscord = async (p: string) => (p === "ana@acme.com" ? DISCORD_DM_DELIVERY_TYPE : null);

afterEach(() => {
  installPrincipalLinks(null);
});

test("a person routed to Discord gets exactly one discord-dm delivery and no principal row", async () => {
  const store = withPrincipalRouting(createDeliveryStore(), toDiscord);
  const result = await store.enqueue({
    destination: { ...principalDestination("ana@acme.com", "bob@acme.com"), keychainAskId: "k1" },
    text: "hi",
    idempotencyKey: "k1",
  });
  assert.equal(result.idempotencyKey, "k1");
  assert.equal(result.destination.type, DISCORD_DM_DELIVERY_TYPE);
  assert.equal(result.destination.target, "ana@acme.com");
  assert.equal(result.destination.keychainAskId, "k1");

  await store.enqueue({
    destination: principalDestination("bob@acme.com", "ana@acme.com"),
    text: "hi",
    idempotencyKey: "k2",
  });
  await store.enqueue({ destination: { type: "slack", target: "C1" }, text: "hi", idempotencyKey: "k3" });

  assert.deepEqual(
    (await store.pending("principal")).map((d) => d.idempotencyKey),
    ["k2"],
  );
  assert.deepEqual(
    (await store.pending(DISCORD_DM_DELIVERY_TYPE)).map((d) => d.idempotencyKey),
    ["k1"],
  );
  assert.deepEqual(
    (await store.pending("slack")).map((d) => d.idempotencyKey),
    ["k3"],
  );
});

test("non-principal destinations are never rerouted even when the route returns discord-dm", async () => {
  const alwaysDiscord = async () => DISCORD_DM_DELIVERY_TYPE;
  const store = withPrincipalRouting(createDeliveryStore(), alwaysDiscord);
  await store.enqueue({
    destination: { type: "slack", target: "C1" },
    text: "slack message",
    idempotencyKey: "k-slack",
  });
  await store.enqueue({
    destination: { type: "web", target: "web:user:thread" },
    text: "web message",
    idempotencyKey: "k-web",
  });
  await store.enqueue({
    destination: { type: "group", target: "G1" },
    text: "group message",
    idempotencyKey: "k-group",
  });

  assert.deepEqual(await store.pending(DISCORD_DM_DELIVERY_TYPE), []);
  assert.equal((await store.pending("slack")).length, 1);
  assert.equal((await store.pending("web")).length, 1);
  assert.equal((await store.pending("group")).length, 1);
});

test("a route error falls back to enqueueing the original principal row without dropping it", async () => {
  const failingRoute = async () => {
    throw new Error("store failure");
  };
  const store = withPrincipalRouting(createDeliveryStore(), failingRoute);
  await store.enqueue({
    destination: principalDestination("ana@acme.com", "bob@acme.com"),
    text: "resilient notice",
    idempotencyKey: "resilient-key",
  });
  const pending = await store.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.idempotencyKey, "resilient-key");
  assert.deepEqual(await store.pending(DISCORD_DM_DELIVERY_TYPE), []);
});

test("isPersonAddressed covers principal and discord-dm across delivery-store thread recording", async () => {
  assert.equal(isPersonAddressed({ type: "principal" }), true);
  assert.equal(isPersonAddressed({ type: DISCORD_DM_DELIVERY_TYPE }), true);
  assert.equal(isPersonAddressed({ type: "slack" }), false);

  const store = createDeliveryStore();
  const dPrincipal = await store.enqueue({
    destination: principalDestination("ana@acme.com", "bob@acme.com"),
    text: "principal text",
    idempotencyKey: "p1",
  });
  const dDiscord = await store.enqueue({
    destination: { type: DISCORD_DM_DELIVERY_TYPE, target: "ana@acme.com" },
    text: "discord text",
    idempotencyKey: "p2",
  });

  await store.recordRecipientThread(dPrincipal.id, "slack:dm:D1", 1000);
  await store.recordRecipientThread(dDiscord.id, "discord:dm:12345", 2000);

  const slackMatches = await store.listByRecipientThread("slack:dm:D1");
  assert.equal(slackMatches.length, 1);
  assert.equal(slackMatches[0]!.id, dPrincipal.id);

  const discordMatches = await store.listByRecipientThread("discord:dm:12345");
  assert.equal(discordMatches.length, 1);
  assert.equal(discordMatches[0]!.id, dDiscord.id);
});

test("relaySenderAttribution formats attribution string and discord dispatcher renders it", async () => {
  assert.equal(relaySenderAttribution("@charlie"), "Sent for @charlie");
  assert.equal(relaySenderAttribution("charlie"), "Sent for @charlie");
  assert.equal(relaySenderAttribution(undefined), null);

  const log: string[] = [];
  const sender: DiscordSender = {
    send: async (c, m) => {
      log.push(`send:${c}:${m.content ?? ""}`);
      return { id: "m1" };
    },
    edit: async () => {},
    react: async () => {},
    remove: async () => {},
    unreact: async () => {},
    openDm: async (userId) => {
      log.push(`openDm:${userId}`);
      return "dm-chan-42";
    },
  };
  const deliveryRow: Delivery = {
    id: "deliv-relay",
    destination: { type: DISCORD_DM_DELIVERY_TYPE, target: "ana@acme.com", relaySender: "bob@acme.com" },
    text: "relayed message",
    idempotencyKey: "pnotice-relay",
    createdAt: 1000,
    deliveredAt: null,
  };
  const core = {
    claimDeliveries: async (surface: string) => (surface === DISCORD_DM_DELIVERY_TYPE ? [deliveryRow] : []),
    ackDelivery: async (id: string) => {
      log.push(`ack:${id}`);
    },
    reportDeliveryUndeliverable: async () => {},
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  };
  const guard: DeliveryGuard = {
    mayPost: async () => ({ ok: true }),
  };
  const dispatcher = createDiscordDispatcher({
    core,
    sender,
    guard,
    inFlightRuns: new Set<string>(),
    ownedRuns: new Set<string>(),
    recipientFor: () => "discord-user-111",
    now: () => 100_000,
  });
  await dispatcher.drain();
  assert.deepEqual(log, [
    "openDm:discord-user-111",
    "send:dm-chan-42:relayed message\n\nSent for @bob@acme.com",
    "ack:deliv-relay",
  ]);
});

function installationStatus(opts: { configured: boolean }) {
  return {
    status: async () => ({
      configured: opts.configured,
      guildIds: [],
      internalRoleIds: [],
      oauthConfigured: false,
    }),
    get: async () => {
      throw new Error("get() must not be called");
    },
  };
}
const linked = (p: string) => (p === "ana@acme.com" ? ["111"] : []);

test("createDiscordPrincipalRoute uses status alone without calling decrypting get", async () => {
  const on = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: true }),
    linkedDiscordUserIds: linked,
    hasSlackAccount: async () => false,
  });
  const none = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: false }),
    linkedDiscordUserIds: linked,
    hasSlackAccount: async () => false,
  });
  assert.equal(await on("ana@acme.com"), DISCORD_DM_DELIVERY_TYPE);
  assert.equal(await on("bob@acme.com"), null);
  assert.equal(await none("ana@acme.com"), null);
});

test("a person with a linked Slack account keeps the principal route", async () => {
  const route = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: true }),
    linkedDiscordUserIds: (p) => (p === "discord:111" || p === "ana@acme.com" ? ["111"] : []),
    hasSlackAccount: async () => true,
  });
  assert.equal(await route("ana@acme.com"), null);
  assert.equal(await route("discord:111"), DISCORD_DM_DELIVERY_TYPE);
});

test("a Slack-only-id principal with a linked Discord account stays on the principal route", async () => {
  const directory = createPostgresDirectoryStore(testDatabaseUrl());
  await directory.replace([
    { principalId: "U0SLACKAMY", displayName: "Amy", type: "internal" },
    { principalId: "cora@acme.com", displayName: "Cora", type: "internal", slackId: "UCORA" },
    { principalId: "dan@acme.com", displayName: "Dan", type: "internal" },
  ]);
  const route = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: true }),
    linkedDiscordUserIds: () => ["111"],
    hasSlackAccount: slackAccountOf(directory),
  });
  assert.equal(await route("U0SLACKAMY"), null);
  assert.equal(await route("cora@acme.com"), null);
  assert.equal(await route("nobody@acme.com"), DISCORD_DM_DELIVERY_TYPE);
  assert.equal(await route("dan@acme.com"), DISCORD_DM_DELIVERY_TYPE);
  assert.equal(await route("U0NOROWYET"), null);
});

test("a Slack user id linked to an email row without slackId still counts as Slack", async () => {
  const directory = createPostgresDirectoryStore(testDatabaseUrl());
  await directory.replace([{ principalId: "erin@acme.com", displayName: "Erin", type: "internal" }]);
  installPrincipalLinks({
    canonical: (key) => (key === "U0SLACKERIN" || key === "erin@acme.com" ? "erin@acme.com" : undefined),
    aliases: (key) => (key === "erin@acme.com" ? ["U0SLACKERIN"] : []),
  });
  const route = createDiscordPrincipalRoute({
    installation: installationStatus({ configured: true }),
    linkedDiscordUserIds: () => ["111"],
    hasSlackAccount: slackAccountOf(directory),
  });
  assert.equal(await route("U0SLACKERIN"), null);
});

test("a Slack request's approval card stays on Slack even when the person has Discord", async () => {
  const store = withPrincipalRouting(createDeliveryStore(), toDiscord);
  await store.enqueue({
    destination: { ...principalDestination("ana@acme.com", "bob@acme.com"), commandApprovalId: "ap1" },
    text: "approve?",
    idempotencyKey: "ap1",
  });
  assert.deepEqual(
    (await store.pending("principal")).map((d) => d.idempotencyKey),
    ["ap1"],
  );
  assert.deepEqual(await store.pending(DISCORD_DM_DELIVERY_TYPE), []);
});

test("command-approval cards are never rerouted to discord-dm", async () => {
  const store = withPrincipalRouting(createDeliveryStore(), async () => DISCORD_DM_DELIVERY_TYPE);
  const result = await store.enqueue({
    destination: { ...principalDestination("ana@acme.com", "bob@acme.com"), commandApprovalId: "ap2" },
    text: "approve?",
    idempotencyKey: "ap2",
  });
  assert.equal(result.destination.type, "principal");
});

test("linkedDiscordUserIds extracts linked discord user ids from principal links", async () => {
  const links: PrincipalLinkService = testPrincipalLinks();
  installPrincipalLinks(links);
  await links.link({
    principalId: discordExternalId("discord-456"),
    canonicalId: "ana@acme.com",
    evidence: "oauth",
    linkedBy: "ana@acme.com",
  });
  await links.link({
    principalId: "slack:U999",
    canonicalId: "ana@acme.com",
    evidence: "slack-link",
    linkedBy: "ana@acme.com",
  });
  assert.deepEqual(linkedDiscordUserIds("ana@acme.com"), ["discord-456"]);
  assert.deepEqual(linkedDiscordUserIds("unlinked@acme.com"), []);
});

test("withPrincipalRouting feeds routed notices to the discord dispatcher", async () => {
  const log: string[] = [];
  const sender: DiscordSender = {
    send: async (c, m) => {
      log.push(`send:${c}:${m.content ?? ""}`);
      return { id: "m1" };
    },
    edit: async () => {},
    react: async () => {},
    remove: async () => {},
    unreact: async () => {},
    openDm: async (userId) => {
      log.push(`openDm:${userId}`);
      return "dm-chan-42";
    },
  };
  const baseStore = createDeliveryStore();
  const store = withPrincipalRouting(baseStore, toDiscord);

  await store.enqueue({
    destination: principalDestination("ana@acme.com", "bob@acme.com"),
    text: "personal notice text",
    idempotencyKey: "pnotice-1",
  });

  const core = {
    claimDeliveries: async (surface: string, claimMs: number) => {
      assert.equal(claimMs, DISCORD_DELIVERY_CLAIM_MS);
      return store.claimPending(surface, claimMs);
    },
    ackDelivery: async (id: string) => {
      log.push(`ack:${id}`);
      await store.ack(id, Date.now());
    },
    reportDeliveryUndeliverable: async (id: string, reason: string) => {
      log.push(`undeliverable:${id}:${reason}`);
    },
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  };
  const guard: DeliveryGuard = {
    mayPost: async (channelId) => {
      log.push(`mayPost:${channelId}`);
      return { ok: true };
    },
  };
  const dispatcher = createDiscordDispatcher({
    core,
    sender,
    guard,
    inFlightRuns: new Set<string>(),
    ownedRuns: new Set<string>(),
    recipientFor: (t) => (t === "ana@acme.com" ? "discord-user-111" : null),
    now: () => 100_000,
  });
  await dispatcher.drain();

  assert.equal(log[0], "openDm:discord-user-111");
  assert.equal(log[1], "mayPost:dm-chan-42");
  assert.equal(log[2], "send:dm-chan-42:personal notice text");
  assert.match(log[3]!, /^ack:/);

  assert.deepEqual(await store.pending("principal"), []);
  assert.deepEqual(await store.pending(DISCORD_DM_DELIVERY_TYPE), []);
});

test("buildApp routes a Discord-linked person without Slack to discord-dm and one with Slack to principal", async () => {
  const built = buildApp(testConfig());
  await installDiscord(built);
  for (const [discordId, email] of [
    ["discord-user-888", "ana@acme.com"],
    ["discord-user-999", "cora@acme.com"],
  ] as const)
    await built.principalLinks.link({
      principalId: discordExternalId(discordId),
      canonicalId: email,
      evidence: "oauth",
      linkedBy: email,
    });
  await built.directory.replace([
    { principalId: "cora@acme.com", displayName: "Cora", type: "internal", slackId: "UCORA" },
  ]);

  for (const [email, key] of [
    ["ana@acme.com", "ba-ana"],
    ["cora@acme.com", "ba-cora"],
  ] as const)
    await built.deliveries.enqueue({
      destination: principalDestination(email, "system"),
      text: "buildApp notice",
      idempotencyKey: key,
    });

  assert.deepEqual(
    (await built.deliveries.pending("principal")).map((d) => d.idempotencyKey),
    ["ba-cora"],
  );
  const discordRows = await built.deliveries.pending(DISCORD_DM_DELIVERY_TYPE);
  assert.deepEqual(
    discordRows.map((d) => d.idempotencyKey),
    ["ba-ana"],
  );
  assert.equal(discordRows[0]!.destination.target, "ana@acme.com");
});

test("recordPrincipalDelivery records recipient thread for discord-dm deliveries", async () => {
  const built = buildApp(testConfig());
  const delivery = await built.deliveries.enqueue({
    destination: { type: DISCORD_DM_DELIVERY_TYPE, target: "ana@acme.com" },
    text: "discord dm text",
    idempotencyKey: "test-rec-1",
  });
  await built.app.recordPrincipalDelivery(delivery.id, "discord:dm:channel-99");
  const threadDeliveries = await built.deliveries.listByRecipientThread("discord:dm:channel-99");
  assert.equal(threadDeliveries.length, 1);
  assert.equal(threadDeliveries[0]!.id, delivery.id);
  assert.equal((await built.sessions.getByThread("discord:dm:channel-99"))?.surface, "discord");
});

test("a Discord-only principal gets one discord-dm delivery and no stranded principal row", async () => {
  const store = withPrincipalRouting(createDeliveryStore(), async () => DISCORD_DM_DELIVERY_TYPE);
  const result = await store.enqueue({
    destination: principalDestination("discord:42", "bob@acme.com"),
    text: "hi",
    idempotencyKey: "h1",
  });
  assert.equal(result.destination.type, DISCORD_DM_DELIVERY_TYPE);
  assert.equal(result.idempotencyKey, "h1");
  assert.deepEqual(await store.pending("principal"), []);
  assert.deepEqual(
    (await store.pending(DISCORD_DM_DELIVERY_TYPE)).map((d) => d.destination.target),
    ["discord:42"],
  );
});

test("a Discord-only principal enqueues nothing when Discord routing is off or the route fails", async () => {
  const destination = principalDestination("discord:42", "bob@acme.com");
  const off = withPrincipalRouting(createDeliveryStore(), async () => null);
  await assert.rejects(off.enqueue({ destination, text: "hi", idempotencyKey: "h2" }), /discord delivery unavailable/);
  assert.deepEqual(await off.pending("principal"), []);
  const failing = withPrincipalRouting(createDeliveryStore(), async () => {
    throw new Error("install store down");
  });
  await assert.rejects(failing.enqueue({ destination, text: "hi", idempotencyKey: "h3" }), /install store down/);
  assert.deepEqual(await failing.pending("principal"), []);
});
