import { directoryFor } from "../src/directory/directory-store.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testTenant } from "./support/test-tenant.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres directory-store tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query(
    "DROP TABLE IF EXISTS directory_members, directory_channels, directory_channel_members, directory_groups, directory_group_members, directory_sync, directory_meta CASCADE",
  );
  await p.end();
});

const seed = async (store: ReturnType<typeof createPostgresDirectoryStore>) => {
  await store.replace(testTenant, [
    { principalId: "U-alice", displayName: "Alice Example", type: "internal" },
    { principalId: "U-carol", displayName: "Carol", type: "internal" },
    { principalId: "U-sam1", displayName: "Sam Lee", type: "internal" },
    { principalId: "U-sam2", displayName: "Sam Park", type: "internal" },
    { principalId: "U-guest", displayName: "Gwen Guest", type: "guest" },
  ]);
  await store.replaceChannels(testTenant, [
    { channelId: "C-eng", name: "eng" },
    { channelId: "C-engng", name: "engineering" },
    { channelId: "C-d1", name: "design-frontend" },
    { channelId: "C-d2", name: "design-backend" },
    { channelId: "C-secret", name: "secret", isPrivate: true },
  ]);
};

test(
  "pg directory: indexed resolve — exact id, prefix, ambiguity, none; guests unaddressable (G1)",
  { skip },
  async () => {
    const store = createPostgresDirectoryStore(URL!);
    await seed(store);

    const exactId = await store.resolve(testTenant, "U-alice");
    assert.equal(exactId.kind, "one");
    if (exactId.kind === "one") assert.equal(exactId.member.principalId, "U-alice");

    const prefix = await store.resolve(testTenant, "Alice");
    assert.equal(prefix.kind, "one");
    if (prefix.kind === "one") assert.equal(prefix.member.principalId, "U-alice");

    const atHandle = await store.resolve(testTenant, "@carol");
    assert.equal(atHandle.kind, "one");
    if (atHandle.kind === "one") assert.equal(atHandle.member.principalId, "U-carol");

    const amb = await store.resolve(testTenant, "Sam");
    assert.equal(amb.kind, "ambiguous");
    if (amb.kind === "ambiguous") {
      assert.deepEqual(amb.candidates.map((c) => c.principalId).sort(), ["U-sam1", "U-sam2"]);
    }

    assert.equal((await store.resolve(testTenant, "Nobody")).kind, "none");
    assert.equal((await store.resolve(testTenant, "   ")).kind, "none");

    assert.equal((await store.resolve(testTenant, "Gwen")).kind, "none");
    assert.equal((await store.resolve(testTenant, "U-guest")).kind, "none");
    assert.equal(await store.get(testTenant, "U-guest"), null);
    assert.equal((await store.get(testTenant, "U-alice"))?.displayName, "Alice Example");
    assert.equal((await store.list(testTenant)).length, 4);
  },
);

test("pg directory: exact channel-id resolution has a matching expression index", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);
  await seed(store);
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const result = await raw.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'directory_channels_lower_cid'");
    assert.match(result.rows[0]?.indexdef ?? "", /\(org_id, lower\(channel_id\)\)/);
  } finally {
    await raw.end();
  }
});

test("pg directory: slackId round-trips through replace → get/list/resolve; a change re-writes", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);
  await store.replace(testTenant, [
    {
      principalId: "eve@acme.com",
      displayName: "Eve",
      type: "internal",
      slackId: "U9",
      avatarUrl: "https://avatars.slack-edge.com/eve.png",
    },
    { principalId: "U5", displayName: "Dana", type: "internal" },
  ]);
  assert.equal((await store.get(testTenant, "eve@acme.com"))?.slackId, "U9");
  assert.equal((await store.get(testTenant, "eve@acme.com"))?.avatarUrl, "https://avatars.slack-edge.com/eve.png");
  assert.equal((await store.get(testTenant, "U5"))?.slackId, undefined);
  assert.equal((await store.list(testTenant)).find((m) => m.principalId === "eve@acme.com")?.slackId, "U9");
  assert.equal((await store.getBySlackId(testTenant, "U9"))?.principalId, "eve@acme.com");
  assert.equal((await store.getBySlackId(testTenant, "U5"))?.principalId, "U5");
  assert.equal(await store.getBySlackId(testTenant, "Eve"), null);
  const r = await store.resolve(testTenant, "Eve");
  assert.equal(r.kind === "one" && r.member.slackId, "U9");

  await store.replace(testTenant, [
    { principalId: "eve@acme.com", displayName: "Eve", type: "internal", slackId: "U99" },
    { principalId: "U5", displayName: "Dana", type: "internal" },
  ]);
  assert.equal((await store.get(testTenant, "eve@acme.com"))?.slackId, "U99");
});

