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
  const bound = putBinding(
    putBinding(record, "everyone", { brain: "acme-personal", scope: "personal", capture: "explicit" }, change),
    "alice",
    { brain: "acme-personal", scope: "personal:U1", recall: false, capture: "explicit" },
    change,
  );
  const { config, disabled } = resolveMemoryRegistry(bound, change);
  assert.deepEqual(disabled, []);
  assert.doesNotMatch(JSON.stringify(bound), /personal-secret/);
  assert.deepEqual(
    config.providers.map((provider) => [
      provider.id,
      provider.type === "mcp" && provider.attestActor,
      provider.type === "mcp" && provider.read.auth.clientSecret,
    ]),
    [["acme-personal", true, "personal-secret"]],
  );
  assert.deepEqual(config.routes, [
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
  ]);
});

test("a scope binds to one brain once, and a binding can move to another brain or scope", () => {
  let record = putBinding(personalBrain(), "alice", { brain: "acme-personal", scope: "personal:U1" }, change);
  refused(
    () => putBinding(record, "alice-again", { brain: "acme-personal", scope: "personal:U1" }, change),
    409,
    /already bound to brain acme-personal by binding alice/,
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
  assert.notEqual(memberBrainId("U2"), ALICE_BRAIN);
  for (const scope of ["personal", "personal:U2"])
    refused(() => putBinding(record, "other", { brain: ALICE_BRAIN, scope }, change), 400, /only their own/);
  refused(() => aliceBrain(record, { owner: "U2" }), 400, /takes only url, clientId, label, timeoutMs, not owner/);
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

test("a member's brain needs a public https url, whoever writes it", () => {
  for (const url of [
    "http://brain.alice.example/mcp",
    "https://10.0.0.5/mcp",
    "https://127.0.0.1:3131/mcp",
    "https://[::1]/mcp",
    "https://169.254.169.254/latest",
  ])
    refused(() => aliceBrain(EMPTY_MEMORY_REGISTRY, { url }), 400, /public https:\/\/ url/);
  refused(() => putBrain(aliceBrain(), ALICE_BRAIN, { url: "http://localhost:3131/mcp" }, change), 400, /public https/);
  assert.equal(
    personalBrain(EMPTY_MEMORY_REGISTRY, { url: "http://localhost:3131/mcp" }).brains[0]!.url,
    "http://localhost:3131/mcp",
  );
});

test("the org switch stops members' brains and refuses new ones, and leaves org brains serving", () => {
  let record = putBinding(
    aliceBrain(personalBrain()),
    "everyone",
    { brain: "acme-personal", scope: "personal" },
    change,
  );
  record = putBrain(record, ALICE_BRAIN, { clientSecret: "alice-secret" }, change);
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
  refused(() => aliceBrain(off), 403, /turned off/);
  refused(
    () => putMemberBrain(off, "U2", { url: "https://brain.bob.example/mcp", clientId: "b" }, change),
    403,
    /turned off/,
  );
  assert.deepEqual(serving(setMemberBrains(off, { enabled: true })).config.routes.length, 2);
  refused(() => setMemberBrains(record, { enabled: "no" }), 400, /true or false/);
});

test("only an org admin, or the brain's own active member while the switch is on, may set a brain's secret", () => {
  const record = aliceBrain(personalBrain());
  const alice = record.brains.find(({ id }) => id === ALICE_BRAIN)!;
  const org = record.brains.find(({ id }) => id === "acme-personal")!;
  assert.equal(brainRefusal(record, alice, "U1", "member"), undefined);
  assert.equal(brainRefusal(record, alice, "admin-alice", "admin"), undefined);
  assert.equal(brainRefusal(record, org, "admin-alice", "admin"), undefined);
  for (const [brain, who, standing] of [
    [alice, "U2", "member"],
    [alice, "U1", "inactive"],
    [org, "U1", "member"],
  ] as const)
    assert.match(brainRefusal(record, brain, who, standing) ?? "", /only an org admin or the brain's owner/);
  assert.match(brainRefusal(setMemberBrains(record, { enabled: false }), alice, "U1", "member") ?? "", /turned off/);
});
