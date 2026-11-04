import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { DurableByteStore } from "../src/files/durable-byte-store.ts";
import { liveBackends, tenantSandboxBackends, type SandboxBackendName } from "../src/sandbox/sandbox-routing.ts";
import {
  MODAL_TENANT_ENV,
  sandboxSettings,
  SPRITES_TENANT_ENV,
  tenantSandboxSettings,
  type SandboxSettings,
} from "../src/sandbox/sandbox-settings.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { withTenant } from "../src/tenants/context.ts";
import { replaceLoadedTenantSettings, type TenantSettings } from "../src/tenants/settings.ts";
import { perTenantInstance } from "../src/tenants/tenant-instances.ts";
import { tenantByteStore, tenantStorage, type StorageTarget } from "../src/tenants/tenant-storage.ts";

const a = randomUUID();
const b = randomUUID();
const plain = randomUUID();

function load(): void {
  replaceLoadedTenantSettings(
    new Map<string, TenantSettings>([
      [
        a,
        {
          env: {
            SPRITES_TOKEN: "sprites-a",
            SPRITES_NAME_PREFIX: "ta",
            MODAL_TOKEN_ID: "modal-id-a",
            MODAL_TOKEN_SECRET: "modal-secret-a",
            MODAL_NAME_PREFIX: "ma",
            MODAL_SNAPSHOT_S3_BUCKET: "modal-snapshots-a",
            S3_BUCKET: "bucket-a",
          },
        },
      ],
      [b, { env: { SPRITES_TOKEN: "sprites-b", SPRITES_NAME_PREFIX: "tb", S3_BUCKET: "bucket-b", S3_PREFIX: "b/" } }],
      [plain, {}],
    ]),
  );
}

afterEach(() => replaceLoadedTenantSettings(new Map()));

const accounts = new Map<string, string[]>();

