import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { directoryFor, type DirectoryStore } from "../src/directory/directory-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenant } from "./support/test-tenant.ts";

describe("directory resolution (agent → teammate addressing, §10)", () => {
  const dir = async (): Promise<DirectoryStore> => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replace(testTenant, [
      { principalId: "U-alice", displayName: "Alice Example", type: "internal" },
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-sam1", displayName: "Sam Lee", type: "internal" },
      { principalId: "U-sam2", displayName: "Sam Park", type: "internal" },
      { principalId: "U-guest", displayName: "Gwen Guest", type: "guest" },
    ]);
    return d;
  };

  it("resolves a unique display-name prefix to one principal", async () => {
    const r = await (await dir()).resolve(testTenant, "Alice");
    assert.equal(r.kind, "one");
    if (r.kind === "one") assert.equal(r.member.principalId, "U-alice");
  });

  it("matches case-insensitively and tolerates a leading @", async () => {
    const r = await (await dir()).resolve(testTenant, "@carol");
    assert.equal(r.kind, "one");
    if (r.kind === "one") assert.equal(r.member.principalId, "U-carol");
  });

  it("resolves an exact principal id outright", async () => {
    const r = await (await dir()).resolve(testTenant, "U-alice");
    assert.equal(r.kind, "one");
    if (r.kind === "one") assert.equal(r.member.principalId, "U-alice");
  });

  it("reports ambiguity with candidates when a name matches several", async () => {
    const r = await (await dir()).resolve(testTenant, "Sam");
    assert.equal(r.kind, "ambiguous");
    if (r.kind === "ambiguous") {
      assert.equal(r.candidates.length, 2);
      assert.deepEqual(r.candidates.map((c) => c.principalId).sort(), ["U-sam1", "U-sam2"]);
    }
  });

  it("returns none for an unknown name or an empty/unknown org", async () => {
    const d = await dir();
    assert.equal((await d.resolve(testTenant, "Nobody")).kind, "none");
    assert.equal((await d.resolve(testTenant, "   ")).kind, "none");
  });

  it("never resolves a non-internal principal (guests are unaddressable, G1)", async () => {
    const d = await dir();
    assert.equal((await d.resolve(testTenant, "Gwen")).kind, "none");
    assert.equal((await d.resolve(testTenant, "U-guest")).kind, "none");
    assert.equal(await d.get(testTenant, "U-guest"), null);
  });

  it("replace() is a full swap of the org roster", async () => {
    const d = await dir();
    await d.replace(testTenant, [{ principalId: "U-new", displayName: "New Person", type: "internal" }]);
    assert.equal((await d.resolve(testTenant, "Alice")).kind, "none");
    assert.equal((await d.list(testTenant)).length, 1);
  });
});

describe("channel resolution (agent → channel addressing, §10)", () => {
  const dir = async (): Promise<DirectoryStore> => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replaceChannels(testTenant, [
      { channelId: "C-eng", name: "eng" },
      { channelId: "C-engng", name: "engineering" },
      { channelId: "C-d1", name: "design-frontend" },
      { channelId: "C-d2", name: "design-backend" },
      { channelId: "C-secret", name: "secret", isPrivate: true },
    ]);
    return d;
  };

  it("resolves a channel by exact name (tolerating a leading #)", async () => {
    const r = await (await dir()).resolveChannel(testTenant, "#eng");
    assert.equal(r.kind, "one");
    if (r.kind === "one") assert.equal(r.channel.channelId, "C-eng");
  });

  it("resolves by channel id outright", async () => {
    const r = await (await dir()).resolveChannel(testTenant, "C-d1");
    assert.equal(r.kind, "one");
    if (r.kind === "one") assert.equal(r.channel.name, "design-frontend");
  });

  it("reports ambiguity on a shared prefix with no exact match", async () => {
    const r = await (await dir()).resolveChannel(testTenant, "design");
    assert.equal(r.kind, "ambiguous");
    if (r.kind === "ambiguous") assert.equal(r.candidates.length, 2);
  });

  it("carries isPrivate through (the cron route gates private on membership)", async () => {
    const r = await (await dir()).resolveChannel(testTenant, "secret");
    assert.equal(r.kind, "one");
    if (r.kind === "one") assert.equal(r.channel.isPrivate, true);
  });

  it("returns none for an unknown channel", async () => {
    assert.equal((await (await dir()).resolveChannel(testTenant, "nonexistent")).kind, "none");
  });
});

