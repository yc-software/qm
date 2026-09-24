import { createCurrentScopeMembers } from "../src/resolution/scope-membership.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { disclosedMemory, type MemoryDisclosure } from "../src/memory/disclosure.ts";
import { updateMemoryRecords, type MemoryRecords } from "../src/memory/records.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";

const actor = { id: "alice", type: "internal" as const };
const bob = { id: "bob", type: "internal" as const };
function fixture() {
  let revoked = false;
  let isolated = false;
  const heads = new Map<string, { content: string; revision: string; records?: MemoryRecords }>();
  const access: MemoryDisclosure = {
    actor,
    targetScope: "group:room",
    nativeScopes: ["group:room", "org:test"],
    audience: [actor, bob],
    open: true,
    config: {
      resolveSharingPostureDurable: async (_personal, source) =>
        isolated && source === "group:source" ? "isolated" : "open",
    },
    isCurrentSharedScopeMember: async (id, source) => !revoked && id === "alice" && source === "group:source",
  };
  access.currentScopeMembers = async () => [...access.audience];
  function put(
    home: string,
    text: string,
    sensitivity: "ordinary" | "sensitive" | "restricted" | "unknown",
    source = home,
    unknown = false,
  ) {
    const records = updateMemoryRecords(home, { version: 1, records: [] }, `- ${text}`, {
      sensitivity,
      conversationScopeId: source,
      inheritedRecords: [],
    });
    records.records[0]!.sourceUnknown = unknown;
    const head = heads.get(home) ?? { content: "", revision: "1", records: { version: 1 as const, records: [] } };
    head.content += `- ${text}\n`;
    head.records!.records.push(...records.records);
    heads.set(home, head);
  }
  const raw: MemoryService = {
    read: async (scope) => heads.get(scope)?.content ?? "",
    readHead: async (scope) => heads.get(scope) ?? { content: "", revision: "0" },
    query: async () => ["OPAQUE_SENTINEL"],
    recall: async () => "OPAQUE_SENTINEL",
    capture: async () => 0,
    replace: async () => {},
    history: async (scope) => [{ ...heads.get(scope)!, operation: "capture", at: 1, author: "alice" }],
  };
  return {
    raw,
    access,
    put,
    heads,
    revoke: () => {
      revoked = true;
    },
    isolate: () => {
      isolated = true;
    },
  };
}

test("Open memory continuity shares ordinary personal facts, not sensitive, restricted, unknown or incomplete siblings", async () => {
  const f = fixture();
  for (const label of ["ordinary", "sensitive", "restricted", "unknown"] as const)
    f.put("personal:alice", label, label);
  f.put("personal:alice", "incomplete", "ordinary", "personal:alice", true);
  const view = disclosedMemory(f.raw, f.access);
  assert.equal(await view.read("personal:alice"), "- ordinary");
  assert.deepEqual(await view.query("personal:alice", "ordinary"), ["ordinary"]);
  assert.deepEqual(await view.query("personal:alice", "sensitive"), []);
  assert.equal((await view.history!("personal:alice"))[0]!.content, "- ordinary");
  assert.equal((await view.readHead!("personal:alice")).records!.records.length, 1);
});

test("copying a private fact to a readable notebook does not make its audience eligible", async () => {
  const f = fixture();
  f.put("group:room", "PRIVATE_SENTINEL", "ordinary", "group:source");
  const view = disclosedMemory(f.raw, f.access);
  assert.equal(await view.read("group:room"), "");
  assert.deepEqual(await view.query("group:room", "PRIVATE_SENTINEL"), []);
  f.access.audience = [actor];
  assert.match(await view.read("group:room"), /PRIVATE_SENTINEL/);
  f.isolate();
  assert.equal(await view.read("group:room"), "");
});

test("private owner reads recheck original membership for copied sensitive facts, including history", async () => {
  const f = fixture();
  f.access.targetScope = "personal:alice";
  f.access.nativeScopes = ["personal:alice"];
  f.access.audience = [actor];
  f.put("personal:alice", "COPIED_SENTINEL", "sensitive", "group:source");
  const view = disclosedMemory(f.raw, f.access);
  assert.match(await view.read("personal:alice"), /COPIED_SENTINEL/);
  f.revoke();
  assert.equal(await view.read("personal:alice"), "");
  assert.deepEqual(await view.query("personal:alice", "COPIED_SENTINEL"), []);
  assert.equal((await view.history!("personal:alice"))[0]!.content, "");
});

