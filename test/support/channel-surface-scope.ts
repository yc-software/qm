import assert from "node:assert/strict";
import type { DirectoryStore } from "../../src/directory/directory-store.ts";

const D1 = "100000000000000101";
const D2 = "100000000000000102";

const ids = async (store: DirectoryStore) => (await store.listChannels()).map((c) => c.channelId).sort();

export async function assertSurfaceScopedFullSyncs(store: DirectoryStore): Promise<void> {
  const t = Date.now();
  await store.replaceChannels(
    [{ channelId: "C-eng", name: "eng" }],
    [{ channelId: "C-eng", principalId: "U1" }],
    t + 1,
  );
  assert.equal(
    await store.replaceDiscordChannels(
      [{ channelId: D1, name: "ops", isPrivate: true }],
      [{ channelId: D1, principalId: "discord:1" }],
      t + 2,
    ),
    true,
  );
  assert.deepEqual(await ids(store), ["C-eng", D1].sort());
  assert.deepEqual(await store.channelMemberIds("C-eng"), ["U1"]);
  assert.deepEqual(await store.channelMemberIds(D1), ["discord:1"]);

  await store.replaceChannels(
    [{ channelId: "C-eng", name: "eng" }],
    [{ channelId: "C-eng", principalId: "U1" }],
    t + 3,
  );
  assert.deepEqual(await ids(store), ["C-eng", D1].sort());
  assert.deepEqual(await store.channelMemberIds(D1), ["discord:1"]);

  assert.equal(
    await store.replaceChannels(
      [{ channelId: "C-eng", name: "eng" }],
      [{ channelId: "C-eng", principalId: "U1" }],
      t + 10,
      ["C-eng"],
      [],
      true,
    ),
    true,
  );
  assert.equal(await store.replaceDiscordChannels([{ channelId: D2, name: "dev" }], [], t + 5), true);
  assert.deepEqual(await ids(store), ["C-eng", D2].sort());
  assert.deepEqual(await store.channelMemberIds("C-eng"), ["U1"]);

  await store.replaceChannels([{ channelId: "C-devops", name: "devops" }], [], t + 11, undefined, [], true);
  const byName = await store.resolveChannel("dev");
  assert.equal(byName.kind, "ambiguous");
  if (byName.kind === "ambiguous") assert.deepEqual(byName.candidates.map((c) => c.channelId).sort(), [D2, "C-devops"]);
  const byId = await store.resolveChannel(D2);
  assert.equal(byId.kind === "one" && byId.channel.name, "dev");

  const u = t + 1_000;
  const eng = [{ channelId: "C-eng", name: "eng" }];
  const engMembers = [{ channelId: "C-eng", principalId: "U1" }];
  assert.equal(await store.replaceChannels(eng, engMembers, u), true);
  assert.equal(await store.replaceDiscordChannels([{ channelId: D2, name: "dev" }], [], u + 50), true);
  assert.equal(
    await store.replaceChannels(eng, engMembers, u + 1),
    true,
    "a Discord push must not refuse a Slack full",
  );
  assert.equal(
    await store.replaceChannels(eng, engMembers, u + 20, ["C-eng"], [], true),
    true,
    "a Discord push must not refuse a Slack partial",
  );
  assert.equal(await store.replaceDiscordChannels([], [], u + 60), true);
  assert.deepEqual(await ids(store), ["C-eng"]);

  const v = t + 5_000;
  await store.replaceChannels([{ channelId: "C-eng", name: "eng" }], [], v);
  await store.replaceDiscordChannels([{ channelId: D1, name: "ops" }], [], v);
  await store.replaceDiscordChannels(
    [
      { channelId: "C-stray", name: "stray" },
      { channelId: D2, name: "dev" },
    ],
    [],
    v + 1,
  );
  assert.deepEqual(await ids(store), ["C-eng", D2].sort());
  await store.replaceChannels(
    [
      { channelId: D1, name: "stray-discord" },
      { channelId: "C-eng", name: "eng" },
    ],
    [],
    v + 2,
  );
  assert.deepEqual(await ids(store), ["C-eng", D2].sort());
}
