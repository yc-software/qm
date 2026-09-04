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
    open?: (participants: readonly string[]) => Promise<{ groupId: string } | { error: string } | null>;
    unknownAuthor?: boolean;
  } = {},
): ReachDirectory & { registered: Array<{ groupId: string; participants: readonly string[] }> } {
  const groups = opts.groups ?? {};
  const registered: Array<{ groupId: string; participants: readonly string[] }> = [];
  const key = (ids: Iterable<string>) => [...new Set([...ids].filter(Boolean))].sort().join(",");
  return {
    registered,
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
    ...(opts.open ? { openGroup: opts.open } : {}),
    async registerGroup(groupId, participants) {
      registered.push({ groupId, participants });
      groups[groupId] = [...participants];
    },
  };
}

describe("reaching a group DM that the directory hasn't seen", () => {
  it("opens the group DM live, registers it, and addresses it by its real id", async () => {
    const opened: string[][] = [];
    const dir = directory({
      open: async (participants) => {
        opened.push([...participants]);
        return { groupId: "C-mpim-new" };
      },
    });

    const r = await resolveReachTarget(dir, { participants: ["kai@acme.dev"] }, "alice@acme.dev", {
      mayOpenGroup: true,
    });

    assert.equal(r.ok, true);
    assert.equal((r as any).destination.type, "group");
    assert.equal((r as any).destination.target, "C-mpim-new");
    assert.equal((r as any).destination.audienceScopeId, "group:C-mpim-new");
    assert.deepEqual(opened, [["kai@acme.dev", "alice@acme.dev"]]);
    assert.deepEqual(dir.registered, [{ groupId: "C-mpim-new", participants: ["kai@acme.dev", "alice@acme.dev"] }]);
  });

  it("resolves participants named however the agent knows them", async () => {
    const dir = directory({ open: async () => ({ groupId: "C-mpim-new" }) });
    const r = await resolveReachTarget(dir, { participants: ["kai", "jo"] }, "alice@acme.dev", {
      mayOpenGroup: true,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(dir.registered[0]?.participants, ["kai@acme.dev", "jo@acme.dev", "alice@acme.dev"]);
  });

  it("prefers a group the directory already knows and never opens a second one", async () => {
    let openCalls = 0;
    const dir = directory({
      groups: { "C-known": ["alice@acme.dev", "kai@acme.dev"] },
      open: async () => {
        openCalls++;
        return { groupId: "C-mpim-new" };
      },
    });
    const r = await resolveReachTarget(dir, { participants: ["kai"] }, "alice@acme.dev", {
      mayOpenGroup: true,
    });
    assert.equal((r as any).destination.target, "C-known");
    assert.equal(openCalls, 0);
  });

  it("names the person it can't find instead of blaming the group", async () => {
    const dir = directory({ open: async () => ({ groupId: "C-mpim-new" }) });
    const r = await resolveReachTarget(dir, { participants: ["nobody"] }, "alice@acme.dev", {
      mayOpenGroup: true,
    });
    assert.equal((r as any).status, 404);
    assert.equal((r as any).error, "recipient_not_found");
    assert.match((r as any).message, /nobody/);
  });

  it("refuses to open anything for an author it can't place in the directory", async () => {
    let openCalls = 0;
    const dir = directory({
      unknownAuthor: true,
      open: async () => {
        openCalls++;
        return { groupId: "C-mpim-new" };
      },
    });
    const r = await resolveReachTarget(dir, { participants: ["kai"] }, "stranger@example.com", {
      mayOpenGroup: true,
    });
    assert.equal((r as any).status, 403);
    assert.equal((r as any).error, "identity_unverified");
    assert.equal(openCalls, 0);
  });

  it("won't open a group DM that is really a 1:1, or one Slack can't hold", async () => {
    const dir = directory({ open: async () => ({ groupId: "C-mpim-new" }) });
    const self = await resolveReachTarget(dir, { participants: ["alice"] }, "alice@acme.dev", {
      mayOpenGroup: true,
    });
    assert.equal((self as any).status, 400);
    assert.match((self as any).message, /recipient/);

    let openCalls = 0;
    const crowd = directory({
      open: async () => {
        openCalls++;
        return { groupId: "C-mpim-new" };
      },
    });
    const many = await resolveReachTarget(
      crowd,
      { participants: Array.from({ length: 9 }, (_, i) => `p${i}`) },
      "alice@acme.dev",
      { mayOpenGroup: true },
    );
    assert.equal((many as any).status, 400);
    assert.equal((many as any).error, "group_too_large");
    assert.equal(openCalls, 0);
  });

  it("relays what Slack said when the open fails", async () => {
    const dir = directory({ open: async () => ({ error: "kai is deactivated" }) });
    const r = await resolveReachTarget(dir, { participants: ["kai"] }, "alice@acme.dev", {
      mayOpenGroup: true,
    });
    assert.equal((r as any).status, 502);
    assert.equal((r as any).error, "group_open_failed");
    assert.match((r as any).message, /deactivated/);
  });

  it("opens nothing unless the caller is actually sending a message", async () => {
    let openCalls = 0;
    const dir = directory({
      open: async () => {
        openCalls++;
        return { groupId: "C-mpim-new" };
      },
    });
    const r = await resolveReachTarget(dir, { participants: ["kai"] }, "alice@acme.dev");
    assert.equal((r as any).status, 404);
    assert.equal((r as any).error, "group_not_found");
    assert.match((r as any).message, /post to it once/);
    assert.equal(openCalls, 0);
    assert.deepEqual(dir.registered, []);
  });

  it("still says group_not_found when the surface can't open one", async () => {
    const dir = directory();
    delete (dir as { openGroup?: unknown }).openGroup;
    const r = await resolveReachTarget(dir, { participants: ["kai"] }, "alice@acme.dev", {
      mayOpenGroup: true,
    });
    assert.equal((r as any).status, 404);
    assert.equal((r as any).error, "group_not_found");
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
      bridge: {} as never,
      directory: directory as never,
      serializer: {} as never,
      botToken: "xoxb-test",
      clientOptions: {},
    });
    return { f, client, fulfilled };
  }

  it("maps principals to Slack ids and opens one conversation for all of them", async () => {
    const calls: Array<{ users: string }> = [];
    const syncs: string[] = [];
    const { f, client, fulfilled } = fulfiller(async (args) => {
      calls.push(args);
      return { channel: { id: "C-mpim-live" } };
    }, syncs);

    await f.fulfillSurfaceContext(client, {
      id: "req-1",
      source: "slack",
      createdAt: Date.now(),
      status: "pending",
      query: { count: 1, openGroup: { participants: ["alice@acme.dev", "kai@acme.dev"] } },
    });

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

    await f.fulfillSurfaceContext(client, {
      id: "req-2",
      source: "slack",
      createdAt: Date.now(),
      status: "pending",
      query: { count: 1, openGroup: { participants: ["alice@acme.dev", "kai@acme.dev"] } },
    });

    assert.match(String((fulfilled[0]!.outcome as any).error), /user_not_found/);
  });
});

describe("pushing the group roster when Slack won't list group DMs", () => {
  it("omits the roster rather than replacing it with an empty one", async () => {
    const pushes: Array<Record<string, unknown>> = [];
    const core = { pushDirectory: async (body: Record<string, unknown>) => void pushes.push(body) };
    const client = {
      users: { info: async () => ({ user: undefined }) },
      conversations: { info: async () => ({ channel: undefined }) },
      async *paginate(method: string, args: Record<string, unknown>) {
        if (method === "users.list") {
          yield { members: [{ id: "U1", team_id: "T1", name: "alice", profile: { email: "alice@x.com" } }] };
          return;
        }
        if (method === "conversations.list") {
          if (args.types === "mpim") throw new Error("ratelimited");
          yield { channels: [{ id: "C1", name: "eng", is_member: true }] };
          return;
        }
        yield { members: [] };
      },
    };
    const dir = createDirectory({
      core: core as never,
      ids: {
        ownTeamId: "T1",
        botUserId: "UBOT",
        ownBotId: "BBOT",
        botHandle: "qm",
        ownWorkspaceUrl: "",
        identityMode: "email",
      },
    });

    await dir.getUserSnapshot(client);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(pushes.length, 1);
    assert.ok(Array.isArray(pushes[0]!.channels), "channels still push");
    assert.equal("groupMembers" in pushes[0]!, false, "an unknown roster is absent, never an empty replacement");
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