test("legacy and opaque providers stay within their original audience, including routed queries", async () => {
  const f = fixture();
  f.heads.set("personal:alice", { content: "- LEGACY_SENTINEL", revision: "1" });
  const opaque = { ...f.raw, readHead: undefined, history: undefined };
  const routed = createRoutedMemoryService({
    providers: { opaque },
    routes: [{ provider: "opaque", scopes: ["personal"] }],
  });
  const shared = disclosedMemory(routed, f.access);
  assert.equal(await shared.read("personal:alice"), "");
  assert.equal(await shared.recall("personal:alice"), "");
  assert.deepEqual(await shared.query("personal:alice", "SENTINEL"), []);
  const own = disclosedMemory(routed, {
    ...f.access,
    targetScope: "personal:alice",
    nativeScopes: ["personal:alice"],
    audience: [actor],
  });
  assert.match(await own.read("personal:alice"), /LEGACY_SENTINEL/);
  assert.deepEqual(await own.query("personal:alice", "SENTINEL"), ["OPAQUE_SENTINEL"]);
});

test("malformed metadata, mismatched text, empty audience and authorization lookup failures fail closed", async () => {
  const f = fixture();
  f.put("personal:alice", "ORDINARY_SENTINEL", "ordinary");
  for (const patch of [
    { audience: [], currentScopeMembers: async () => [] },
    { config: undefined },
    {
      config: {
        resolveSharingPostureDurable: async () => {
          throw Error("unavailable");
        },
      },
    },
  ]) {
    assert.equal(await disclosedMemory(f.raw, { ...f.access, ...patch }).read("personal:alice"), "");
  }
  const head = f.heads.get("personal:alice")!;
  head.records!.records[0]!.text = "- different";
  assert.equal(await disclosedMemory(f.raw, f.access).read("personal:alice"), "");
  head.records = { version: 1, records: [null] } as unknown as MemoryRecords;
  assert.equal(await disclosedMemory(f.raw, f.access).read("personal:alice"), "");
});

test("source authorization requires every source, not merely the notebook owner", async () => {
  const f = fixture();
  f.put("personal:alice", "MERGED_SENTINEL", "ordinary");
  f.heads.get("personal:alice")!.records!.records[0]!.sources.push({ scopeId: "group:source" });
  assert.equal(await disclosedMemory(f.raw, f.access).read("personal:alice"), "");
});

test("native org memory and private owner legacy memory retain their original visibility", async () => {
  const f = fixture();
  f.heads.set("org:test", { content: "- ORG_SENTINEL", revision: "1" });
  assert.match(await disclosedMemory(f.raw, f.access).read("org:test"), /ORG_SENTINEL/);
  f.heads.set("personal:alice", { content: "- LEGACY_SENTINEL", revision: "1" });
  assert.match(
    await disclosedMemory(f.raw, {
      ...f.access,
      targetScope: "personal:alice",
      nativeScopes: ["personal:alice"],
      audience: [actor],
      open: false,
    }).read("personal:alice"),
    /LEGACY_SENTINEL/,
  );
});

test("current destination members override an old audience snapshot on every read", async () => {
  const f = fixture();
  f.access.audience = [actor];
  let members = [actor];
  f.access.currentScopeMembers = async () => members;
  f.put("group:room", "SOURCE_SENTINEL", "sensitive", "group:source");
  const view = disclosedMemory(f.raw, f.access);
  assert.match(await view.read("group:room"), /SOURCE_SENTINEL/);
  members = [actor, bob];
  assert.equal(await view.read("group:room"), "");
  assert.deepEqual(await view.query("group:room", "SOURCE_SENTINEL"), []);
});

test("unknown destination roster cannot authorize cross-context disclosure", async () => {
  const f = fixture();
  f.access.currentScopeMembers = async () => undefined;
  f.put("personal:alice", "ORDINARY_SENTINEL", "ordinary");
  assert.equal(await disclosedMemory(f.raw, f.access).read("personal:alice"), "");
});

test("partial rewrites and structured non-CAS rewrites are refused without changing storage", async () => {
  const f = fixture();
  let writes = 0;
  f.raw.replace = async () => {
    writes++;
  };
  f.put("group:room", "PRIVATE_SENTINEL", "sensitive", "group:source");
  await assert.rejects(disclosedMemory(f.raw, f.access).replace("group:room", "- public"), /unavailable here/);
  f.access.audience = [actor];
  await assert.rejects(disclosedMemory(f.raw, f.access).replace("group:room", "- public"), /unavailable here/);
  assert.equal(writes, 0);
});

