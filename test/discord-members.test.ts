import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { classifyMember, mergeMemberships } from "../src/discord/members.ts";
import { createDiscordCoreClient } from "../src/api/discord-core-client.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";

const cfg = { internalRoleIds: new Set(["r-staff"]) };
const notLinked = async () => false;
const member = (userId: string, roleIds: string[] = [], isBot = false) => ({
  userId,
  displayName: `u${userId}`,
  roleIds,
  isBot,
});

const defaultCore = async () => ({ notInternal: false });

afterEach(() => installPrincipalLinks(null));

test("internal-role and linked-internal members are internal; a user id in an allow list is not enough", async () => {
  const withAllowList = { ...cfg, allowUserIds: new Set(["1"]) } as never;
  assert.equal((await classifyMember(member("1"), withAllowList, notLinked, defaultCore)).isExternalGuest, true);
  assert.equal(
    (await classifyMember(member("2", ["r-staff"]), cfg, notLinked, defaultCore)).isExternalGuest,
    undefined,
  );
  assert.equal(
    (await classifyMember(member("3"), cfg, async (id) => id === "3", defaultCore)).isExternalGuest,
    undefined,
  );
});

test("the any-guild rule does not depend on guild order", async () => {
  const a = { userId: "6", displayName: "u6", roleIds: ["r-other"], isBot: false };
  const b = { userId: "6", displayName: "u6", roleIds: ["r-staff"], isBot: false };
  const ab = await classifyMember(mergeMemberships("6", "u6", [a, b]), cfg, notLinked, defaultCore);
  const ba = await classifyMember(mergeMemberships("6", "u6", [b, a]), cfg, notLinked, defaultCore);
  assert.deepEqual(ab, ba);
  assert.equal(ab.isExternalGuest, undefined);
  assert.equal(
    (await classifyMember(mergeMemberships("6", "u6", []), cfg, notLinked, defaultCore)).isExternalGuest,
    true,
  );
});

test("everyone else, bots included, is a guest", async () => {
  const guest = await classifyMember(member("4", ["r-other"]), cfg, notLinked, defaultCore);
  assert.deepEqual(guest, { externalId: "discord:4", displayName: "u4", isExternalGuest: true });
  const bot = await classifyMember(member("5", [], true), cfg, notLinked, defaultCore);
  assert.deepEqual(bot, { externalId: "discord:5", displayName: "u5", isBot: true, isExternalGuest: true });
});

test("a deactivated user with the internal role is a guest reader and is refused as a DM recipient", async () => {
  const deactCore = async (id: string) => ({ notInternal: id === "2" });
  const deactivatedRoleHolder = await classifyMember(member("2", ["r-staff"]), cfg, notLinked, deactCore);
  assert.equal(deactivatedRoleHolder.isExternalGuest, true);

  const normalRoleHolder = await classifyMember(member("3", ["r-staff"]), cfg, notLinked, deactCore);
  assert.equal(normalRoleHolder.isExternalGuest, undefined);
});

function identity(internal: Set<string>) {
  return {
    refresh: async () => {},
    classify: (id: string) => ({ id, type: internal.has(id) ? "internal" : "guest" }),
    externalMember: () => undefined,
  };
}

test("linkedInternal is true only for a discord id linked to an internal principal", async () => {
  installPrincipalLinks({
    canonical: (k: string) => ({ "discord:7": "ana@acme.com", "discord:8": "gone@acme.com" })[k],
    aliases: (k: string) => (k === "ana@acme.com" ? ["discord:7"] : []),
  });
  const core = createDiscordCoreClient({
    identity: identity(new Set(["ana@acme.com"])),
    runs: { onTerminal: () => {} },
  } as never);
  assert.equal(await core.linkedInternal("7"), true);
  assert.equal(await core.linkedInternal("8"), false);
  assert.equal(await core.linkedInternal("9"), false);
  assert.deepEqual(core.discordUserIdsFor("ana@acme.com"), ["7"]);
});

test("channelWatermarks asks the store for discord-shaped containers only and keeps those with a last id", async () => {
  const asked: unknown[] = [];
  const core = createDiscordCoreClient({
    app: {
      listSurfaceContainers: async (opts: unknown) => {
        asked.push(opts);
        return [
          { container: "1500000000000000001", lastTs: "1500000000000000009" },
          { container: "1500000000000000002" },
        ];
      },
    },
    runs: { onTerminal: () => {} },
  } as never);
  assert.deepEqual(await core.channelWatermarks(), [
    { container: "1500000000000000001", lastTs: "1500000000000000009" },
  ]);
  assert.equal((asked[0] as { surface: string }).surface, "discord");
});

test("a history gap is captured as a note in the channel's memory scope", async () => {
  const captured: unknown[][] = [];
  const core = createDiscordCoreClient({
    memory: { capture: async (...args: unknown[]) => void captured.push(args) },
    runs: { onTerminal: () => {} },
  } as never);
  await core.noteSurfaceHistoryGap("1500000000000000001", "gap note");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]![0], "channel:1500000000000000001");
  assert.deepEqual(captured[0]![1], ["gap note"]);
});
