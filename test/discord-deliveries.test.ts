import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDeliveryGuard,
  createDiscordDispatcher,
  DISCORD_DELIVERY_CLAIM_MS,
  DISCORD_RUN_RECOVERY_GRACE_MS,
  parseDiscordTarget,
  type DeliveryGuard,
  type PostVerdict,
} from "../src/discord/deliveries.ts";
import { InvalidMessageIdError, type DiscordSender } from "../src/discord/sender.ts";
import type { Delivery, Destination } from "../src/types.ts";

const BAD_TOKEN = "~zz";

function row(over: Omit<Partial<Delivery>, "destination"> & { destination?: Partial<Destination> }): Delivery {
  return {
    id: "d1",
    text: "hello",
    idempotencyKey: "post:x",
    createdAt: 0,
    deliveredAt: null,
    ...over,
    destination: { type: "discord", target: "c1", ...over.destination } as Destination,
  } as Delivery;
}

function harness(
  rows: Delivery[],
  guard: DeliveryGuard = { mayPost: async () => ({ ok: true }) },
  inFlight = new Set<string>(),
  owned = new Set<string>(),
) {
  const log: string[] = [];
  const sender: DiscordSender = {
    send: async (c, m) => {
      log.push(`send:${c}:${m.content ?? ""}:${m.replyTo ?? ""}`);
      return { id: "new" };
    },
    edit: async (c, id, m) => {
      if (id === BAD_TOKEN) throw new InvalidMessageIdError(id);
      log.push(`edit:${c}:${id}:${m.content}`);
    },
    react: async (c, id, e) => {
      if (id === BAD_TOKEN) throw new InvalidMessageIdError(id);
      log.push(`react:${c}:${id}:${e}`);
    },
    remove: async (c, id) => {
      if (id === BAD_TOKEN) throw new InvalidMessageIdError(id);
      log.push(`remove:${c}:${id}`);
    },
    unreact: async (c, id, e) => void log.push(`unreact:${c}:${id}:${e}`),
    openDm: async () => "dm",
  };
  const core = {
    claimDeliveries: async (surface: string, claimMs: number) => {
      assert.equal(claimMs, DISCORD_DELIVERY_CLAIM_MS);
      return surface === "discord" ? rows : [];
    },
    ackDelivery: async (id: string) => void log.push(`ack:${id}`),
    reportDeliveryUndeliverable: async (id: string, reason: string) => void log.push(`undeliverable:${id}:${reason}`),
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  };
  const dispatcher = createDiscordDispatcher({
    core,
    sender,
    guard,
    inFlightRuns: inFlight,
    ownedRuns: owned,
    recipientFor: () => null,
    now: () => 100_000,
  });
  return { log, dispatcher };
}

test("targets carry an optional reply-to message", () => {
  assert.deepEqual(parseDiscordTarget("c1"), { channelId: "c1" });
  assert.deepEqual(parseDiscordTarget("c1:m1"), { channelId: "c1", replyTo: "m1" });
});

test("a react delivery reacts on the message id it carries", async () => {
  const h = harness([
    row({ id: "r2", text: "", destination: { react: { messageTs: "1300000000000000002", emoji: "👍" } } }),
  ]);
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["react:c1:1300000000000000002:👍", "ack:r2"]);
});

test("a plain post is sent and acked", async () => {
  const h = harness([row({ destination: { target: "c1:m1" } })]);
  assert.equal(await h.dispatcher.drain(), true);
  assert.deepEqual(h.log, ["send:c1:hello:m1", "ack:d1"]);
});

test("a delivery to a channel with a guest reader is dropped, not posted", async () => {
  const h = harness([row({})], { mayPost: async () => ({ ok: false, retry: false, reason: "guest reader" }) });
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["undeliverable:d1:guest reader", "ack:d1"]);
});

test("a delivery whose readers are not known yet is left unacked for retry", async () => {
  const h = harness([row({})], { mayPost: async () => ({ ok: false, retry: true, reason: "members_not_ready" }) });
  await h.dispatcher.drain();
  assert.deepEqual(h.log, []);
});