test("pg directory: get folds email case in BOTH directions; non-email ids stay byte-exact", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);
  await store.replace(testTenant, [
    { principalId: "Eve@Acme.com", displayName: "Eve", type: "internal", slackId: "U9" },
    { principalId: "U5", displayName: "Morgan", type: "internal" },
  ]);
  assert.equal(
    (await store.get(testTenant, "eve@acme.com"))?.principalId,
    "Eve@Acme.com",
    "a canonical query finds a non-canonically STORED row",
  );
  assert.equal((await store.get(testTenant, "EVE@Acme.COM"))?.principalId, "Eve@Acme.com");
  assert.equal((await store.get(testTenant, "Eve@Acme.com"))?.principalId, "Eve@Acme.com");
  assert.equal(await store.get(testTenant, "u5"), null, "a non-email id never folds");
  assert.equal((await store.get(testTenant, "U5"))?.displayName, "Morgan");
});

test("pg directory: channel resolve carries isPrivate; exact name and id, ambiguity, none", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);
  await seed(store);

  const byName = await store.resolveChannel(testTenant, "#eng");
  assert.equal(byName.kind, "one");
  if (byName.kind === "one") assert.equal(byName.channel.channelId, "C-eng");

  const byId = await store.resolveChannel(testTenant, "C-d1");
  assert.equal(byId.kind, "one");
  if (byId.kind === "one") assert.equal(byId.channel.name, "design-frontend");

  const amb = await store.resolveChannel(testTenant, "design");
  assert.equal(amb.kind, "ambiguous");
  if (amb.kind === "ambiguous") assert.equal(amb.candidates.length, 2);

  const priv = await store.resolveChannel(testTenant, "secret");
  assert.equal(priv.kind, "one");
  if (priv.kind === "one") assert.equal(priv.channel.isPrivate, true);

  assert.equal((await store.resolveChannel(testTenant, "nonexistent")).kind, "none");
});

test("pg directory: replace is a full per-org swap and skips an unchanged roster", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);
  await store.replace(testTenant, [
    { principalId: "U-a", displayName: "Alice", type: "internal" },
    { principalId: "U-b", displayName: "Bob", type: "internal" },
  ]);
  assert.equal((await store.list(testTenant)).length, 2);

  const direct = (await freshPg(URL!)).query;
  const t0 = await direct("SELECT updated_at FROM directory_sync WHERE org_id = $1", ["default-org"]);
  await store.replace(testTenant, [
    { principalId: "U-b", displayName: "Bob", type: "internal" },
    { principalId: "U-a", displayName: "Alice", type: "internal" },
  ]);
  const t1 = await direct("SELECT updated_at FROM directory_sync WHERE org_id = $1", ["default-org"]);
  assert.equal(t0.rows[0]?.updated_at, t1.rows[0]?.updated_at, "unchanged roster must not rewrite directory_sync");
  assert.equal((await store.list(testTenant)).length, 2);

  await store.replace(testTenant, [{ principalId: "U-c", displayName: "Carol", type: "internal" }]);
  assert.equal((await store.list(testTenant)).length, 1);
  assert.equal((await store.resolve(testTenant, "Alice")).kind, "none");
});