describe("member slackId (the real <@…> mention id for an email principal)", () => {
  it("round-trips slackId through replace → get → list, and resolve", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replace(testTenant, [
      {
        principalId: "eve@acme.com",
        displayName: "Eve",
        type: "internal",
        slackId: "U9",
        avatarUrl: "https://avatars.slack-edge.com/eve.png",
      },
      { principalId: "U5", displayName: "Dana", type: "internal" },
    ]);
    assert.equal((await d.get(testTenant, "eve@acme.com"))?.slackId, "U9");
    assert.equal((await d.get(testTenant, "eve@acme.com"))?.avatarUrl, "https://avatars.slack-edge.com/eve.png");
    assert.equal((await d.get(testTenant, "U5"))?.slackId, undefined);
    assert.equal((await d.list(testTenant)).find((m) => m.principalId === "eve@acme.com")?.slackId, "U9");
    assert.equal((await d.getBySlackId(testTenant, "U9"))?.principalId, "eve@acme.com");
    assert.equal((await d.getBySlackId(testTenant, "U5"))?.principalId, "U5");
    assert.equal(await d.getBySlackId(testTenant, "Eve"), null);
    const r = await d.resolve(testTenant, "Eve");
    assert.equal(r.kind === "one" && r.member.slackId, "U9");
  });
});

describe("group-DM (mpim) membership (addressed by participant set, §10)", () => {
  const dir = async (): Promise<DirectoryStore> => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replace(testTenant, [
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-sam", displayName: "Sam", type: "internal" },
    ]);
    await d.replaceGroups(testTenant, [
      { groupId: "G-1", principalId: "U-alice" },
      { groupId: "G-1", principalId: "U-carol" },
      { groupId: "G-1", principalId: "U-sam" },
      { groupId: "G-2", principalId: "U-alice" },
      { groupId: "G-2", principalId: "U-carol" },
    ]);
    return d;
  };

  it("resolves a participant SET (order- and duplicate-insensitive) to its group id", async () => {
    const d = await dir();
    const r = await d.resolveGroupByParticipants(testTenant, ["U-sam", "U-alice", "U-carol", "U-alice"]);
    assert.equal(r.kind, "one");
    if (r.kind === "one") assert.equal(r.groupId, "G-1");
  });

  it("requires an exact set — a subset or superset is a different conversation", async () => {
    const d = await dir();
    assert.equal((await d.resolveGroupByParticipants(testTenant, ["U-alice", "U-carol"])).kind === "one", true);
    assert.equal(
      (await d.resolveGroupByParticipants(testTenant, ["U-alice", "U-carol", "U-sam", "U-extra"])).kind,
      "none",
    );
    assert.equal((await d.resolveGroupByParticipants(testTenant, ["U-alice"])).kind, "none");
    assert.equal((await d.resolveGroupByParticipants(testTenant, [])).kind, "none");
  });

  it("groupMember reflects pushed membership (the parity gate)", async () => {
    const d = await dir();
    assert.equal(await d.groupMember(testTenant, "G-1", "U-sam"), true);
    assert.equal(await d.groupMember(testTenant, "G-2", "U-sam"), false);
    assert.equal(await d.groupMember(testTenant, "G-unknown", "U-alice"), false);
    assert.deepEqual(await d.listGroupsFor(testTenant, "U-sam"), ["G-1"]);
    assert.deepEqual(
      (await d.conversationMembers(testTenant, "group", "G-1"))?.map((member) => member.principalId).sort(),
      ["U-alice", "U-carol", "U-sam"],
    );
    assert.equal(await d.groupMembership(testTenant, "G-2", "U-sam"), false);
  });

  it("distinguishes an unavailable group roster from a definitive nonmember", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    assert.equal(await d.groupMembership(testTenant, "G-1", "U-alice"), undefined);
    assert.equal(await d.conversationMembers(testTenant, "group", "G-1"), undefined);
    await d.replaceGroups(testTenant, []);
    assert.equal(await d.groupMembership(testTenant, "G-1", "U-alice"), false);
  });

  it("a single registered group neither marks the org synced nor fences out the next full sync", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.upsertGroup("G-1", ["U-alice"]);
    assert.equal(await d.groupMembership("G-1", "U-alice"), true);
    assert.equal(await d.groupMembership("G-2", "U-alice"), undefined);
    assert.equal(await d.replaceGroups([{ groupId: "G-2", principalId: "U-alice" }], Date.now() - 60_000), true);
    assert.equal(await d.groupMembership("G-2", "U-alice"), true);
  });

  it("replaceGroups is a full per-org swap", async () => {
    const d = await dir();
    await d.replaceGroups(testTenant, [{ groupId: "G-3", principalId: "U-alice" }]);
    assert.equal(await d.groupMember(testTenant, "G-1", "U-alice"), false);
    assert.equal((await d.resolveGroupByParticipants(testTenant, ["U-alice", "U-carol", "U-sam"])).kind, "none");
    assert.equal((await d.resolveGroupByParticipants(testTenant, ["U-alice"])).kind, "one");
  });

  it("a swap stamped older than the stored snapshot is refused, so a stale instance cannot clobber a fresh sync", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    assert.equal(await d.replaceGroups(testTenant, [{ groupId: "G-new", principalId: "U-alice" }], 2000), true);
    assert.equal(await d.replaceGroups(testTenant, [], 1000), false);
    assert.equal(await d.groupMember(testTenant, "G-new", "U-alice"), true);
    assert.equal(await d.replaceGroups(testTenant, [], 3000), true);
    assert.equal(await d.groupMember(testTenant, "G-new", "U-alice"), false);
  });

  it("an unstamped swap keeps today's last-write-wins behaviour", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replaceGroups(testTenant, [{ groupId: "G-new", principalId: "U-alice" }], 2000);
    assert.equal(await d.replaceGroups(testTenant, [], undefined), true);
    assert.equal(await d.groupMember(testTenant, "G-new", "U-alice"), false);
  });

  it("partially replaces only group rosters known by the source", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replaceGroups(
      testTenant,
      [
        { groupId: "G-one", principalId: "U-old-one" },
        { groupId: "G-two", principalId: "U-old-two" },
      ],
      undefined,
      ["G-one", "G-two"],
      ["G-one", "G-two"],
    );
    await d.replaceGroups(
      testTenant,
      [{ groupId: "G-two", principalId: "U-new-two" }],
      undefined,
      ["G-one", "G-two", "G-new"],
      ["G-two"],
    );
    assert.equal(await d.groupMembership(testTenant, "G-one", "U-old-one"), true);
    assert.equal(await d.groupMembership(testTenant, "G-two", "U-old-two"), false);
    assert.equal(await d.groupMembership(testTenant, "G-two", "U-new-two"), true);
    assert.equal(await d.groupMembership(testTenant, "G-new", "U-new"), undefined);
  });

  it("members and channels swaps are stale-guarded the same way", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    assert.equal(
      await d.replace(testTenant, [{ principalId: "U-new", displayName: "New", type: "internal" }], 2000),
      true,
    );
    assert.equal(await d.replace(testTenant, [], 1000), false);
    assert.equal((await d.list(testTenant)).length, 1);
    assert.equal(await d.replaceChannels(testTenant, [{ channelId: "C-1", name: "eng" }], undefined, 2000), true);
    assert.equal(await d.replaceChannels(testTenant, [], undefined, 1000), false);
    assert.equal((await d.listChannels(testTenant)).length, 1);
  });
});