test("run rows are skipped while in flight or inside the grace window", async () => {
  const young = row({ id: "d2", idempotencyKey: "run:r2", createdAt: 100_000 - DISCORD_RUN_RECOVERY_GRACE_MS + 1 });
  const flying = row({ id: "d3", idempotencyKey: "run:r3", createdAt: 0 });
  const old = row({ id: "d4", idempotencyKey: "run:r4", createdAt: 0, destination: { editRef: "s4" } });
  const h = harness([young, flying, old], undefined, new Set(["r3"]));
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["edit:c1:s4:hello", "ack:d4"]);
});

test("a young run row owned by this process is sent at once, once", async () => {
  const young = row({ id: "d2", idempotencyKey: "run:r2", createdAt: 100_000 });
  const owned = new Set(["r2"]);
  const h = harness([young], undefined, undefined, owned);
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["send:c1:hello:", "ack:d2"]);
  assert.equal(owned.has("r2"), false);
});

test("a long editRef delivery edits the placeholder and sends the rest", async () => {
  const h = harness([row({ text: "x".repeat(2500), destination: { editRef: "s1" } })]);
  await h.dispatcher.drain();
  assert.equal(h.log[0]!.startsWith("edit:c1:s1:"), true);
  assert.equal(h.log[1]!.startsWith("send:c1:"), true);
  assert.equal(h.log.at(-1), "ack:d1");
});

test("an unresolvable emoji is reported and acked, not retried", async () => {
  const good = row({ id: "r1", text: "", destination: { react: { messageTs: "m1", emoji: "👍" } } });
  const bad = row({ id: "r2", text: "", destination: { react: { messageTs: "m1", emoji: "no_such_emoji_zz" } } });
  const h = harness([good, bad]);
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["react:c1:m1:👍", "ack:r1", "undeliverable:r2:Discord cannot resolve that emoji", "ack:r2"]);
});

test("shortcodes and custom guild emoji forms resolve to what discord accepts", async () => {
  const emojis = [
    "+1",
    ":tada:",
    "<:party:123456789012345678>",
    "<a:spin:123456789012345679>",
    ":TADA:",
    ":heart:",
    "thumbsup",
  ];
  const h = harness(
    emojis.map((emoji, i) => row({ id: `e${i}`, text: "", destination: { react: { messageTs: "m1", emoji } } })),
  );
  await h.dispatcher.drain();
  assert.deepEqual(
    h.log.filter((l) => l.startsWith("react:")),
    [
      "react:c1:m1:👍",
      "react:c1:m1:🎉",
      "react:c1:m1:party:123456789012345678",
      "react:c1:m1:a:spin:123456789012345679",
      "react:c1:m1:🎉",
      "react:c1:m1:\u2764\uFE0F",
      "react:c1:m1:👍",
    ],
  );
});

test("deletes remove the message", async () => {
  const h = harness([row({ text: "", destination: { delete: { messageTs: "m7" } } })]);
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["remove:c1:m7", "ack:d1"]);
});

test("a send failure is reported and left unacked for retry", async () => {
  const h = harness([row({})]);
  const failing = createDiscordDispatcher({
    core: {
      claimDeliveries: async (type: string) => (type === "discord" ? [row({})] : []),
      ackDelivery: async () => void h.log.push("ack"),
      reportDeliveryUndeliverable: async (_id: string, r: string) => void h.log.push(`undeliverable:${r}`),
      holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
      readBlob: async () => Buffer.from(""),
      readFileArtifact: async () => Buffer.from(""),
    },
    sender: {
      send: async () => {
        throw new Error("503");
      },
    } as never,
    guard: { mayPost: async () => ({ ok: true }) },
    inFlightRuns: new Set(),
    ownedRuns: new Set(),
    recipientFor: () => null,
  });
  await failing.drain();
  assert.deepEqual(h.log, ["undeliverable:503"]);
});

