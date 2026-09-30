import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { openGroupViaSurface, resolveReachTarget, type ReachDirectory } from "../src/reach/reach.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createDirectory } from "../src/slack/directory.ts";
import { createSurfaceContextFulfiller } from "../src/slack/surface-context.ts";
import type { SurfaceContextQuery, SurfaceContextResult } from "../src/types.ts";

const MEMBERS = [
  { principalId: "alice@acme.dev", displayName: "alice", type: "internal" as const },
  { principalId: "kai@acme.dev", displayName: "kai", type: "internal" as const },
  { principalId: "jo@acme.dev", displayName: "jo", type: "internal" as const },
  ...Array.from({ length: 9 }, (_, i) => ({
    principalId: `p${i}@acme.dev`,
    displayName: `p${i}`,
    type: "internal" as const,
  })),
];

function directory(
  opts: {
    groups?: Record<string, string[]>;
    open?: { groupId: string } | { error: string };
    unknownAuthor?: boolean;
  } = {},
): ReachDirectory & { registered: Array<{ groupId: string; participants: readonly string[] }>; opened: string[][] } {
  const groups = opts.groups ?? {};
  const registered: Array<{ groupId: string; participants: readonly string[] }> = [];
  const opened: string[][] = [];
  const key = (ids: Iterable<string>) => [...new Set([...ids].filter(Boolean))].sort().join(",");
  return {
    registered,
    opened,
    async resolveRecipient(query) {
      const q = query.trim().toLowerCase();
      const hits = MEMBERS.filter((m) => m.principalId.toLowerCase() === q || m.displayName.toLowerCase() === q);
      if (hits.length === 1) return { kind: "one", member: hits[0]! };
      if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
      return { kind: "none" };
    },
    async resolveChannel() {
      return { kind: "none" };
    },
    async channelMember() {
      return false;
    },
    async resolveGroup(participants) {
      const want = key(participants);
      const hit = Object.entries(groups).find(([, ids]) => key(ids) === want);
      return hit ? { kind: "one", groupId: hit[0] } : { kind: "none" };
    },
    async groupMember(groupId, principalId) {
      return (groups[groupId] ?? []).includes(principalId);
    },
    async directoryMember(principalId) {
      if (opts.unknownAuthor) return null;
      return MEMBERS.some((m) => m.principalId === principalId) ? { type: "internal" } : null;
    },
    ...(opts.open
      ? {
          openGroup: async (participants: readonly string[]) => {
            opened.push([...participants]);
            return opts.open!;
          },
        }
      : {}),
    async registerGroup(groupId, participants) {
      registered.push({ groupId, participants });
      groups[groupId] = [...participants];
    },
  };
}

const NEW_GROUP = { groupId: "C-mpim-new" };
const reach = (dir: ReachDirectory, participants: string[], author = "alice@acme.dev", mayOpenGroup = true) =>
  resolveReachTarget(dir, { participants }, author, ...(mayOpenGroup ? [{ mayOpenGroup }] : [])) as Promise<any>;

