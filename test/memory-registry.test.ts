import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  EMPTY_MEMORY_REGISTRY,
  MemoryRegistryError,
  brainRefusal,
  deleteBinding,
  deleteBrain,
  deleteMemberBrain,
  memberBrainId,
  putBinding,
  putBrain,
  putMemberBrain,
  resolveMemoryRegistry,
  setMemberBrains,
  type MemoryRegistry,
} from "../src/memory/registry.ts";
import type { MemoryDisclosure } from "../src/memory/disclosure.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { createRegistryMemoryService } from "../src/memory/registry-memory.ts";
import type { ScopeId } from "../src/types.ts";
import { emptyMemoryRegistry } from "./support/memory-registry.ts";

const change = {
  actor: "admin-alice",
  now: 1_762_128_000_000,
  overlayIds: new Set<string>(),
  key: deriveConnectorKey("test-memory-registry-key", "memory-registry"),
};

function refused(fn: () => unknown, status: number, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof MemoryRegistryError);
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

function personalBrain(record: MemoryRegistry = EMPTY_MEMORY_REGISTRY, body: Record<string, unknown> = {}) {
  return putBrain(
    record,
    "acme-personal",
    {
      preset: "gbrain-v1",
      url: "https://brain.acme.example/mcp",
      clientId: "qm-personal",
      clientSecret: "personal-secret",
      label: "Acme personal memory",
      ...body,
    },
    change,
  );
}

test("a brain binds the kind personal or one member's personal scope, and always attests the member", () => {
  const record = personalBrain();
  for (const scope of ["group:web-project-1", "channel", "personal:", "U1"])
    refused(() => putBinding(record, "p", { brain: "acme-personal", scope }, change), 400, /personal memory/);
  refused(
    () => putBinding(record, "p", { brain: "acme-personal", scope: "personal:U1", capture: "automatic" }, change),
    400,
    /automatic/,
  );
  const bound = [
    putBinding(record, "everyone", { brain: "acme-personal", scope: "personal", capture: "explicit" }, change),
    putBinding(
      putBinding(
        record,
        "alice",
        { brain: "acme-personal", scope: "personal:U1", recall: false, capture: "explicit" },
        change,
      ),
      "bob",
      { brain: "acme-personal", scope: "personal:U2", capture: "explicit" },
      change,
    ),
  ];
  const resolved = bound.map((entry) => resolveMemoryRegistry(entry, change));
  assert.deepEqual(
    resolved.flatMap(({ disabled }) => disabled),
    [],
  );
  assert.doesNotMatch(JSON.stringify(bound), /personal-secret/);
  assert.deepEqual(
    resolved.map(({ config }) =>
      config.providers.map((provider) => [
        provider.id,
        provider.type === "mcp" && provider.attestActor,
        provider.type === "mcp" && provider.read.auth.clientSecret,
      ]),
    ),
    [[["acme-personal", true, "personal-secret"]], [["acme-personal", true, "personal-secret"]]],
  );
  assert.deepEqual(
    resolved.flatMap(({ config }) => config.routes),
    [
      {
        provider: "acme-personal",
        scopes: ["personal"],
        capture: "explicit",
        recall: true,
        manage: false,
        label: "Acme personal memory",
        failOpen: true,
      },
      {
        provider: "acme-personal",
        scopes: ["personal:U1"],
        capture: "explicit",
        recall: false,
        manage: false,
        label: "Acme personal memory",
        failOpen: true,
      },
      {
        provider: "acme-personal",
        scopes: ["personal:U2"],
        capture: "explicit",
        recall: true,
        manage: false,
        label: "Acme personal memory",
        failOpen: true,
      },
    ],
  );
});

test("a scope binds to one brain once, and a binding can move to another brain or scope", () => {
  let record = putBinding(personalBrain(), "alice", { brain: "acme-personal", scope: "personal:U1" }, change);
  refused(
    () => putBinding(record, "alice-again", { brain: "acme-personal", scope: "personal:U1" }, change),
    409,
    /already bound to brain acme-personal by binding alice/,
  );
  refused(
    () => putBinding(record, "everyone", { brain: "acme-personal", scope: "personal" }, change),
    409,
    /personal:U1 is already bound to brain acme-personal by binding alice/,
  );
  const everyone = putBinding(personalBrain(), "everyone", { brain: "acme-personal", scope: "personal" }, change);
  refused(
    () => putBinding(everyone, "alice", { brain: "acme-personal", scope: "personal:U1", recall: false }, change),
    409,
    /personal is already bound to brain acme-personal by binding everyone/,
  );
  record = putBinding(record, "alice", { scope: "personal:U2" }, change);
  assert.deepEqual(
    record.bindings.map(({ id, scope }) => [id, scope]),
    [["alice", "personal:U2"]],
  );
});

