import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  EMPTY_MEMORY_REGISTRY,
  MemoryRegistryError,
  deleteBinding,
  deleteBrain,
  putBinding,
  putBrain,
  resolveMemoryRegistry,
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