function fakeSandbox(
  backend: string,
  token: string,
  prefix: string,
  settings: SandboxSettings,
): Sandbox & {
  settings: SandboxSettings;
} {
  return {
    settings,
    profile: { backend, writablePersistence: "resident_disk", processSessions: false },
    async provision(scope) {
      const names = accounts.get(token) ?? [];
      names.push(`${prefix}-${scope}`);
      accounts.set(token, names);
      return { id: `${prefix}-${scope}`, rootDir: "/workspace" };
    },
    async run() {
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async writeFileBytes() {},
    async readFileBytes() {
      return null;
    },
    async listDir() {
      return accounts.get(token) ?? [];
    },
    async removeDir() {},
    async teardown() {},
  };
}

function backendsFixture() {
  accounts.clear();
  const config = sandboxSettings({
    SANDBOX_BACKEND: "sprites",
    SPRITES_TOKEN: "sprites-deployment",
    SPRITES_NAME_PREFIX: "dep",
    EGRESS_PROXY_URL: "https://egress.invalid",
    SPRITES_SNAPSHOT_S3_BUCKET: "snapshots",
    MODAL_TOKEN_ID: "modal-id-deployment",
    MODAL_TOKEN_SECRET: "modal-secret-deployment",
    MODAL_SNAPSHOT_S3_BUCKET: "modal-snapshots-deployment",
  });
  const built: Array<SandboxSettings> = [];
  const build = {
    sprites: (s: SandboxSettings) => {
      built.push(s);
      return fakeSandbox("sprites", s.spritesSandbox.token ?? "", s.spritesSandbox.namePrefix ?? "qm", s);
    },
    modal: (s: SandboxSettings) => {
      built.push(s);
      return fakeSandbox("modal", s.modalSandbox.tokenId ?? "", s.modalSandbox.namePrefix ?? "qm", s);
    },
  };
  const deployment: Partial<Record<SandboxBackendName, Sandbox>> = {
    sprites: build.sprites(config),
    modal: build.modal(config),
  };
  const tenantBackends = perTenantInstance([...SPRITES_TENANT_ENV, ...MODAL_TENANT_ENV], (env) =>
    tenantSandboxBackends(deployment, tenantSandboxSettings(config, env), env, build),
  );
  return { deployment, built, backends: liveBackends(() => tenantBackends() ?? deployment) };
}

async function provisionAndList(backends: Partial<Record<SandboxBackendName, Sandbox>>, scope: `personal:${string}`) {
  const sprites = backends.sprites;
  assert.ok(sprites);
  await sprites.provision(scope);
  return sprites.listDir({ id: "", rootDir: "/" }, "/");
}

describe("per-tenant sandbox providers", () => {
  it("creates and lists each tenant's sandboxes with its own credentials and name prefix", async () => {
    load();
    const { backends } = backendsFixture();
    const listedA = await withTenant(a, () => provisionAndList(backends, "personal:alice"));
    const listedB = await withTenant(b, () => provisionAndList(backends, "personal:bob"));
    assert.deepEqual(listedA, ["ta-personal:alice"]);
    assert.deepEqual(listedB, ["tb-personal:bob"]);
    assert.deepEqual(accounts.get("sprites-a"), ["ta-personal:alice"]);
    assert.deepEqual(accounts.get("sprites-b"), ["tb-personal:bob"]);
    assert.equal(accounts.get("sprites-deployment"), undefined);
  });

  it("never exposes another tenant's provider instance", () => {
    load();
    const { backends, deployment } = backendsFixture();
    const seenA = withTenant(a, () => Object.values(backends));
    const seenB = withTenant(b, () => Object.values(backends));
    const spritesA = withTenant(a, () => backends.sprites);
    const spritesB = withTenant(b, () => backends.sprites);
    assert.ok(spritesA && spritesB && deployment.sprites);
    assert.notEqual(spritesA, spritesB);
    assert.ok(!seenB.includes(spritesA));
    assert.ok(!seenA.includes(spritesB));
    assert.ok(!seenA.includes(deployment.sprites));
    assert.equal(
      withTenant(b, () => backends.modal),
      deployment.modal,
    );
  });

  it("builds a tenant's Modal client from its own token, environment and snapshot bucket", () => {
    load();
    const { backends, built } = backendsFixture();
    withTenant(a, () => backends.modal);
    const modal = built.at(-1)?.modalSandbox;
    assert.equal(modal?.tokenId, "modal-id-a");
    assert.equal(modal?.tokenSecret, "modal-secret-a");
    assert.equal(modal?.namePrefix, "ma");
    assert.equal(modal?.snapshotS3Bucket, "modal-snapshots-a");
  });

  it("keeps the deployment providers for tenants without settings and for unbound work", () => {
    load();
    const { backends, deployment, built } = backendsFixture();
    const before = built.length;
    assert.equal(
      withTenant(plain, () => backends.sprites),
      deployment.sprites,
    );
    assert.equal(backends.sprites, deployment.sprites);
    assert.deepEqual(Object.keys(backends).sort(), ["modal", "sprites"]);
    assert.equal(built.length, before);
  });

  it("builds a tenant's providers once and rebuilds them when its settings change", () => {
    load();
    const { backends } = backendsFixture();
    const first = withTenant(a, () => backends.sprites);
    assert.equal(
      withTenant(a, () => backends.sprites),
      first,
    );
    replaceLoadedTenantSettings(new Map([[a, { env: { SPRITES_TOKEN: "sprites-a2" } }]]));
    assert.notEqual(
      withTenant(a, () => backends.sprites),
      first,
    );
  });
});

describe("per-tenant storage bucket", () => {
  function recordingStore(target: StorageTarget, writes: string[]): DurableByteStore {
    return {
      async put() {
        writes.push(`${target.bucket}/${target.prefix ?? ""}`);
        return { blobKey: "k", sizeBytes: 0, sha256: "" };
      },
      async open() {
        return null;
      },
      async delete() {},
    };
  }

  it("reads and writes each tenant's objects in its own bucket and prefix", async () => {
    load();
    const writes: string[] = [];
    const store = tenantByteStore(
      tenantStorage({ bucket: "deployment", prefix: "qm/" }, (target) => recordingStore(target, writes)),
    );
    const put = () => store.put(Buffer.from("x"));
    await withTenant(a, put);
    await withTenant(b, put);
    await withTenant(plain, put);
    await put();
    assert.deepEqual(writes, ["bucket-a/qm/", "bucket-b/b/", "deployment/qm/", "deployment/qm/"]);
  });
});