test("env provider ids are read-only and a stored collision disables the route", () => {
  const overlayIds = new Set(["gbrain"]);
  refused(
    () => putBrain(EMPTY_MEMORY_REGISTRY, "gbrain", {}, { ...change, overlayIds }),
    409,
    /MEMORY_PROVIDER_CONFIG/,
  );
  const record = putBinding(personalBrain(), "p1", { brain: "acme-personal", scope: "personal:U1" }, change);
  const { config, disabled } = resolveMemoryRegistry(record, { ...change, overlayIds: new Set(["acme-personal"]) });
  assert.deepEqual(config.routes, []);
  assert.deepEqual(
    disabled.map(({ binding, code }) => [binding, code]),
    [["p1", "id_taken"]],
  );
});

test("the registry refuses a brain on a loopback or private address", () => {
  for (const url of [
    "http://localhost:8787/mcp",
    "http://127.0.0.1:8787/mcp",
    "https://10.0.0.7/mcp",
    "https://[::1]/mcp",
    "https://169.254.169.254/latest",
    "http://brain.internal/mcp",
    "https://gbrain.local/mcp",
    "https://localhost./mcp",
    "https://brain.internal./mcp",
    "https://gbrain.local../mcp",
  ])
    refused(
      () => personalBrain(EMPTY_MEMORY_REGISTRY, { url }),
      400,
      /public address: QM never calls a registry brain on a private network/,
    );
  assert.equal(personalBrain().brains[0]!.url, "https://brain.acme.example/mcp");
});

test("the registry checks a url with 200,000 dots or slashes in well under a second", () => {
  for (const url of [
    `https://a${".".repeat(200_000)}b/mcp`,
    `https://brain.acme.example/${"/".repeat(200_000)}x/mcp`,
  ]) {
    const started = performance.now();
    assert.equal(personalBrain(EMPTY_MEMORY_REGISTRY, { url }).brains[0]!.url, url);
    assert.ok(performance.now() - started < 1_000);
  }
});

test("the env validator's rules apply to registry brains", () => {
  refused(() => personalBrain(EMPTY_MEMORY_REGISTRY, { url: "http://brain.example.com" }), 400, /must use HTTPS/);
  refused(() => personalBrain(EMPTY_MEMORY_REGISTRY, { preset: "gbrain-v9" }), 400, /preset must be one of/);
  refused(() => personalBrain(EMPTY_MEMORY_REGISTRY, { timeoutMs: 60_000 }), 400, /from 1 to 30000/);
  refused(
    () =>
      putBrain(
        EMPTY_MEMORY_REGISTRY,
        "default",
        { preset: "gbrain-v1", url: "https://brain.acme.example/mcp", clientId: "c", label: "x" },
        change,
      ),
    400,
    /invalid memory provider id: default/,
  );
});

test("each binding QM can't serve names its reason", () => {
  let record = personalBrain();
  record = putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change);
  record = putBrain(record, "acme-personal", { url: "https://brain2.acme.example/mcp" }, change);
  const alice = record.bindings[0]!;
  const rekeyed = putBrain(
    EMPTY_MEMORY_REGISTRY,
    "rekeyed",
    { preset: "gbrain-v1", url: "https://brain3.acme.example/mcp", clientId: "c", clientSecret: "s", label: "x" },
    { ...change, key: deriveConnectorKey("an-older-connector-key", "memory-registry") },
  ).brains[0]!;
  const { config, disabled } = resolveMemoryRegistry(
    {
      ...record,
      brains: [...record.brains, { ...record.brains[0]!, id: "future", preset: "gbrain-v9" }, rekeyed],
      bindings: [
        alice,
        { ...alice, id: "bob", brain: "future", scope: "personal:U2" },
        { ...alice, id: "gone", brain: "deleted-brain" },
        { ...alice, id: "room", scope: "group:web-project-1" },
        { ...alice, id: "carol", brain: "rekeyed", scope: "personal:U3" },
      ],
    },
    change,
  );
  assert.deepEqual(config.routes, []);
  assert.deepEqual(
    disabled.map(({ binding, code, detail }) => [binding, code, detail?.split(" (")[0]]),
    [
      ["alice", "secret_missing", undefined],
      ["bob", "preset_unknown", undefined],
      ["gone", "invalid_config", "brain deleted-brain isn't registered"],
      ["room", "invalid_config", "group:web-project-1 isn't a personal scope"],
      [
        "carol",
        "invalid_config",
        "brain rekeyed's client secret can't be decrypted with this instance's CONNECTOR_SECRET_KEY; set it again",
      ],
    ],
  );
});

