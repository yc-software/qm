import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { SandboxResources } from "../src/sandbox/sandbox-resources.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { withTenant } from "../src/tenants/context.ts";
import { personalScope } from "../src/types.ts";
import { createLocalSandbox } from "../src/sandbox/local-sandbox.ts";

await bindBootTenant(async () => undefined);

const ran: string[] = [];
const backend = (name: string): Sandbox =>
  ({
    profile: { backend: name },
    run: async () => {
      ran.push(name);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  }) as unknown as Sandbox;

const router = createSandboxRouter({
  backends: { e2b: backend("e2b"), sprites: backend("sprites"), local: backend("local") },
  defaultBackend: "sprites",
  resources: {} as SandboxResources,
});

const handle = (name: string): SandboxHandle => ({ scopeId: personalScope("pat"), backend: name }) as SandboxHandle;

test("on a deployment shared by tenants, backends that cannot keep tenants apart are refused", async () => {
  const tenant = randomUUID();
  await withTenant(tenant, async () => {
    await assert.rejects(async () => router.run(handle("e2b"), "true"), /does not keep tenants apart/);
    for (const name of ["sprites", "local"]) await router.run(handle(name), "true");
  });
  await assert.rejects(async () => router.run(handle("e2b"), "true"), /does not keep tenants apart/);
  await assert.rejects(createLocalSandbox().provision("unbound"), /needs a bound tenant/);
  assert.deepEqual(ran, ["sprites", "local"]);
});
