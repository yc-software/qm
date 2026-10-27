import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import {
  createProviderSandbox,
  type SandboxDriver,
  type StoredSandboxRecord,
} from "../../src/sandbox/provider-sandbox.ts";
import type { SandboxBodies } from "../../src/sandbox/sandbox-bodies.ts";
import { tenant, tenantFor, withTenant } from "../../src/tenant.ts";
import { scopeId } from "../../src/types.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";

function memoryBodies(): SandboxBodies<StoredSandboxRecord> {
  const rows = new Map<string, StoredSandboxRecord>();
  const merge = async (scope: string, patch: Partial<StoredSandboxRecord>): Promise<void> => {
    rows.set(scope, { ...rows.get(scope), ...patch });
  };
  return {
    get: async (scope) => rows.get(scope) ?? null,
    delete: async (scope) => rows.delete(scope),
    entries: async () => [...rows.entries()],
    update: merge,
    upsert: merge,
  };
}

function recordingDriver(): { driver: SandboxDriver; created: string[] } {
  const created: string[] = [];
  const live = new Set<string>();
  const driver: SandboxDriver = {
    backend: "fake",
    homeDir: "/home/fake",
    os: "fake",
    egressEnforcement: "none",
    exec: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }),
    writeAbsBytes: async () => {},
    readAbsBytes: async () => null,
    inspect: async (name) => (live.has(name) ? { state: "running", detail: name } : null),
    create: async (name) => {
      created.push(name);
      live.add(name);
    },
    resume: async () => {},
    destroy: async (name) => {
      live.delete(name);
    },
    isLive: (name) => live.has(name),
  };
  return { driver, created };
}

test("the same scope under two tenants provisions two machines named by each tenant's prefix", async () => {
  const { driver, created } = recordingDriver();
  const sandbox = createProviderSandbox(
    createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "provider-ws-"))),
    driver,
    {
      advisoryLock: createNoopAdvisoryLock(),
      tenantConfig: () => ({ sandboxNamePrefix: `qm-${tenant().slug ?? "home"}` }),
    },
    memoryBodies(),
  );
  const scope = scopeId("personal", "shared@example.com");
  const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
  const a = tenantFor("org-a", randomUUID(), "a");
  const b = tenantFor("org-b", randomUUID(), "b");

  const handleA = await withTenant(a, () => sandbox.provision(layers));
  const handleB = await withTenant(b, () => sandbox.provision(layers));

  assert.notEqual(handleA.id, handleB.id);
  assert.match(handleA.id, /^qm-a-/);
  assert.match(handleB.id, /^qm-b-/);
  assert.deepEqual(created, [handleA.id, handleB.id]);
  assert.equal(
    withTenant(a, () => sandbox.nameFor(scope)),
    handleA.id,
  );
  assert.equal(
    withTenant(b, () => sandbox.nameFor(scope)),
    handleB.id,
  );
  assert.equal(sandbox.scopeFor(handleA.id), scope);
  assert.equal(sandbox.scopeFor(handleB.id), scope);
});