test("a structured provider's opaque query cannot resurrect denied source records", async () => {
  const f = fixture();
  f.put("group:room", "PRIVATE_SENTINEL", "sensitive", "group:source");
  f.raw.query = async () => ["PRIVATE_SENTINEL"];
  f.raw.recall = async () => "PRIVATE_SENTINEL";
  const view = disclosedMemory(f.raw, f.access);
  assert.deepEqual(await view.query("group:room", "SENTINEL"), []);
  assert.equal(await view.recall("group:room"), "");
});

test("each routed provider is filtered independently and a failure does not invoke a raw fallback", async () => {
  const first = fixture();
  const second = fixture();
  first.put("personal:alice", "FIRST_PRIVATE_SENTINEL", "sensitive");
  first.put("personal:alice", "FIRST_ORDINARY_SENTINEL", "ordinary");
  second.put("personal:alice", "SECOND_PRIVATE_SENTINEL", "restricted");
  second.put("personal:alice", "SECOND_ORDINARY_SENTINEL", "ordinary");
  const broken: MemoryService = {
    ...first.raw,
    readHead: async () => {
      throw Error("unavailable");
    },
    query: async () => {
      throw Error("raw fallback must not run");
    },
  };
  const routes = ["first", "second", "broken"].map((provider) => ({
    provider,
    scopes: ["personal:alice"],
    failOpen: true,
  }));
  const routed = createRoutedMemoryService({ providers: { first: first.raw, second: second.raw, broken }, routes });
  let captures = 0;
  const wrapped = { ...routed, capture: async () => ++captures };
  const view = disclosedMemory(wrapped, first.access);
  assert.deepEqual(await view.query("personal:alice", "SENTINEL"), [
    "FIRST_ORDINARY_SENTINEL",
    "SECOND_ORDINARY_SENTINEL",
  ]);
  assert.doesNotMatch(await view.recall("personal:alice"), /PRIVATE_SENTINEL/);
  await view.capture("personal:alice", ["new fact"], 1);
  assert.equal(captures, 1);
});

test("source decisions are shared within one read but never cached across reads", async () => {
  const f = fixture();
  let checks = 0;
  f.access.config = {
    resolveSharingPostureDurable: async () => {
      checks++;
      return "open";
    },
  };
  for (let i = 0; i < 100; i++) f.put("personal:alice", `ORDINARY_${i}`, "ordinary");
  const view = disclosedMemory(f.raw, f.access);
  assert.match(await view.read("personal:alice"), /ORDINARY_99/);
  assert.equal(checks, 2);
  await view.read("personal:alice");
  assert.equal(checks, 4);
});

test("historical revisions cannot undo a later sensitivity or source restriction", async () => {
  const f = fixture();
  f.put("personal:alice", "RECLASSIFIED_SENTINEL", "ordinary");
  const old = structuredClone(f.heads.get("personal:alice")!);
  f.heads.get("personal:alice")!.records!.records[0]!.sensitivity = "restricted";
  f.raw.history = async () => [
    { ...f.heads.get("personal:alice")!, revision: "2", operation: "capture", at: 2 },
    { ...old, operation: "capture", at: 1 },
  ];
  const view = disclosedMemory(f.raw, f.access);
  assert.doesNotMatch(JSON.stringify(await view.history!("personal:alice")), /RECLASSIFIED_SENTINEL/);
});

test("complete memory audience rejects external or unresolved members rather than dropping them", async () => {
  const directory = createDirectoryStore();
  await directory.replace([{ principalId: "alice", displayName: "Alice", type: "internal" }]);
  await directory.replaceChannels(
    [{ channelId: "room", name: "room", isPrivate: true }],
    [{ channelId: "room", principalId: "alice" }],
  );
  const members = createCurrentScopeMembers({ directory, identity: { classify: () => ({ type: "internal" }) } }, true);
  assert.equal((await members("channel:room"))?.length, 1);
  await directory.replaceChannels(
    [{ channelId: "room", name: "room", isPrivate: true }],
    [
      { channelId: "room", principalId: "alice" },
      { channelId: "room", principalId: "unresolved" },
    ],
  );
  assert.equal(await members("channel:room"), undefined);
  await directory.replaceChannels(
    [{ channelId: "room", name: "room", isPrivate: true, isExternal: true }],
    [{ channelId: "room", principalId: "alice" }],
  );
  assert.equal(await members("channel:room"), undefined);
});