test("a brain keeps its client credentials exactly as sent", () => {
  const record = putBinding(
    personalBrain(EMPTY_MEMORY_REGISTRY, { clientId: " qm-personal ", clientSecret: "\tpadded secret " }),
    "everyone",
    { brain: "acme-personal", scope: "personal" },
    change,
  );
  const [provider] = resolveMemoryRegistry(record, change).config.providers;
  assert.ok(provider?.type === "mcp");
  assert.deepEqual(provider.read.auth, { clientId: " qm-personal ", clientSecret: "\tpadded secret " });
  refused(
    () => personalBrain(EMPTY_MEMORY_REGISTRY, { clientSecret: " \t " }),
    400,
    /clientSecret must be a non-empty string/,
  );
});

test("moving a brain drops its secret, and a brain with bindings can't be deleted", () => {
  let record = putBinding(personalBrain(), "alice", { brain: "acme-personal", scope: "personal:U1" }, change);
  const sealed = record.brains[0]!.auth.clientSecretEnc;
  record = putBrain(record, "acme-personal", { label: "Renamed" }, change);
  assert.ok(sealed);
  assert.equal(record.brains[0]!.auth.clientSecretEnc, sealed);
  record = putBrain(record, "acme-personal", { url: "https://brain2.acme.example/mcp" }, change);
  assert.equal(record.brains[0]!.auth.clientSecretEnc, undefined);
  refused(() => deleteBrain(record, "acme-personal"), 409, /delete it first/);
  record = deleteBrain(deleteBinding(record, "alice"), "acme-personal");
  assert.deepEqual(record, EMPTY_MEMORY_REGISTRY);
});

const ALICE_BRAIN = memberBrainId("U1");
const aliceBrain = (record: MemoryRegistry = EMPTY_MEMORY_REGISTRY, body: Record<string, unknown> = {}) =>
  putMemberBrain(record, "U1", { url: "https://brain.alice.example/mcp", clientId: "alice-qm", ...body }, change);

test("a member's own brain serves only their personal scope, as them, and names no other owner", () => {
  const record = aliceBrain();
  assert.deepEqual(
    record.brains.map(({ id, owner, preset, label }) => ({ id, owner, preset, label })),
    [{ id: ALICE_BRAIN, owner: "U1", preset: "gbrain-v1", label: "Personal memory" }],
  );
  assert.deepEqual(
    record.bindings.map(({ id, brain, scope, capture }) => ({ id, brain, scope, capture })),
    [{ id: ALICE_BRAIN, brain: ALICE_BRAIN, scope: "personal:U1", capture: "explicit" }],
  );
  for (const scope of ["personal", "personal:U2"])
    refused(() => putBinding(record, "other", { brain: ALICE_BRAIN, scope }, change), 400, /only their own/);
  refused(() => aliceBrain(record, { owner: "U2" }), 400, /takes only url, clientId, label, not owner/);
  refused(() => aliceBrain(record, { clientSecret: "s" }), 400, /never goes through the agent/);
  refused(
    () =>
      putMemberBrain(
        putBrain(
          EMPTY_MEMORY_REGISTRY,
          ALICE_BRAIN,
          { preset: "gbrain-v1", url: "https://x.example/mcp", clientId: "c", label: "l" },
          change,
        ),
        "U1",
        {},
        change,
      ),
    409,
    /taken by another brain/,
  );

  const renamed = putBrain(aliceBrain(record, { label: "Alice's gbrain" }), ALICE_BRAIN, { timeoutMs: 5000 }, change);
  assert.deepEqual(
    [renamed.brains[0]!.label, renamed.brains[0]!.owner, renamed.brains[0]!.timeoutMs, renamed.bindings.length],
    ["Alice's gbrain", "U1", 5000, 1],
  );
  assert.deepEqual(deleteMemberBrain(renamed, "U1"), EMPTY_MEMORY_REGISTRY);
  refused(() => deleteMemberBrain(renamed, "U2"), 404, /no brain connected/);
});