describe("reaching a group DM that the directory hasn't seen", () => {
  it("opens the group DM live, registers it, and addresses it by its real id", async () => {
    const dir = directory({ open: NEW_GROUP });
    const r = await reach(dir, ["kai@acme.dev"]);
    assert.equal(r.ok, true);
    assert.equal(r.destination.type, "group");
    assert.equal(r.destination.target, "C-mpim-new");
    assert.equal(r.destination.audienceScopeId, "group:C-mpim-new");
    assert.deepEqual(dir.opened, [["kai@acme.dev", "alice@acme.dev"]]);
    assert.deepEqual(dir.registered, [{ groupId: "C-mpim-new", participants: ["kai@acme.dev", "alice@acme.dev"] }]);
  });

  it("resolves participants named however the agent knows them", async () => {
    const dir = directory({ open: NEW_GROUP });
    assert.equal((await reach(dir, ["kai", "jo"])).ok, true);
    assert.deepEqual(dir.registered[0]?.participants, ["kai@acme.dev", "jo@acme.dev", "alice@acme.dev"]);
  });

  it("prefers a group the directory already knows and never opens a second one", async () => {
    const dir = directory({ groups: { "C-known": ["alice@acme.dev", "kai@acme.dev"] }, open: NEW_GROUP });
    assert.equal((await reach(dir, ["kai"])).destination.target, "C-known");
    assert.equal(dir.opened.length, 0);
  });

  it("names the person it can't find instead of blaming the group", async () => {
    const r = await reach(directory({ open: NEW_GROUP }), ["nobody"]);
    assert.equal(r.status, 404);
    assert.equal(r.error, "recipient_not_found");
    assert.match(r.message, /nobody/);
  });

  it("refuses to open anything for an author it can't place in the directory", async () => {
    const dir = directory({ unknownAuthor: true, open: NEW_GROUP });
    const r = await reach(dir, ["kai"], "stranger@example.com");
    assert.equal(r.status, 403);
    assert.equal(r.error, "identity_unverified");
    assert.equal(dir.opened.length, 0);
  });

  it("won't open a group DM that is really a 1:1, or one Slack can't hold", async () => {
    const self = await reach(directory({ open: NEW_GROUP }), ["alice"]);
    assert.equal(self.status, 400);
    assert.match(self.message, /recipient/);

    const crowd = directory({ open: NEW_GROUP });
    const many = await reach(
      crowd,
      Array.from({ length: 9 }, (_, i) => `p${i}`),
    );
    assert.equal(many.status, 400);
    assert.equal(many.error, "group_too_large");
    assert.equal(crowd.opened.length, 0);
  });

  it("relays what Slack said when the open fails", async () => {
    const r = await reach(directory({ open: { error: "kai is deactivated" } }), ["kai"]);
    assert.equal(r.status, 502);
    assert.equal(r.error, "group_open_failed");
    assert.match(r.message, /deactivated/);
  });

  it("opens nothing unless the caller is actually sending a message", async () => {
    const dir = directory({ open: NEW_GROUP });
    const r = await reach(dir, ["kai"], "alice@acme.dev", false);
    assert.equal(r.status, 404);
    assert.equal(r.error, "group_not_found");
    assert.match(r.message, /post to it once/);
    assert.equal(dir.opened.length, 0);
    assert.deepEqual(dir.registered, []);
  });

  it("still says group_not_found when the surface can't open one", async () => {
    const dir = directory();
    assert.equal("openGroup" in dir, false);
    const r = await reach(dir, ["kai"]);
    assert.equal(r.status, 404);
    assert.equal(r.error, "group_not_found");
  });
});

describe("openGroupViaSurface", () => {
  it("asks the surface to open the group and reads back its id", async () => {
    const seen: SurfaceContextQuery[] = [];
    const pull = async (query: SurfaceContextQuery): Promise<SurfaceContextResult | null> => {
      seen.push(query);
      return { messages: [], group: { groupId: "C-live" } };
    };
    assert.deepEqual(await openGroupViaSurface(pull, ["a", "b"]), { groupId: "C-live" });
    assert.deepEqual(seen[0]?.openGroup, { participants: ["a", "b"] });
  });

  it("carries a surface note back as the failure reason, and a silent surface as null", async () => {
    assert.deepEqual(await openGroupViaSurface(async () => ({ messages: [], note: "nope" }), ["a", "b"]), {
      error: "nope",
    });
    assert.equal(await openGroupViaSurface(async () => null, ["a", "b"]), null);
  });
});