describe("private-channel membership (authorizes private-channel sends, §10)", () => {
  it("channelMember reflects pushed membership; omitting it leaves it intact; providing it is a full swap", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replace(testTenant, [
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
    ]);
    await d.replaceChannels(
      testTenant,
      [{ channelId: "C-sec", name: "secret", isPrivate: true }],
      [{ channelId: "C-sec", principalId: "U-carol" }],
    );
    assert.equal(await d.channelMember(testTenant, "C-sec", "U-carol"), true);
    assert.equal(await d.channelMembership(testTenant, "C-sec", "U-carol"), true);
    assert.equal(await d.channelMembership(testTenant, "C-sec", "U-alice"), false);
    assert.equal(await d.channelMember(testTenant, "C-sec", "U-alice"), false);
    assert.equal(await d.channelMember(testTenant, "C-other", "U-carol"), false);
    assert.deepEqual(
      (await d.conversationMembers(testTenant, "channel", "C-sec"))?.map((member) => member.principalId),
      ["U-carol"],
    );

    await d.replaceChannels(testTenant, [{ channelId: "C-sec", name: "secret", isPrivate: true }]);
    assert.equal(await d.channelMember(testTenant, "C-sec", "U-carol"), true);

    await d.replaceChannels(
      testTenant,
      [{ channelId: "C-sec", name: "secret", isPrivate: true }],
      [{ channelId: "C-sec", principalId: "U-alice" }],
    );
    assert.equal(await d.channelMember(testTenant, "C-sec", "U-carol"), false);
    assert.equal(await d.channelMember(testTenant, "C-sec", "U-alice"), true);
  });

  it("uses definitive nonmembership only for private channels with a pushed roster", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    assert.equal(await d.channelMembership(testTenant, "C-sec", "U-alice"), undefined);
    await d.replaceChannels(
      testTenant,
      [
        { channelId: "C-public", name: "public" },
        { channelId: "C-sec", name: "secret", isPrivate: true },
      ],
      [],
    );
    assert.equal(await d.channelMembership(testTenant, "C-public", "U-alice"), undefined);
    assert.equal(await d.channelMembership(testTenant, "C-sec", "U-alice"), false);
    assert.equal(await d.conversationMembers(testTenant, "channel", "C-sec"), undefined);
    await d.replaceChannels(
      testTenant,
      [{ channelId: "C-external", name: "external", isExternal: true }],
      [{ channelId: "C-external", principalId: "U-alice" }],
    );
    assert.equal(await d.conversationMembers(testTenant, "channel", "C-external"), undefined);
  });

  it("partially replaces only the channel rosters known by the source", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    const channels = [
      { channelId: "C-one", name: "one", isPrivate: true },
      { channelId: "C-two", name: "two", isPrivate: true },
      { channelId: "C-new", name: "new", isPrivate: true },
    ];
    await d.replaceChannels(testTenant, channels.slice(0, 2), [
      { channelId: "C-one", principalId: "U-old-one" },
      { channelId: "C-two", principalId: "U-old-two" },
    ]);
    await d.replaceChannels(testTenant, channels, [{ channelId: "C-two", principalId: "U-new-two" }], undefined, [
      "C-two",
    ]);
    assert.equal(await d.channelMembership(testTenant, "C-one", "U-old-one"), true);
    assert.equal(await d.channelMembership(testTenant, "C-two", "U-old-two"), false);
    assert.equal(await d.channelMembership(testTenant, "C-two", "U-new-two"), true);
    assert.equal(await d.channelMembership(testTenant, "C-new", "U-new"), undefined);
  });

  it("applies removals without clearing a failed channel refresh", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replaceChannels(
      testTenant,
      [{ channelId: "C-one", name: "one", isPrivate: true }],
      [
        { channelId: "C-one", principalId: "U-leaving" },
        { channelId: "C-one", principalId: "U-keep" },
      ],
    );
    await d.replaceChannels(
      testTenant,
      [{ channelId: "C-one", name: "one", isPrivate: true }],
      [],
      undefined,
      [],
      [{ channelId: "C-one", principalId: "U-leaving" }],
    );
    assert.equal(await d.channelMembership(testTenant, "C-one", "U-leaving"), false);
    assert.equal(await d.channelMembership(testTenant, "C-one", "U-keep"), true);
  });

  it("treats a private Slack Connect room like any private room for its own members", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replaceChannels(
      testTenant,
      [{ channelId: "C-connect", name: "connect", isPrivate: true, isExternal: true }],
      [{ channelId: "C-connect", principalId: "U-member" }],
    );
    assert.equal(await d.channelMembership(testTenant, "C-connect", "U-member"), true);
    assert.equal(await d.channelMember(testTenant, "C-connect", "U-member"), true);
    assert.equal(await d.channelMember(testTenant, "C-connect", "U-other"), false);
    assert.deepEqual(
      (await d.listChannelsFor(testTenant, "U-member")).map((c) => c.channelId),
      ["C-connect"],
    );
    assert.equal(await d.conversationMembers(testTenant, "channel", "C-connect"), undefined);
  });

  it("partially replaces only the channel rosters known by the source", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    const channels = [
      { channelId: "C-one", name: "one", isPrivate: true },
      { channelId: "C-two", name: "two", isPrivate: true },
      { channelId: "C-new", name: "new", isPrivate: true },
    ];
    await d.replaceChannels(testTenant, channels.slice(0, 2), [
      { channelId: "C-one", principalId: "U-old-one" },
      { channelId: "C-two", principalId: "U-old-two" },
    ]);
    await d.replaceChannels(testTenant, channels, [{ channelId: "C-two", principalId: "U-new-two" }], undefined, [
      "C-two",
    ]);
    assert.equal(await d.channelMembership(testTenant, "C-one", "U-old-one"), true);
    assert.equal(await d.channelMembership(testTenant, "C-two", "U-old-two"), false);
    assert.equal(await d.channelMembership(testTenant, "C-two", "U-new-two"), true);
    assert.equal(await d.channelMembership(testTenant, "C-new", "U-new"), undefined);
  });

  it("applies removals without clearing a failed channel refresh", async () => {
    const d = createPostgresDirectoryStore(testDatabaseUrl());
    await d.replaceChannels(
      testTenant,
      [{ channelId: "C-one", name: "one", isPrivate: true }],
      [
        { channelId: "C-one", principalId: "U-leaving" },
        { channelId: "C-one", principalId: "U-keep" },
      ],
    );
    await d.replaceChannels(
      testTenant,
      [{ channelId: "C-one", name: "one", isPrivate: true }],
      [],
      undefined,
      [],
      [{ channelId: "C-one", principalId: "U-leaving" }],
    );
    assert.equal(await d.channelMembership(testTenant, "C-one", "U-leaving"), false);
    assert.equal(await d.channelMembership(testTenant, "C-one", "U-keep"), true);
  });
});

it("live channel observations survive older snapshots but yield to later removal", async () => {
  const { directoryObservationCases } = await import("./support/directory-observation-cases.ts");
  await directoryObservationCases(directoryFor(createPostgresDirectoryStore(testDatabaseUrl()), testTenant));
});