test("the guard drops guest-readable and unconfigured channels, retries unknown readers and recipients", async () => {
  const guard = createDeliveryGuard({
    channelKind: async (id) =>
      (
        ({
          pub: { kind: "guild", baseChannelId: "pub" },
          priv: { kind: "guild", baseChannelId: "priv" },
          other: { kind: "guild", baseChannelId: "other" },
          cold: { kind: "guild", baseChannelId: "cold" },
          dmGuest: { kind: "dm", recipientId: "4" },
          dmStaff: { kind: "dm", recipientId: "1" },
          dmUnknown: { kind: "dm", recipientId: "5" },
        }) as const
      )[id] ?? null,
    readers: async (base) => {
      if (base === "pub")
        return { ok: true, readers: [{ externalId: "discord:1" }, { externalId: "discord:4", isExternalGuest: true }] };
      if (base === "other") return { ok: false, retry: false, reason: "guild_not_configured" };
      if (base === "cold") return { ok: false, retry: true, reason: "members_not_ready" };
      return { ok: true, readers: [{ externalId: "discord:1" }] };
    },
    classifyUser: async (id) => {
      if (id === "1") return { externalId: "discord:1" };
      if (id === "5") return null;
      return { externalId: `discord:${id}`, isExternalGuest: true };
    },
  });
  const pubVerdict: PostVerdict = await guard.mayPost("pub");
  assert.deepEqual(pubVerdict, { ok: false, retry: false, reason: "guest reader" });
  assert.deepEqual(await guard.mayPost("priv"), { ok: true });
  assert.deepEqual(await guard.mayPost("other"), { ok: false, retry: false, reason: "guild_not_configured" });
  assert.deepEqual(await guard.mayPost("cold"), { ok: false, retry: true, reason: "members_not_ready" });
  assert.deepEqual(await guard.mayPost("dmGuest"), { ok: false, retry: false, reason: "DM recipient is not internal" });
  assert.deepEqual(await guard.mayPost("dmStaff"), { ok: true });
  assert.deepEqual(await guard.mayPost("dmUnknown"), {
    ok: false,
    retry: true,
    reason: "DM recipient not classified yet",
  });
  assert.deepEqual(await guard.mayPost("missing"), { ok: false, retry: false, reason: "channel not found" });
});

test("lease loss mid-drain stops dispatching subsequent deliveries", async () => {
  let notifyLost!: () => void;
  const lost = new Promise<void>((resolve) => {
    notifyLost = resolve;
  });
  const log: string[] = [];
  const sender: DiscordSender = {
    send: async (c, m) => {
      log.push(`send:${c}:${m.content ?? ""}:${m.replyTo ?? ""}`);
      notifyLost();
      return { id: "new" };
    },
    edit: async () => {},
    react: async () => {},
    remove: async () => {},
    unreact: async () => {},
    openDm: async () => "dm",
  };
  const core = {
    claimDeliveries: async (type: string) =>
      type === "discord" ? [row({ id: "d1" }), row({ id: "d2" }), row({ id: "d3" })] : [],
    ackDelivery: async (id: string) => void log.push(`ack:${id}`),
    reportDeliveryUndeliverable: async (id: string, reason: string) => void log.push(`undeliverable:${id}:${reason}`),
    holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(lost),
    readBlob: async () => Buffer.from(""),
    readFileArtifact: async () => Buffer.from(""),
  };
  const dispatcher = createDiscordDispatcher({
    core,
    sender,
    guard: { mayPost: async () => ({ ok: true }) },
    inFlightRuns: new Set(),
    ownedRuns: new Set(),
    recipientFor: () => null,
  });
  assert.equal(await dispatcher.drain(), true);
  assert.deepEqual(log, ["send:c1:hello:", "ack:d1"]);
});

function dmHarness(opts: { recipient: string | null; openDmFails?: boolean; destination?: Partial<Destination> }) {
  const log: string[] = [];
  const dispatcher = createDiscordDispatcher({
    core: {
      claimDeliveries: async (type: string) =>
        type === "discord-dm"
          ? [
              row({
                id: "p1",
                destination: {
                  type: "discord-dm",
                  target: "discord:111",
                  commandApprovalId: "A1",
                  ...opts.destination,
                },
                text: "Approval needed: ls",
              }),
            ]
          : [],
      ackDelivery: async (id: string, body?: { recipientThreadRef?: string }) =>
        void log.push(`ack:${id}:${body?.recipientThreadRef ?? ""}`),
      reportDeliveryUndeliverable: async (id: string, r: string) => void log.push(`undeliverable:${id}:${r}`),
      holdDeliveryDispatch: async <T>(fn: (lost: Promise<void>) => Promise<T>) => fn(new Promise(() => {})),
      readBlob: async () => Buffer.from(""),
      readFileArtifact: async () => Buffer.from(""),
    },
    sender: {
      send: async (c: string, m: { content?: string; components?: unknown[] }) => (
        log.push(`send:${c}:${m.components?.length ?? 0}`),
        { id: "x" }
      ),
      openDm: async (userId: string) => {
        log.push(`open:${userId}`);
        if (opts.openDmFails) throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
        return `dm-${userId}`;
      },
      edit: async () => void log.push("edit"),
    } as never,
    guard: { mayPost: async () => ({ ok: true }) },
    inFlightRuns: new Set(),
    ownedRuns: new Set(),
    renderCard: async () => ({ content: "card", components: [{}] as never }),
    recipientFor: () => opts.recipient,
  });
  return { dispatcher, log };
}