test(
  "pg directory: channelMember reflects pushed membership; omit keeps it; a membership change re-writes",
  { skip },
  async () => {
    const store = createPostgresDirectoryStore(URL!);
    await store.replace(testTenant, [
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
    ]);
    await store.replaceChannels(
      testTenant,
      [{ channelId: "C-sec", name: "secret", isPrivate: true }],
      [{ channelId: "C-sec", principalId: "U-carol" }],
    );
    assert.equal(await store.channelMember(testTenant, "C-sec", "U-carol"), true);
    assert.equal(await store.channelMembership(testTenant, "C-sec", "U-carol"), true);
    assert.equal(await store.channelMembership(testTenant, "C-sec", "U-alice"), false);
    assert.equal(await store.channelMember(testTenant, "C-sec", "U-alice"), false);
    assert.equal(await store.channelMember(testTenant, "C-other", "U-carol"), false);
    assert.deepEqual(
      (await store.conversationMembers(testTenant, "channel", "C-sec"))?.map((member) => member.principalId),
      ["U-carol"],
    );

    await store.replaceChannels(testTenant, [{ channelId: "C-sec", name: "secret", isPrivate: true }]);
    assert.equal(await store.channelMember(testTenant, "C-sec", "U-carol"), true);

    await store.replaceChannels(
      testTenant,
      [{ channelId: "C-sec", name: "secret", isPrivate: true }],
      [{ channelId: "C-sec", principalId: "U-alice" }],
    );
    assert.equal(await store.channelMember(testTenant, "C-sec", "U-carol"), false);
    assert.equal(await store.channelMember(testTenant, "C-sec", "U-alice"), true);

    await store.replaceChannels(
      testTenant,
      [{ channelId: "C-sec", name: "secret", isPrivate: true }],
      [{ channelId: "C-sec", principalId: "U-alice" }],
    );
    assert.equal(await store.channelMember(testTenant, "C-sec", "U-alice"), true);
  },
);

test("pg directory: private nonmembership is definitive only after a membership-bearing push", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);
  await store.replaceChannels(testTenant, [{ channelId: "C-privdef", name: "secret", isPrivate: true }]);
  assert.equal(await store.channelMembership(testTenant, "C-privdef", "U-alice"), undefined);
  await store.replaceChannels(testTenant, [{ channelId: "C-privdef", name: "secret", isPrivate: true }], []);
  assert.equal(await store.channelMembership(testTenant, "C-privdef", "U-alice"), false);
});

test(
  "pg directory: group-DM resolve-by-set + membership gate; a change re-writes, identical skips",
  { skip },
  async () => {
    const store = createPostgresDirectoryStore(URL!);
    await store.replace(testTenant, [
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-sam", displayName: "Sam", type: "internal" },
    ]);
    await store.replaceGroups(testTenant, [
      { groupId: "G-1", principalId: "U-alice" },
      { groupId: "G-1", principalId: "U-carol" },
      { groupId: "G-1", principalId: "U-sam" },
      { groupId: "G-2", principalId: "U-alice" },
      { groupId: "G-2", principalId: "U-carol" },
    ]);

    const r = await store.resolveGroupByParticipants(testTenant, ["U-sam", "U-alice", "U-carol", "U-alice"]);
    assert.equal(r.kind, "one");
    if (r.kind === "one") assert.equal(r.groupId, "G-1");
    assert.equal((await store.resolveGroupByParticipants(testTenant, ["U-alice", "U-carol"])).kind, "one");
    assert.equal((await store.resolveGroupByParticipants(testTenant, ["U-alice", "U-carol", "U-extra"])).kind, "none");
    assert.equal((await store.resolveGroupByParticipants(testTenant, [])).kind, "none");

    assert.equal(await store.groupMember(testTenant, "G-1", "U-sam"), true);
    assert.equal(await store.groupMember(testTenant, "G-2", "U-sam"), false);
    assert.equal(await store.groupMembership(testTenant, "G-2", "U-sam"), false);
    assert.deepEqual(
      (await store.conversationMembers(testTenant, "group", "G-1"))?.map((member) => member.principalId),
      ["U-alice", "U-carol", "U-sam"],
    );
    assert.deepEqual(await store.listGroupsFor(testTenant, "U-sam"), ["G-1"]);

    const direct = (await freshPg(URL!)).query;
    const t0 = await direct("SELECT groups_hash FROM directory_sync WHERE org_id = $1", ["default-org"]);
    await store.replaceGroups(testTenant, [
      { groupId: "G-2", principalId: "U-carol" },
      { groupId: "G-2", principalId: "U-alice" },
      { groupId: "G-1", principalId: "U-sam" },
      { groupId: "G-1", principalId: "U-alice" },
      { groupId: "G-1", principalId: "U-carol" },
    ]);
    const t1 = await direct("SELECT groups_hash FROM directory_sync WHERE org_id = $1", ["default-org"]);
    assert.equal(t0.rows[0]?.groups_hash, t1.rows[0]?.groups_hash, "identical set must not rewrite the hash");
    assert.equal(await store.groupMember(testTenant, "G-1", "U-sam"), true);

    await store.replaceGroups(testTenant, [{ groupId: "G-3", principalId: "U-alice" }]);
    assert.equal(await store.groupMember(testTenant, "G-1", "U-sam"), false);
    assert.equal((await store.resolveGroupByParticipants(testTenant, ["U-alice", "U-carol", "U-sam"])).kind, "none");
    assert.equal((await store.resolveGroupByParticipants(testTenant, ["U-alice"])).kind, "one");
  },
);