test("a member's brain needs a public https url, whoever writes it, and so does an org brain", () => {
  const publicHttps = /must use HTTPS at a public address/;
  for (const url of ["http://brain.alice.example/mcp", "https://[::1]/mcp"])
    refused(() => aliceBrain(EMPTY_MEMORY_REGISTRY, { url }), 400, publicHttps);
  refused(() => putBrain(aliceBrain(), ALICE_BRAIN, { url: "http://localhost:3131/mcp" }, change), 400, publicHttps);
  refused(() => personalBrain(EMPTY_MEMORY_REGISTRY, { url: "http://localhost:3131/mcp" }), 400, publicHttps);
});

test("the org switch stops members' brains and refuses new ones, and leaves org brains serving", () => {
  let record = putBinding(
    aliceBrain(personalBrain()),
    "everyone",
    { brain: "acme-personal", scope: "personal" },
    change,
  );
  record = putBrain(
    record,
    ALICE_BRAIN,
    { clientSecret: "alice-secret", url: "https://brain.alice.example/mcp" },
    change,
  );
  const serving = (current: MemoryRegistry) => resolveMemoryRegistry(current, change);
  assert.deepEqual(
    serving(record).config.routes.map(({ provider }) => provider),
    [ALICE_BRAIN, "acme-personal"],
  );

  const off = setMemberBrains(record, { enabled: false });
  assert.deepEqual(
    serving(off).config.routes.map(({ provider }) => provider),
    ["acme-personal"],
  );
  assert.deepEqual(
    serving(off).disabled.map(({ binding, code }) => [binding, code]),
    [[ALICE_BRAIN, "member_brains_off"]],
  );
  refused(
    () => putMemberBrain(off, "U2", { url: "https://brain.bob.example/mcp", clientId: "b" }, change),
    403,
    /turned off/,
  );
  assert.deepEqual(serving(setMemberBrains(off, { enabled: true })).config.routes.length, 2);
  refused(() => setMemberBrains(record, { enabled: "no" }), 400, /true or false/);
});

test("a brain's owner who is no longer an active member can't set its secret", () => {
  const record = aliceBrain();
  assert.match(
    brainRefusal(record, record.brains[0]!, "U1", "inactive") ?? "",
    /only an org admin or the brain's owner/,
  );
});

test("setting a brain's secret restates the url the secret goes to", () => {
  const registered = personalBrain(EMPTY_MEMORY_REGISTRY, { clientSecret: undefined });
  for (const body of [{ clientSecret: "personal-secret" }, { clientSecret: "personal-secret", url: null }])
    refused(() => putBrain(registered, "acme-personal", body, change), 400, /must restate url/);
  const approved = putBrain(
    registered,
    "acme-personal",
    { clientSecret: "personal-secret", url: "https://brain.acme.example/mcp" },
    change,
  );
  assert.ok(approved.brains[0]!.auth.clientSecretEnc);
});

test("registry memory narrows chained disclosures in order", async () => {
  const applied: string[] = [];
  const recording = (path: readonly string[]): MemoryService => ({
    recall: async () => {
      applied.push(path.join(" > "));
      return [];
    },
    capture: async () => 0,
    query: async () => [],
    read: async () => "",
    withDisclosure: (access) => recording([...path, access.targetScope]),
  });
  const disclosure = (targetScope: ScopeId): MemoryDisclosure => ({
    actor: { id: "alice", type: "internal" },
    targetScope,
    nativeScopes: [],
    audience: [],
    open: false,
  });
  const memory = createRegistryMemoryService({ defaultMemory: recording([]), registry: emptyMemoryRegistry });
  await memory.withDisclosure!(disclosure("personal:alice")).withDisclosure!(disclosure("channel:room")).recall(
    "personal:alice",
  );
  assert.deepEqual(applied, ["personal:alice > channel:room"]);
});