test("a discord-dm card opens the recipient's DM and acks with the DM thread", async () => {
  const h = dmHarness({ recipient: "111" });
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["open:111", "send:dm-111:1", "ack:p1:discord:dm:dm-111"]);
});

test("a recipient with DMs closed is reported and dropped; the web link in the thread is the fallback", async () => {
  const h = dmHarness({ recipient: "111", openDmFails: true });
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["open:111", "undeliverable:p1:recipient does not accept DMs from the bot", "ack:p1:"]);
});

test("a discord-dm row with no Discord recipient is reported and dropped", async () => {
  const h = dmHarness({ recipient: null });
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["undeliverable:p1:no linked Discord account", "ack:p1:"]);
});

test("delivery guard refuses DM recipient who is deactivated (guest) and allows normal internal recipient", async () => {
  const guard = createDeliveryGuard({
    channelKind: async (id) =>
      id === "dm-deact" ? { kind: "dm", recipientId: "u-deact" } : { kind: "dm", recipientId: "u-norm" },
    readers: async () => ({ ok: true, guildId: "g1", readers: [] }),
    classifyUser: async (id) =>
      id === "u-deact"
        ? { externalId: `discord:${id}`, displayName: id, isExternalGuest: true }
        : { externalId: `discord:${id}`, displayName: id },
  });
  const deactVerdict = await guard.mayPost("dm-deact");
  assert.deepEqual(deactVerdict, { ok: false, retry: false, reason: "DM recipient is not internal" });

  const normVerdict = await guard.mayPost("dm-norm");
  assert.deepEqual(normVerdict, { ok: true });
});

test("a keychain resolution row is acked without opening a DM or sending anything", async () => {
  const h = dmHarness({ recipient: "111", destination: { keychainAskId: "k1", keychainResolution: true } });
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["ack:p1:"]);
});

test("a ~id token on react, edit or remove reaches the sender as the raw snowflake", async () => {
  const h = harness([
    row({ id: "a", text: "", destination: { react: { messageTs: "~9vkbjfeanyf5", emoji: "👍" } } }),
    row({ id: "b", destination: { editRef: "~9vkbjfeanyf5" } }),
    row({ id: "c", text: "", destination: { delete: { messageTs: "~9vkbjfeanyf5" } } }),
  ]);
  await h.dispatcher.drain();
  assert.deepEqual(h.log, [
    "react:c1:1300000000000000001:👍",
    "ack:a",
    "edit:c1:1300000000000000001:hello",
    "ack:b",
    "remove:c1:1300000000000000001",
    "ack:c",
  ]);
});

test("a ~id token reply target reaches the sender as the raw snowflake", async () => {
  const h = harness([row({ id: "a", destination: { target: "c1:~9vkbjfeanyf5" } })]);
  await h.dispatcher.drain();
  assert.deepEqual(h.log, ["send:c1:hello:1300000000000000001", "ack:a"]);
});

test("an undecodable ~id token on react, edit or remove is reported once and acked, not retried", async () => {
  const h = harness([
    row({ id: "a", text: "", destination: { react: { messageTs: BAD_TOKEN, emoji: "👍" } } }),
    row({ id: "b", destination: { editRef: BAD_TOKEN } }),
    row({ id: "c", text: "", destination: { delete: { messageTs: BAD_TOKEN } } }),
  ]);
  await h.dispatcher.drain();
  assert.deepEqual(h.log, [
    `undeliverable:a:${BAD_TOKEN}`,
    "ack:a",
    `undeliverable:b:${BAD_TOKEN}`,
    "ack:b",
    `undeliverable:c:${BAD_TOKEN}`,
    "ack:c",
  ]);
});
