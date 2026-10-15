import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FreestyleApiError, type Freestyle, type VmData } from "freestyle";
import { createFreestyleSandbox } from "../src/sandbox/freestyle-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";

function fakeFreestyle(options: { probeFailure?: boolean } = {}) {
  const machines = new Map<string, { data: VmData; files: Map<string, Uint8Array> }>();
  const created: Array<{ slug: string; snapshotId: string; ttlSeconds?: number; firewall: unknown }> = [];
  const commands: Array<{ slug: string; command: string; linuxUser?: string }> = [];
  let toolInstalled = false;
  const notFound = () => new FreestyleApiError(404, { code: "NOT_FOUND", message: "VM not found" });
  const get = (slug: string) => {
    const machine = machines.get(slug);
    if (!machine) throw notFound();
    return machine;
  };
  const ref = (slug: string) => ({
    data: async () => get(slug).data,
    start: async () => {
      get(slug).data.state = "running";
      return get(slug).data;
    },
    exec: async ({ command }: { command: string }) => {
      commands.push({ slug, command });
      if (command.includes("printf 'hello'")) return { stdout: "hello", stderr: "", statusCode: 0 };
      if (command.includes("timeout-me")) return { stdout: "", stderr: "", statusCode: null };
      if (command === "true" && options.probeFailure)
        return { stdout: "", stderr: "guest probe failed", statusCode: 17 };
      if (command.includes("mv -f ")) toolInstalled = true;
      if (command.includes("sha256sum -c --status"))
        return { stdout: "", stderr: "", statusCode: toolInstalled ? 0 : 1 };
      return { stdout: "", stderr: "", statusCode: 0 };
    },
    linuxUser: (linuxUser: string) => ({
      exec: async ({ command }: { command: string }) => {
        commands.push({ slug, command, linuxUser });
        return { stdout: "", stderr: "", statusCode: 0 };
      },
    }),
    fs: {
      writeFile: async (path: string, bytes: Uint8Array) => {
        get(slug).files.set(path, Uint8Array.from(bytes));
      },
      readFile: async (path: string) => {
        const bytes = get(slug).files.get(path);
        if (!bytes) throw notFound();
        return bytes;
      },
    },
  });
  const client = {
    vms: {
      ref,
      get: async (slug: string) => get(slug).data,
      delete: async (slug: string) => {
        if (!machines.delete(slug)) throw notFound();
      },
      create: async (options: { slug: string; snapshotId: string; ttlSeconds?: number; firewall: unknown }) => {
        created.push(options);
        const data = {
          id: `vm-${created.length}`,
          slug: options.slug,
          state: "running",
          resources: { cpu: 4, memory: 8192, storage: 32768 },
        } as VmData;
        machines.set(options.slug, { data, files: new Map() });
        return { vm: ref(options.slug), vmId: data.id, data, firewallRules: [], tlsRules: [] };
      },
    },
  } as unknown as Pick<Freestyle, "vms">;
  return { client, created, commands, machines };
}

test("Freestyle provides a persistent scope VM, command results, and writable binary files", async () => {
  const fake = fakeFreestyle();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "freestyle-ws-")));
  const layers = [{ scopeId: scopeId("personal", "tester"), mountPath: "/", mode: "rw" as const }];
  const make = () => createFreestyleSandbox(workspace, { client: fake.client, namePrefix: "qmt" });
  const sandbox = make();
  const first = await sandbox.provision(layers);
  assert.equal(first.coldStart, true);
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0]?.snapshotId, "freestyle/ubuntu");
  assert.deepEqual(fake.created[0]?.firewall, {
    rules: [{ action: "allow", source: {}, destination: { public: true } }],
  });

  const result = await sandbox.run(first, "printf 'hello'");
  assert.deepEqual(result, { stdout: "hello", stderr: "", code: 0, timedOut: false });
  assert.equal((await sandbox.run(first, "timeout-me")).timedOut, true);
  const bytes = Uint8Array.from([0, 1, 2, 255]);
  await sandbox.writeFileBytes(first, "nested/binary", bytes);
  assert.deepEqual(await sandbox.readFileBytes(first, "nested/binary"), bytes);
  assert.equal(await sandbox.readFile(first, "missing"), null);
  assert.ok(fake.commands.some((call) => call.linuxUser === "root" && call.command.includes("chown 1000:1000")));

  await sandbox.teardown(first);
  const resumed = await make().provision(layers);
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.coldStart, false);
  assert.equal(fake.created.length, 1);
  await make().destroyScope!(layers[0]!.scopeId);
  assert.equal(fake.machines.size, 0);
});

