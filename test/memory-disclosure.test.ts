import { createCurrentScopeMembers } from "../src/resolution/scope-membership.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { disclosedMemory, MemoryDisclosureDenied, type MemoryDisclosure } from "../src/memory/disclosure.ts";
import { MemoryFactsMissing, type MemoryFact } from "../src/memory/facts.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";

const actor = { id: "alice", type: "internal" as const };
const bob = { id: "bob", type: "internal" as const };
function fixture() {
  let revoked = false;
  let isolated = false;
  const notebooks = new Map<string, MemoryFact[]>();
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
    const facts = notebooks.get(home) ?? [];
    facts.push({
      id: String(facts.length + 1),
      text: `- ${text}`,
      sensitivity,
      sources: unknown && sensitivity === "unknown" ? [] : [source],
      sourceUnknown: unknown,
      createdAt: 1,
      updatedAt: 1,
    });
    notebooks.set(home, facts);
  }
  const edits: string[] = [];
  const raw: MemoryService = {
    facts: async (scope) => notebooks.get(scope) ?? [],
    read: async (scope) => (notebooks.get(scope) ?? []).map((fact) => fact.text).join("\n"),
    query: async () => ["OPAQUE_SENTINEL"],
    recall: async () => "OPAQUE_SENTINEL",
    capture: async () => 0,
    edit: async (_scope, changes) => void edits.push(...changes.map((change) => change.id)),
    delete: async (_scope, ids) => void edits.push(...ids),
  };
  return {
    raw,
    access,
    put,
    notebooks,
    edits,
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
  assert.deepEqual(await view.query("personal:alice", "ordinary"), ["#1 ordinary"]);
  assert.deepEqual(await view.query("personal:alice", "sensitive"), []);
  assert.equal((await view.facts!("personal:alice")).length, 1);
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

test("private owner reads recheck original membership for copied sensitive facts", async () => {
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
});

test("opaque providers stay within their original audience, including routed queries", async () => {
  const f = fixture();
  f.put("personal:alice", "LEGACY_SENTINEL", "unknown", "personal:alice", true);
  const opaque = { ...f.raw, facts: undefined };
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

test("empty audience and authorization lookup failures fail closed", async () => {
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
});

test("source authorization requires every source, not merely the notebook owner", async () => {
  const f = fixture();
  f.put("personal:alice", "MERGED_SENTINEL", "ordinary");
  f.notebooks.get("personal:alice")![0]!.sources.push("group:source");
  assert.equal(await disclosedMemory(f.raw, f.access).read("personal:alice"), "");
});

test("native org memory and private owner legacy memory retain their original visibility", async () => {
  const f = fixture();
  f.put("org:test", "ORG_SENTINEL", "unknown", "org:test", true);
  assert.match(await disclosedMemory(f.raw, f.access).read("org:test"), /ORG_SENTINEL/);
  f.put("personal:alice", "LEGACY_SENTINEL", "unknown", "personal:alice", true);
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

test("edits refuse hidden facts as missing and foreign notebooks as denied, without writing", async () => {
  const f = fixture();
  f.put("group:room", "PRIVATE_SENTINEL", "sensitive", "group:source");
  f.put("group:room", "ROOM_SENTINEL", "ordinary", "group:room");
  const view = disclosedMemory(f.raw, f.access);
  await assert.rejects(
    view.edit!("group:room", [
      { id: "2", text: "fine" },
      { id: "1", text: "public" },
    ]),
    (e: unknown) => e instanceof MemoryFactsMissing && e.ids.join() === "1",
  );
  await assert.rejects(view.delete!("personal:bob", ["1"]), MemoryDisclosureDenied);
  assert.deepEqual(f.edits, []);
  await view.delete!("group:room", ["#2"]);
  assert.deepEqual(f.edits, ["#2"]);
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
    facts: async () => {
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
    "#2 FIRST_ORDINARY_SENTINEL",
    "#2 SECOND_ORDINARY_SENTINEL",
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
