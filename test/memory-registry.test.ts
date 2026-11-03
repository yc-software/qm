import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_MEMORY_REGISTRY,
  MemoryRegistryError,
  deleteBrain,
  putBinding,
  putBrain,
  releaseBinding,
  resolveMemoryRegistry,
  type MemoryRegistry,
} from "../src/memory/registry.ts";

const change = { actor: "admin-alice", now: 1_762_128_000_000, overlayIds: new Set<string>() };
const org = { ...change, owner: "org:default-org" };

function refused(fn: () => unknown, status: number, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof MemoryRegistryError);
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

function companyBrain(record: MemoryRegistry = EMPTY_MEMORY_REGISTRY, id = "acme-scopes"): MemoryRegistry {
  return putBrain(
    record,
    id,
    {
      kind: "scopes",
      preset: "gbrain-v1",
      url: "https://Brain.Acme.example/mcp/",
      clientId: "qm-scopes",
      clientSecret: "scopes-secret",
      label: "Acme company brain",
      pool: [
        { source: "qm-proj-1", kinds: ["group"] },
        { source: "qm-eng", kinds: ["channel"] },
      ],
    },
    org,
  );
}

function personalBrain(record: MemoryRegistry = EMPTY_MEMORY_REGISTRY): MemoryRegistry {
  return putBrain(
    record,
    "acme-personal",
    {
      kind: "personal",
      preset: "gbrain-v1",
      url: "https://brain.acme.example/mcp",
      clientId: "qm-personal",
      clientSecret: "personal-secret",
      label: "Acme personal memory",
    },
    org,
  );
}

test("a pool source is claimed once: another scope can never take it, even after release", () => {
  let record = putBinding(
    companyBrain(),
    "proj-1",
    { brain: "acme-scopes", source: "qm-proj-1", scope: "group:web-project-1" },
    change,
  );
  refused(
    () =>
      putBinding(record, "proj-2", { brain: "acme-scopes", source: "qm-proj-1", scope: "group:web-project-2" }, change),
    409,
    /already claimed by another scope/,
  );
  record = releaseBinding(record, "proj-1", change);
  assert.equal(record.bindings[0]!.state, "released");
  refused(
    () =>
      putBinding(record, "proj-2", { brain: "acme-scopes", source: "qm-proj-1", scope: "group:web-project-2" }, change),
    409,
    /already claimed by another scope/,
  );
  refused(
    () =>
      putBinding(
        record,
        "proj-1b",
        { brain: "acme-scopes", source: "qm-proj-1", scope: "group:web-project-1" },
        change,
      ),
    409,
    /reserved for group:web-project-1 by binding proj-1/,
  );
  record = putBinding(record, "proj-1", {}, change);
  assert.equal(record.bindings.length, 1);
  assert.equal(record.bindings[0]!.state, "bound");
});