test("Freestyle recreates a scratch VM and deletes it when released", async () => {
  const fake = fakeFreestyle();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "freestyle-scratch-")));
  const sandbox = createFreestyleSandbox(workspace, { client: fake.client, namePrefix: "qmt" });
  const layers = [{ scopeId: scopeId("personal", "tester"), mountPath: "/", mode: "rw" as const }];
  const handle = await sandbox.provision(layers, { scratch: { key: "job" } });
  assert.equal(fake.created[0]?.ttlSeconds, 24 * 60 * 60);
  await sandbox.teardown(handle, { destroy: true });
  assert.equal(fake.machines.size, 0);
});

test("Freestyle installs deployment tools and uses valid slugs for arbitrary scope IDs", async () => {
  const fake = fakeFreestyle();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "freestyle-tools-")));
  const sandbox = createFreestyleSandbox(workspace, {
    client: fake.client,
    namePrefix: "QM_Alpha--Beta",
    extraTools: ["qm-test-tool"],
    layerToolFiles: () => [{ to: "/usr/local/bin/qm-test-tool", mode: "755", content: "#!/bin/sh\nprintf 'ok'\n" }],
  });
  const scope = scopeId("personal", "tester--x");
  const handle = await sandbox.provision([{ scopeId: scope, mountPath: "/", mode: "rw" }]);
  assert.match(handle.id, /^qm-alpha-beta-[a-z0-9-]+$/);
  assert.doesNotMatch(handle.id, /--/);
  assert.ok(fake.commands.some(({ command }) => command.includes("sudo sh -c") && command.includes("mv -f")));
  assert.ok(
    [...fake.machines.get(handle.id)!.files.keys()].some((path) =>
      path.startsWith("/usr/local/bin/qm-test-tool.staged-"),
    ),
  );
  const spec = sandbox.profile.spec;
  assert.ok(spec?.tools?.includes("qm-test-tool"));
  assert.ok(spec?.tools?.includes("aws (CLI v2)"));
  await sandbox.destroyScope!(scope);
  assert.equal(fake.machines.size, 0);
});

test("Freestyle stages a pinned AWS CLI v2 launcher without downloading during provision", async () => {
  const fake = fakeFreestyle();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "freestyle-aws-cli-")));
  const sandbox = createFreestyleSandbox(workspace, { client: fake.client, namePrefix: "qmt" });
  const scope = scopeId("personal", "tester");
  const handle = await sandbox.provision([{ scopeId: scope, mountPath: "/", mode: "rw" }]);
  const staged = [...fake.machines.get(handle.id)!.files.entries()].find(([path]) =>
    path.startsWith("/usr/local/bin/aws.staged-"),
  );
  assert.ok(staged);
  const launcher = Buffer.from(staged[1]).toString("utf8");
  assert.match(launcher, /awscli-exe-linux-/);
  assert.match(launcher, /sha256sum -c -/);
  assert.ok(fake.commands.every(({ command }) => !command.includes("awscli-exe-linux-")));
  await sandbox.destroyScope!(scope);
});

test("Freestyle status preserves guest probe failures", async () => {
  const fake = fakeFreestyle({ probeFailure: true });
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "freestyle-status-")));
  const sandbox = createFreestyleSandbox(workspace, { client: fake.client, namePrefix: "qmt" });
  const scope = scopeId("personal", "tester");
  await sandbox.provision([{ scopeId: scope, mountPath: "/", mode: "rw" }]);
  assert.ok(sandbox.computerStatus);
  const status = await sandbox.computerStatus(scope);
  assert.equal(status.guestResponsive, false);
  assert.match(status.probeError ?? "", /exit 17: guest probe failed/);
  await sandbox.destroyScope!(scope);
});