test(
  "pg directory: listChannelsFor returns public ∪ private-member, ordered by name (§10 reach roster)",
  { skip },
  async () => {
    const store = createPostgresDirectoryStore(URL!);
    await store.replaceChannels(
      testTenant,
      [
        { channelId: "C-pub", name: "general" },
        { channelId: "C-mine", name: "mine", isPrivate: true },
        { channelId: "C-theirs", name: "theirs", isPrivate: true },
      ],
      [
        { channelId: "C-mine", principalId: "U1" },
        { channelId: "C-theirs", principalId: "U2" },
      ],
    );
    assert.deepEqual(
      (await store.listChannelsFor(testTenant, "U1")).map((c) => c.name),
      ["general", "mine"],
    );
    assert.deepEqual(
      (await store.listChannelsFor(testTenant, "U2")).map((c) => c.name),
      ["general", "theirs"],
    );
  },
);

test(
  "pg directory: a second store instance reads what the first wrote (multi-instance consistency)",
  { skip },
  async () => {
    const writer = createPostgresDirectoryStore(URL!);
    await writer.replace(testTenant, [{ principalId: "U-cross", displayName: "Cross Instance", type: "internal" }]);
    const reader = createPostgresDirectoryStore(URL!);
    const r = await reader.resolve(testTenant, "Cross");
    assert.equal(r.kind, "one");
    if (r.kind === "one") assert.equal(r.member.principalId, "U-cross");
  },
);

async function freshPg(url: string) {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: url });
  return { query: (text: string, params?: unknown[]) => p.query(text, params) };
}

test("pg directory: concurrent pushes for one org serialize instead of 500ing on the PK", { skip }, async () => {
  const stores = Array.from({ length: 6 }, () => createPostgresDirectoryStore(URL!));

  await Promise.all(
    stores.map((store, i) =>
      store.replace(testTenant, [
        { principalId: "U-shared", displayName: `Shared v${i}`, type: "internal" },
        { principalId: `U-${i}`, displayName: `Member ${i}`, type: "internal" },
      ]),
    ),
  );

  const members = await stores[0]!.list(testTenant);
  assert.equal(members.length, 2, "final state is exactly one whole roster, not an interleaving");
  const shared = members.find((m) => m.principalId === "U-shared");
  const other = members.find((m) => m.principalId !== "U-shared");
  assert.ok(shared && other);
  assert.equal(shared!.displayName, `Shared v${other!.principalId.slice(2)}`, "both rows come from the same push");

  await Promise.all(
    stores.map((store, i) =>
      store.replaceChannels(
        testTenant,
        [{ channelId: "C-shared", name: `chan-v${i}` }],
        [{ channelId: "C-shared", principalId: "U-shared" }],
      ),
    ),
  );
  assert.equal(await stores[0]!.channelMember(testTenant, "C-shared", "U-shared"), true);
});

test("pg directory: workspace URL survives roster swaps and reads back per org", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);

  assert.deepEqual(await store.meta(testTenant), { workspaceUrl: null });
  await store.setWorkspaceUrl(testTenant, "https://acme.slack.com");
  assert.deepEqual(await store.meta(testTenant), { workspaceUrl: "https://acme.slack.com" });

  await seed(store);
  assert.deepEqual(await store.meta(testTenant), { workspaceUrl: "https://acme.slack.com" });

  await store.setWorkspaceUrl(testTenant, "https://acme2.slack.com");
  assert.deepEqual(await store.meta(testTenant), { workspaceUrl: "https://acme2.slack.com" });
});