describe("the Slack surface opening a group DM", () => {
  function fulfiller(open: (args: { users: string }) => Promise<unknown>, syncs: string[] = []) {
    const fulfilled: Array<{ id: string; outcome: unknown }> = [];
    const core = {
      fulfillContextRequest: async (id: string, outcome: unknown) => void fulfilled.push({ id, outcome }),
    };
    const directory = {
      forceDirectorySync: async () => void syncs.push("sync"),
    };
    const client = {
      users: {
        lookupByEmail: async ({ email }: { email: string }) => ({
          user: { id: `U-${email.split("@")[0]}` },
        }),
      },
      conversations: { open },
    };
    const f = createSurfaceContextFulfiller({
      core: core as never,
      directory: directory as never,
      serializer: {} as never,
      botToken: "xoxb-test",
      clientOptions: {},
    });
    return { f, client, fulfilled };
  }

  const openRequest = (id: string) => ({
    id,
    source: "slack" as const,
    createdAt: Date.now(),
    status: "pending" as const,
    query: { count: 1, openGroup: { participants: ["alice@acme.dev", "kai@acme.dev"] } },
  });

  it("maps principals to Slack ids and opens one conversation for all of them", async () => {
    const calls: Array<{ users: string }> = [];
    const syncs: string[] = [];
    const { f, client, fulfilled } = fulfiller(async (args) => {
      calls.push(args);
      return { channel: { id: "C-mpim-live" } };
    }, syncs);

    await f.fulfillSurfaceContext(client, openRequest("req-1"));

    assert.deepEqual(calls, [{ users: "U-alice,U-kai" }]);
    assert.deepEqual((fulfilled[0]!.outcome as any).result.group, { groupId: "C-mpim-live" });
    assert.deepEqual(syncs, ["sync"], "the surface resyncs so its cached roster keeps the new group");
  });

  it("reports Slack's refusal instead of pretending the group is missing", async () => {
    const { f, client, fulfilled } = fulfiller(async () => {
      const err = new Error("user_not_found") as Error & { data: { error: string } };
      err.data = { error: "user_not_found" };
      throw err;
    });

    await f.fulfillSurfaceContext(client, openRequest("req-2"));

    assert.match(String((fulfilled[0]!.outcome as any).error), /user_not_found/);
  });
});

const IDS = {
  ownTeamId: "T1",
  botUserId: "UBOT",
  ownBotId: "BBOT",
  botHandle: "qm",
  ownWorkspaceUrl: "",
  identityMode: "email",
} as const;
const ALICE = { id: "U1", team_id: "T1", name: "alice", profile: { email: "alice@x.com" } };
const KAI = { id: "U2", team_id: "T1", name: "kai", profile: { email: "kai@x.com" } };

function syncCore(
  holdDirectorySync: (fn: (lost: Promise<void>) => Promise<unknown>) => Promise<unknown> | unknown,
  accept: () => boolean = () => true,
) {
  const pushes: Array<Record<string, unknown>> = [];
  const core = {
    pushDirectory: async (body: Record<string, unknown>) => {
      pushes.push(body);
      return accept();
    },
    holdDirectorySync,
  };
  return { core: core as never, pushes };
}

const held = (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {}));

function crawlClient(opts: { members?: unknown[]; isPrivate?: boolean; failMpim?: boolean; listed?: string[] } = {}) {
  return {
    users: { info: async () => ({ user: undefined }) },
    conversations: { info: async () => ({ channel: undefined }) },
    async *paginate(method: string, args: Record<string, unknown> = {}) {
      opts.listed?.push(method);
      if (method === "users.list") {
        yield { members: opts.members ?? [ALICE] };
        return;
      }
      if (method === "conversations.list") {
        if (opts.failMpim && args.types === "mpim") throw new Error("ratelimited");
        yield {
          channels: [{ id: "C1", name: "eng", is_member: true, ...(opts.isPrivate ? { is_private: true } : {}) }],
        };
        return;
      }
      yield { members: opts.failMpim ? [] : ["U1"] };
    },
  };
}

