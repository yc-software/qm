import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withTenant } from "../src/tenants/context.ts";
import { createTenantSettingsStore, TenantSettingMissingError } from "../src/tenants/settings.ts";
import {
  tenantCredential,
  tenantDefaultSandboxBackend,
  tenantSandboxBackends,
  tenantSdkClient,
} from "../src/sandbox/tenant-credentials.ts";
import { createSmolmachinesSandbox } from "../src/sandbox/smolmachines-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

interface FakeClient {
  readonly nativePause?: boolean;
  create(name: string): Promise<string>;
  list(): AsyncIterable<string>;
}

async function twoTenants() {
  const store = createTenantSettingsStore({ harness: "pi" });
  const a = randomUUID();
  const b = randomUUID();
  const none = randomUUID();
  await withTenant(a, () => store.update({ SANDBOX_BACKEND: "e2b", E2B_API_KEY: "key-a" }));
  await withTenant(b, () => store.update({ SANDBOX_BACKEND: "sprites", E2B_API_KEY: "key-b", SPRITES_TOKEN: "tok-b" }));
  await withTenant(none, () => store.update({ SANDBOX_BACKEND: "e2b" }));
  return { store, a, b, none };
}

function recordingClient(store: ReturnType<typeof createTenantSettingsStore>) {
  const made: string[] = [];
  const used: Array<[string, string]> = [];
  const client = tenantSdkClient<FakeClient>({
    settings: () => store.get(),
    keys: ["E2B_API_KEY"],
    make: (apiKey) => {
      made.push(apiKey);
      return {
        create: async (name) => {
          used.push([apiKey, name]);
          return `${apiKey}:${name}`;
        },
        async *list() {
          yield apiKey;
        },
      };
    },
    methods: { create: true },
    streams: { list: true },
    fixed: { nativePause: true },
  });
  return { client, made, used };
}

test("each tenant's provider calls use only that tenant's key, with one client per key", async () => {
  const { store, a, b } = await twoTenants();
  const { client, made, used } = recordingClient(store);
  assert.equal(client.nativePause, true);
  await Promise.all([
    withTenant(a, () => client.create("one")),
    withTenant(b, () => client.create("two")),
    withTenant(a, () => client.create("three")),
    withTenant(b, () => client.create("four")),
  ]);
  assert.deepEqual(used.toSorted(), [
    ["key-a", "one"],
    ["key-a", "three"],
    ["key-b", "four"],
    ["key-b", "two"],
  ]);
  assert.deepEqual(made.toSorted(), ["key-a", "key-b"]);
  const listed = await withTenant(b, async () => {
    const seen: string[] = [];
    for await (const key of client.list()) seen.push(key);
    return seen;
  });
  assert.deepEqual(listed, ["key-b"]);
});

test("a tenant without the provider key fails closed and no client is built", async () => {
  const { store, none } = await twoTenants();
  const { client, made, used } = recordingClient(store);
  await assert.rejects(
    withTenant(none, () => client.create("x")),
    (error: unknown) =>
      error instanceof TenantSettingMissingError &&
      error.message === "E2B_API_KEY is not set in this tenant's settings",
  );
  await assert.rejects(client.create("unbound"), /No tenant is bound/);
  assert.deepEqual(made, []);
  assert.deepEqual(used, []);
});

test("a fetch-based provider sends the bound tenant's token and fails closed without one", async () => {
  const { store, a, b, none } = await twoTenants();
  await withTenant(a, () => store.update({ SMOLMACHINES_TOKEN: "smol-a" }));
  await withTenant(b, () => store.update({ SMOLMACHINES_TOKEN: "smol-b" }));
  const seen: string[] = [];
  const sandbox = createSmolmachinesSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "smol-ws-"))), {
    store: createMemoryMap(),
    advisoryLock: createMemoryAdvisoryLock(),
    token: tenantCredential(() => store.get(), "SMOLMACHINES_TOKEN"),
    fetchImpl: async (_input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json([]);
    },
  });
  await withTenant(a, () => sandbox.destroyScope!("scope-a"));
  await withTenant(b, () => sandbox.destroyScope!("scope-b"));
  assert.ok(seen.length >= 2);
  assert.deepEqual([...new Set(seen)].toSorted(), ["Bearer smol-a", "Bearer smol-b"]);
  const before = seen.length;
  await assert.rejects(
    withTenant(none, () => sandbox.destroyScope!("scope-none")),
    TenantSettingMissingError,
  );
  assert.equal(seen.length, before);
});

test("the default backend and usable backends come from the bound tenant's settings", async () => {
  const { store, a, b, none } = await twoTenants();
  const constructed = ["local", "sprites", "e2b", "modal"] as const;
  const resolve = (tenant: string) =>
    withTenant(tenant, async () => {
      const settings = await store.get();
      return {
        usable: tenantSandboxBackends(settings, constructed),
        default: tenantDefaultSandboxBackend(settings, constructed),
      };
    });
  assert.deepEqual(await resolve(a), { usable: ["local", "e2b"], default: "e2b" });
  assert.deepEqual(await resolve(b), { usable: ["local", "sprites", "e2b"], default: "sprites" });
  await assert.rejects(resolve(none), /E2B_API_KEY is not set in this tenant's settings/);
  const unset = randomUUID();
  await assert.rejects(
    withTenant(unset, async () => tenantDefaultSandboxBackend(await store.get(), constructed)),
    (error: unknown) =>
      error instanceof TenantSettingMissingError &&
      error.message === "SANDBOX_BACKEND is not set in this tenant's settings",
  );
  const render = randomUUID();
  await withTenant(render, () =>
    store.update({ SANDBOX_BACKEND: "render", RENDER_SANDBOX_API_KEY: "k", RENDER_SANDBOX_WORKSPACE_ID: "w" }),
  );
  await assert.rejects(
    withTenant(render, async () => tenantDefaultSandboxBackend(await store.get(), constructed)),
    /sandbox backend unavailable: render/,
  );
});