test("a hostile overwrite can't move a binding, or its source, to another scope or brain", () => {
  const record = putBinding(
    companyBrain(personalBrain()),
    "proj-1",
    { brain: "acme-scopes", source: "qm-proj-1", scope: "group:web-project-1" },
    change,
  );
  refused(() => putBinding(record, "proj-1", { scope: "group:web-project-2" }, change), 409, /can't change/);
  refused(() => putBinding(record, "proj-1", { source: "qm-eng" }, change), 409, /can't change/);
  const twin = companyBrain(record, "acme-scopes-2");
  refused(
    () =>
      putBinding(twin, "steal", { brain: "acme-scopes-2", source: "qm-proj-1", scope: "group:web-project-9" }, change),
    409,
    /already claimed/,
  );
});

test("a scope binds at most one source per brain, and kinds must match the pool", () => {
  const record = putBinding(
    putBrain(
      companyBrain(),
      "acme-scopes",
      {
        pool: [
          { source: "qm-proj-1", kinds: ["group"] },
          { source: "qm-proj-1b", kinds: ["group"] },
          { source: "qm-eng", kinds: ["channel"] },
        ],
      },
      org,
    ),
    "proj-1",
    { brain: "acme-scopes", source: "qm-proj-1", scope: "group:web-project-1" },
    change,
  );
  refused(
    () =>
      putBinding(
        record,
        "proj-1-again",
        { brain: "acme-scopes", source: "qm-proj-1b", scope: "group:web-project-1" },
        change,
      ),
    409,
    /already bound to brain acme-scopes by binding proj-1/,
  );
  refused(
    () => putBinding(record, "eng", { brain: "acme-scopes", source: "qm-eng", scope: "group:web-project-1" }, change),
    400,
    /pool source whose kinds include/,
  );
  refused(
    () => putBinding(record, "org-wide", { brain: "acme-scopes", source: "qm-eng", scope: "channel" }, change),
    400,
    /exact/,
  );
});

test("a personal brain binds personal scopes with no source, and must attest the member", () => {
  const record = personalBrain();
  refused(
    () => putBinding(record, "p", { brain: "acme-personal", scope: "group:web-project-1" }, change),
    400,
    /personal brain/,
  );
  refused(
    () => putBinding(record, "p", { brain: "acme-personal", scope: "personal:U1", source: "x" }, change),
    400,
    /no source/,
  );
  refused(() => putBrain(record, "acme-personal", { attestActor: false }, org), 400, /must attest the member/);
  const bound = putBinding(
    record,
    "everyone",
    { brain: "acme-personal", scope: "personal", capture: "explicit" },
    change,
  );
  assert.deepEqual(resolveMemoryRegistry(bound, new Set()).config.routes, [
    {
      provider: "acme-personal",
      scopes: ["personal"],
      capture: "explicit",
      recall: true,
      manage: false,
      label: "Acme personal memory",
      failOpen: true,
    },
  ]);
});

test("automatic capture is refused and the registry stops at 2,000 bindings", () => {
  const record = personalBrain();
  refused(
    () => putBinding(record, "p", { brain: "acme-personal", scope: "personal:U1", capture: "automatic" }, change),
    400,
    /automatic/,
  );
  const full: MemoryRegistry = {
    ...record,
    bindings: Array.from({ length: 2_000 }, (_, i) => ({
      id: `b${i}`,
      brain: "acme-personal",
      endpoint: record.brains[0]!.endpoint,
      scope: `personal:U${i}`,
      state: "released" as const,
      capture: "off" as const,
      recall: true,
      failOpen: true,
      label: "x",
      updatedAt: 0,
      updatedBy: "x",
    })),
  };
  refused(
    () => putBinding(full, "one-more", { brain: "acme-personal", scope: "personal:U9999" }, change),
    409,
    /at most 2000/,
  );
});

test("env provider ids are read-only and a stored collision disables the route", () => {
  const overlayIds = new Set(["gbrain"]);
  refused(
    () => putBrain(EMPTY_MEMORY_REGISTRY, "gbrain", { kind: "personal" }, { ...org, overlayIds }),
    409,
    /MEMORY_PROVIDER_CONFIG/,
  );
  const record = putBinding(personalBrain(), "p1", { brain: "acme-personal", scope: "personal:U1" }, change);
  const { config, disabled } = resolveMemoryRegistry(record, new Set(["acme-personal"]));
  assert.deepEqual(config.routes, []);
  assert.deepEqual(
    disabled.map(({ binding, code }) => [binding, code]),
    [["p1", "id_taken"]],
  );
});

test("the env validator's rules apply to registry brains", () => {
  refused(
    () =>
      putBrain(
        EMPTY_MEMORY_REGISTRY,
        "plain",
        { kind: "personal", preset: "gbrain-v1", url: "http://brain.example.com", clientId: "c", label: "x" },
        org,
      ),
    400,
    /must use HTTPS or a recognized private HTTP host/,
  );
  refused(
    () =>
      putBrain(
        EMPTY_MEMORY_REGISTRY,
        "x",
        { kind: "personal", preset: "gbrain-v9", url: "https://b.example", clientId: "c", label: "x" },
        org,
      ),
    400,
    /preset must be one of/,
  );
  refused(() => putBrain(EMPTY_MEMORY_REGISTRY, "default", {}, org), 400, /not be "default"/);
});

test("phase 1 records scope claims but serves only personal routes, with a reason for each disabled one", () => {
  let record = putBinding(
    companyBrain(personalBrain()),
    "proj-1",
    { brain: "acme-scopes", source: "qm-proj-1", scope: "group:web-project-1" },
    change,
  );
  record = putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change);
  record = putBrain(record, "acme-personal", { enabled: false }, org);
  const { config, disabled } = resolveMemoryRegistry(
    {
      ...record,
      brains: [...record.brains, { ...record.brains[0]!, id: "future", preset: "gbrain-v9" }],
      bindings: [...record.bindings, { ...record.bindings[1]!, id: "bob", brain: "future", scope: "personal:U2" }],
    },
    new Set(),
  );
  assert.deepEqual(config.routes, []);
  assert.deepEqual(
    disabled.map(({ binding, code }) => [binding, code]),
    [
      ["proj-1", "scope_recall_unsupported"],
      ["alice", "brain_off"],
      ["bob", "preset_unknown"],
    ],
  );
});

test("a brain's address is its identity: it can't move under bindings, and moving drops its secret", () => {
  let record = personalBrain();
  record = putBrain(record, "acme-personal", { url: "https://brain2.acme.example/mcp" }, org);
  assert.equal(record.brains[0]!.auth.clientSecret, undefined);
  assert.equal(record.brains[0]!.endpoint, "https://brain2.acme.example/mcp");
  record = putBrain(record, "acme-personal", { clientSecret: "again" }, org);
  record = putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change);
  refused(
    () => putBrain(record, "acme-personal", { url: "https://brain3.acme.example/mcp" }, org),
    409,
    /can't change/,
  );
  refused(() => deleteBrain(record, "acme-personal"), 409, /release it first/);
  record = deleteBrain(releaseBinding(record, "alice", change), "acme-personal");
  assert.deepEqual(record.brains, []);
  assert.equal(record.bindings.length, 1);
});

test("a pool source in use can't be dropped from the pool", () => {
  const record = putBinding(
    companyBrain(),
    "proj-1",
    { brain: "acme-scopes", source: "qm-proj-1", scope: "group:web-project-1" },
    change,
  );
  refused(
    () => putBrain(record, "acme-scopes", { pool: [{ source: "qm-eng", kinds: ["channel"] }] }, org),
    409,
    /release it before/,
  );
});