async function waitForPushes(pushes: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (pushes.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

describe("pushing the group roster when Slack won't list group DMs", () => {
  it("omits the roster rather than replacing it with an empty one", async () => {
    const { core, pushes } = syncCore(held);
    const dir = createDirectory({ core, ids: IDS });

    await dir.getUserSnapshot(crawlClient({ failMpim: true }));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(pushes.length, 1);
    assert.ok(Array.isArray(pushes[0]!.channels), "channels still push");
    assert.equal("groupMembers" in pushes[0]!, false, "an unknown roster is absent, never an empty replacement");
  });
});

describe("the directory crawl when another instance holds the sync lease", () => {
  it("skips the channel crawl and the push instead of racing the leader", async () => {
    const listed: string[] = [];
    const { core, pushes } = syncCore(async () => null);
    const dir = createDirectory({ core, ids: IDS });

    const snap = await dir.getUserSnapshot(crawlClient({ listed }));
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(snap?.byId.has("U1"), "the local snapshot still refreshes for classification");
    assert.equal(pushes.length, 0);
    assert.deepEqual(listed, ["users.list"], "no channel or group crawl runs on the follower");
  });

  it("retries a skipped sync until the lease frees, then applies the queued revocation", async () => {
    let locked = true;
    const { core, pushes } = syncCore(async (fn) => (locked ? null : held(fn)));
    const dir = createDirectory({ core, syncRetryMs: 5, ids: IDS });

    await dir.forceDirectorySync(crawlClient({ members: [ALICE, KAI], isPrivate: true }), "C1", "kai@x.com");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pushes.length, 0, "nothing lands while the lease is held elsewhere");

    locked = false;
    await waitForPushes(pushes, 1);
    const revocations = pushes.at(-1)?.channelRevocations as Array<Record<string, string>>;
    assert.deepEqual(revocations, [{ channelId: "C1", principalId: "kai@x.com" }]);
  });

  it("retries a push the store refused as stale until the revocation actually lands", async () => {
    let refusals = 1;
    const { core, pushes } = syncCore(held, () => refusals-- <= 0);
    const dir = createDirectory({ core, syncRetryMs: 5, ids: IDS });

    await dir.forceDirectorySync(crawlClient({ members: [ALICE, KAI], isPrivate: true }), "C1", "kai@x.com");
    await waitForPushes(pushes, 2);

    assert.ok(pushes.length >= 2, "the refused push is retried");
    const revocations = pushes.at(-1)?.channelRevocations as Array<Record<string, string>>;
    assert.deepEqual(revocations, [{ channelId: "C1", principalId: "kai@x.com" }]);
  });

  it("discards a crawl whose lease was lost mid-flight instead of pushing it", async () => {
    const { core, pushes } = syncCore(async (fn) => fn(Promise.resolve()));
    const dir = createDirectory({ core, ids: IDS });

    const snap = await dir.getUserSnapshot(crawlClient());
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(snap?.byId.has("U1"));
    assert.equal(pushes.length, 0, "a crawl finished after losing the lease never reaches the store");
  });
});

describe("directory resolution by Slack id", () => {
  it("resolves a teammate the agent named by their Slack member id", async () => {
    const store = createDirectoryStore();
    await store.replace([
      { principalId: "kai@acme.dev", displayName: "kai", type: "internal", slackId: "U09LKC3KATS" },
      { principalId: "alice@acme.dev", displayName: "alice", type: "internal", slackId: "U07QR5C33S7" },
    ]);
    assert.deepEqual(await store.resolve("U09LKC3KATS"), {
      kind: "one",
      member: {
        principalId: "kai@acme.dev",
        displayName: "kai",
        type: "internal",
        slackId: "U09LKC3KATS",
      },
    });
    assert.equal((await store.resolve("kai")).kind, "one");
    assert.equal((await store.resolve("U-nobody")).kind, "none");
  });
});

describe("directory group upsert", () => {
  it("makes a just-opened group resolvable and its members visible at once", async () => {
    const store = createDirectoryStore();
    await store.replaceGroups([]);
    assert.equal((await store.resolveGroupByParticipants(["a", "b"])).kind, "none");

    await store.upsertGroup("C-new", ["a", "b"]);
    assert.deepEqual(await store.resolveGroupByParticipants(["b", "a"]), { kind: "one", groupId: "C-new" });
    assert.equal(await store.groupMember("C-new", "a"), true);
    assert.equal(await store.groupMember("C-new", "c"), false);
  });
});
