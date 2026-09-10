import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import {
  createLocalSandbox,
  localContainerName,
  localNetworkName,
  localVolumeName,
} from "../src/sandbox/local-sandbox.ts";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createSmolmachinesSandbox } from "../src/sandbox/smolmachines-sandbox.ts";
import { createAgent37Sandbox } from "../src/sandbox/agent37-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";

import { installFakeSmolmachines } from "./support/fake-smolmachines.ts";
import { installFakeAgent37 } from "./support/fake-agent37.ts";

const workspace = () => createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "destroy-scope-")));

test("Local scope deletion removes deterministic resources without provisioning, tolerates absence and propagates failures", async () => {
  const calls: string[][] = [];
  let fail = false;
  const sandbox = createLocalSandbox(workspace(), {
    dockerExec: async (args) => {
      calls.push(args);
      return { code: 1, stdout: "", stderr: fail ? "daemon unavailable" : "No such object" };
    },
  });
  await sandbox.destroyScope!("missing");
  assert.deepEqual(calls, [
    ["rm", "-f", localContainerName("missing")],
    ["network", "rm", localNetworkName(localContainerName("missing"))],
    ["volume", "rm", localVolumeName("missing")],
  ]);
  fail = true;
  await assert.rejects(sandbox.destroyScope!("missing"), /daemon unavailable/);
  assert.equal(calls.length, 4);
});

test("Sprites scope deletion sends only DELETE, retries provider errors, and accepts missing bodies", async () => {
  const calls: string[] = [];
  let status = 503;
  const sandbox = createSpritesSandbox(workspace(), {
    token: "test",
    fetchImpl: async (input, init) => {
      calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return new Response(null, { status });
    },
  });
  await assert.rejects(sandbox.destroyScope!("scope"), /503/);
  status = 204;
  await sandbox.destroyScope!("scope");
  status = 404;
  await sandbox.destroyScope!("scope");
  assert.deepEqual(calls, Array(3).fill(`DELETE /v1/sprites/${sandboxScopeName("qm", "scope")}`));
});

for (const [name, create, resource] of [
  ["Smolmachines", createSmolmachinesSandbox, "machines"],
  ["Agent37", createAgent37Sandbox, "instances"],
] as const) {
  test(`${name} scope deletion finds existing bodies without booting and propagates transient deletion errors`, async () => {
    const calls: string[] = [];
    let status = 503;
    let exists = true;
    const sandbox = create(workspace(), {
      token: "test",
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${init?.method} ${path}`);
        if (init?.method === "GET") {
          const rows = exists ? [{ id: "existing", name: sandboxScopeName("qm", "scope"), status: "stopped" }] : [];
          return Response.json(resource === "instances" ? { data: rows } : rows);
        }
        return new Response(null, { status });
      },
    });
    await assert.rejects(sandbox.destroyScope!("scope"), /503/);
    status = 204;
    await sandbox.destroyScope!("scope");
    exists = false;
    await sandbox.destroyScope!("scope");
    assert.deepEqual(calls, [
      `GET /v1/${resource}`,
      `DELETE /v1/${resource}/existing`,
      `GET /v1/${resource}`,
      `DELETE /v1/${resource}/existing`,
      `GET /v1/${resource}`,
    ]);
  });
}

test("Local deletion retries remaining disk cleanup after partial failure without creating a container", async () => {
  const calls: string[][] = [];
  let volumeBusy = true;
  const sandbox = createLocalSandbox(workspace(), {
    dockerExec: async (args) => {
      calls.push(args);
      return args[0] === "volume" && volumeBusy
        ? { code: 1, stdout: "", stderr: "volume is in use" }
        : { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(sandbox.destroyScope!("scope"), /volume is in use/);
  volumeBusy = false;
  await sandbox.destroyScope!("scope");
  assert.deepEqual(calls.slice(0, 3), calls.slice(3));
  assert.equal(calls.length, 6);
  assert.equal(calls.at(-1)?.at(-1), localVolumeName("scope"));
});

for (const [name, create, install] of [
  ["Smolmachines", createSmolmachinesSandbox, installFakeSmolmachines],
  ["Agent37", createAgent37Sandbox, installFakeAgent37],
] as const) {
  test(`${name} stale adapter deletes another adapter's replacement for the same scope`, async () => {
    const fake = install();
    try {
      const options = { token: "test-token", fetchImpl: fake.fetchImpl };
      const a = create(workspace(), options);
      const b = create(workspace(), options);
      const layers = [{ scopeId: "replaced", mountPath: "", mode: "rw" as const }];
      await a.provision(layers);
      await b.destroyScope!("replaced");
      await b.provision(layers);
      assert.equal(fake.names().length, 1);
      const callsBefore = fake.calls.length;
      await a.destroyScope!("replaced");
      assert.deepEqual(fake.names(), []);
      assert.deepEqual(
        fake.calls.slice(callsBefore).map((call) => call.method),
        ["GET", "DELETE"],
      );
      await a.destroyScope!("replaced");
      assert.deepEqual(fake.names(), []);
    } finally {
      fake.cleanup();
    }
  });
}