test("pg directory: a swap stamped older than the stored snapshot is refused", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);

  assert.equal(await store.replaceGroups(testTenant, [{ groupId: "G-fresh", principalId: "U-alice" }], 2000), true);
  assert.equal(
    await store.replaceGroups(testTenant, [], 1000),
    false,
    "a stale instance's swap must not clobber a fresh sync",
  );
  assert.equal(await store.groupMember(testTenant, "G-fresh", "U-alice"), true);
  assert.equal(await store.replaceGroups(testTenant, [], 3000), true);
  assert.equal(await store.groupMember(testTenant, "G-fresh", "U-alice"), false);

  assert.equal(
    await store.replace(testTenant, [{ principalId: "U-fresh", displayName: "Fresh", type: "internal" }], 2000),
    true,
  );
  assert.equal(await store.replace(testTenant, [], 1000), false);
  assert.notEqual(await store.get(testTenant, "U-fresh"), null);

  assert.equal(
    await store.replaceChannels(testTenant, [{ channelId: "C-fresh", name: "fresh" }], undefined, 2000),
    true,
  );
  assert.equal(await store.replaceChannels(testTenant, [], undefined, 1000), false);
  assert.equal(
    (await store.listChannels(testTenant)).some((c) => c.channelId === "C-fresh"),
    true,
  );

  assert.equal(
    await store.replaceChannels(testTenant, [], undefined, undefined),
    true,
    "an unstamped swap keeps last-write-wins",
  );
  assert.equal((await store.listChannels(testTenant)).length, 0);
});

test("pg directory: a partial roster swap preserves channels whose roster is unknown", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);
  const channels = [
    { channelId: "C-one", name: "one", isPrivate: true },
    { channelId: "C-two", name: "two", isPrivate: true },
    { channelId: "C-new", name: "new", isPrivate: true },
  ];
  await store.replaceChannels(testTenant, channels.slice(0, 2), [
    { channelId: "C-one", principalId: "U-old-one" },
    { channelId: "C-two", principalId: "U-old-two" },
  ]);
  await store.replaceChannels(testTenant, channels, [{ channelId: "C-two", principalId: "U-new-two" }], undefined, [
    "C-two",
  ]);
  assert.equal(await store.channelMembership(testTenant, "C-one", "U-old-one"), true);
  assert.equal(await store.channelMembership(testTenant, "C-two", "U-old-two"), false);
  assert.equal(await store.channelMembership(testTenant, "C-two", "U-new-two"), true);
  assert.equal(await store.channelMembership(testTenant, "C-new", "U-new"), undefined);
});

test("pg directory: removals apply without clearing a failed channel refresh", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);
  await store.replaceChannels(
    testTenant,
    [{ channelId: "C-one", name: "one", isPrivate: true }],
    [
      { channelId: "C-one", principalId: "U-leaving" },
      { channelId: "C-one", principalId: "U-keep" },
    ],
  );
  await store.replaceChannels(
    testTenant,
    [{ channelId: "C-one", name: "one", isPrivate: true }],
    [],
    undefined,
    [],
    [{ channelId: "C-one", principalId: "U-leaving" }],
  );
  assert.equal(await store.channelMembership(testTenant, "C-one", "U-leaving"), false);
  assert.equal(await store.channelMembership(testTenant, "C-one", "U-keep"), true);
});

test(
  "pg directory: a private Slack Connect roster counts our members but is never a complete audience",
  { skip },
  async () => {
    const store = createPostgresDirectoryStore(URL!);
    await store.replace(testTenant, [{ principalId: "U-member", displayName: "Member", type: "internal" }]);
    await store.replaceChannels(
      testTenant,
      [{ channelId: "C-connect", name: "connect", isPrivate: true, isExternal: true }],
      [{ channelId: "C-connect", principalId: "U-member" }],
    );
    assert.equal(await store.channelMembership(testTenant, "C-connect", "U-member"), true);
    assert.equal(await store.channelMember(testTenant, "C-connect", "U-member"), true);
    assert.equal(await store.channelMember(testTenant, "C-connect", "U-outsider"), false);
    assert.equal(await store.rosterCoversAudience(testTenant, "C-connect"), false);
    assert.equal(await store.conversationMembers(testTenant, "channel", "C-connect"), undefined);
    assert.deepEqual(
      (await store.listChannelsFor(testTenant, "U-member")).map((c) => c.channelId),
      ["C-connect"],
    );
  },
);

test("pg directory: a partial group swap preserves unknown rosters", { skip }, async () => {
  const store = createPostgresDirectoryStore(URL!);
  await store.replaceGroups(
    testTenant,
    [
      { groupId: "G-one", principalId: "U-old-one" },
      { groupId: "G-two", principalId: "U-old-two" },
    ],
    undefined,
    ["G-one", "G-two"],
    ["G-one", "G-two"],
  );
  await store.replaceGroups(
    testTenant,
    [{ groupId: "G-two", principalId: "U-new-two" }],
    undefined,
    ["G-one", "G-two", "G-new"],
    ["G-two"],
  );
  assert.equal(await store.groupMembership(testTenant, "G-one", "U-old-one"), true);
  assert.equal(await store.groupMembership(testTenant, "G-two", "U-old-two"), false);
  assert.equal(await store.groupMembership(testTenant, "G-two", "U-new-two"), true);
  assert.equal(await store.groupMembership(testTenant, "G-new", "U-new"), undefined);
});

test(
  "pg directory: an identical push still advances the stamp, so ordering survives content-idempotent pushes",
  { skip },
  async () => {
    const store = createPostgresDirectoryStore(URL!);
    const roster = [{ groupId: "G-idem", principalId: "U-alice" }];

    assert.equal(await store.replaceGroups(testTenant, roster, 12000), true);
    assert.equal(await store.replaceGroups(testTenant, roster, 13000), true);
    assert.equal(
      await store.replaceGroups(testTenant, [], 12500),
      false,
      "a swap older than the newest snapshot seen must lose",
    );
    assert.equal(await store.groupMember(testTenant, "G-idem", "U-alice"), true);
  },
);

test("pg live channel observations survive older snapshots but yield to later removal", { skip }, async () => {
  const { directoryObservationCases } = await import("./support/directory-observation-cases.ts");
  const store = createPostgresDirectoryStore(URL!);
  await store.replaceChannels(testTenant, [], [], Date.now());
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL! });
  await pool.query("UPDATE directory_sync SET channels_synced_at = NULL, channels_hash = NULL");
  await pool.end();
  await directoryObservationCases(directoryFor(store, testTenant));
});

test("pg directory: room membership follows a person's linked identities", { skip }, async () => {
  const { installPrincipalLinks } = await import("../src/directory/person.ts");
  const store = createPostgresDirectoryStore(URL!);
  await store.replaceChannels(
    testTenant,
    [{ channelId: "C-linked", name: "linked", isPrivate: true }],
    [{ channelId: "C-linked", principalId: "slack-person@example.com" }],
  );
  await store.replaceGroups(
    testTenant,
    [{ groupId: "G-linked", principalId: "slack-person@example.com" }],
    Date.now(),
    ["G-linked"],
  );
  assert.equal(await store.channelMembership(testTenant, "C-linked", "web-person"), false);
  installPrincipalLinks({
    canonical: (key) => (key === "slack-person@example.com" ? "web-person" : undefined),
    aliases: (key) => (key === "web-person" ? ["Slack-Person@Example.com"] : []),
  });
  try {
    assert.equal(await store.channelMembership(testTenant, "C-linked", "web-person"), true);
    assert.equal(await store.channelMember(testTenant, "C-linked", "web-person"), true);
    assert.equal(await store.groupMembership(testTenant, "G-linked", "web-person"), true);
    assert.equal(await store.groupMember(testTenant, "G-linked", "web-person"), true);
    assert.deepEqual(await store.listGroupsFor(testTenant, "web-person"), ["G-linked"]);
    assert.ok((await store.listChannelsFor(testTenant, "web-person")).some((c) => c.channelId === "C-linked"));
    assert.ok(!(await store.listChannelsFor(testTenant, "someone-else")).some((c) => c.channelId === "C-linked"));
    assert.equal(await store.channelMembership(testTenant, "C-linked", "slack-person@example.com"), true);
    assert.equal(await store.channelMembership(testTenant, "C-linked", "someone-else"), false);
  } finally {
    installPrincipalLinks(null);
  }
});
