import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostSandbox, hostWorkspaceDirectory } from "../src/sandbox/host-sandbox.ts";
import { copyHome } from "../src/sandbox/sandbox-migrate.ts";
import { scopeId, type WorkspaceLayer } from "../src/types.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";

const layers = (id: string): WorkspaceLayer[] => [{ scopeId: id, mountPath: "", mode: "rw" }];

async function hostSandbox(options: { rootDir?: string; workspacesRoot?: string }) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "qm-host-store-"));
  return { sandbox: createHostSandbox(createLocalWorkspaceStore(workspaceRoot), options), workspaceRoot };
}

test("host sandbox assigns separate workspace, home, and tmp directories per environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-host-workspaces-"));
  const { sandbox } = await hostSandbox({ workspacesRoot: root });
  const project = scopeId("group", "web-project-p001");
  const first = await sandbox.provision(layers(project));
  const second = await sandbox.provision(layers(scopeId("group", "web-project-p002")));

  const realRoot = await realpath(root);
  assert.equal(first.rootDir, join(realRoot, "project-p001", "workspace"));
  assert.equal(first.homeDir, join(realRoot, "project-p001", "home"));
  assert.equal(first.env?.TMPDIR, join(realRoot, "project-p001", "tmp"));
  assert.notEqual(first.rootDir, second.rootDir);

  await sandbox.writeFile(first, "shared/from-tool.txt", "first");
  await sandbox.writeFile(second, "shared/from-tool.txt", "second");
  assert.equal(await readFile(join(first.rootDir, "shared/from-tool.txt"), "utf8"), "first");
  assert.equal(await readFile(join(second.rootDir, "shared/from-tool.txt"), "utf8"), "second");
  const result = await sandbox.run(first, 'pwd; printf "%s\\n%s" "$HOME" "$TMPDIR"');
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout.trim().split("\n"), [first.rootDir, first.homeDir, first.env?.TMPDIR]);
});

test("host workspace directory names are stable and safe", () => {
  assert.equal(hostWorkspaceDirectory("group:web-project-p001"), "project-p001");
  assert.equal(hostWorkspaceDirectory("channel:C123"), "channel-C123");
  assert.equal(hostWorkspaceDirectory("custom:/unsafe"), hostWorkspaceDirectory("custom:/unsafe"));
  assert.doesNotMatch(hostWorkspaceDirectory("custom:/unsafe"), /[/:]/);
});

test("host sandbox rejects relative and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-host-workspaces-"));
  const outside = await mkdtemp(join(tmpdir(), "qm-host-outside-"));
  const { sandbox } = await hostSandbox({ workspacesRoot: root });
  const handle = await sandbox.provision(layers("group:web-project-p001"));
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(outside, join(handle.rootDir, "escape"));
  await symlink(join(outside, "secret.txt"), join(handle.rootDir, "linked-secret.txt"));
  await symlink(join(outside, "created.txt"), join(handle.rootDir, "dangling-secret.txt"));

  await assert.rejects(sandbox.readFile(handle, "../secret.txt"), /escapes/);
  await assert.rejects(sandbox.readFile(handle, "escape/secret.txt"), /symlink/);
  await assert.rejects(sandbox.writeFile(handle, "escape/new.txt", "no"), /symlink/);
  await assert.rejects(sandbox.writeFile(handle, "linked-secret.txt", "no"), /symlink/);
  await assert.rejects(sandbox.writeFile(handle, "dangling-secret.txt", "no"), /symlink/);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside");
  await assert.rejects(sandbox.removeDir(handle, "."), /refusing/);
});

test("legacy host root keeps one shared workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-host-root-"));
  const { sandbox } = await hostSandbox({ rootDir: root });
  const first = await sandbox.provision(layers("group:web-project-p001"));
  const second = await sandbox.provision(layers("group:web-project-p002"));
  const realRoot = await realpath(root);
  assert.equal(first.rootDir, realRoot);
  assert.equal(second.rootDir, realRoot);
  assert.equal(first.homeDir, join(realRoot, "data", "host-home"));
});

test("host sandbox background processes stay inside their environment directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-host-workspaces-"));
  const { sandbox } = await hostSandbox({ workspacesRoot: root });
  const handle = await sandbox.provision(layers("group:web-project-p001"));
  assert.ok(sandbox.startProcess && sandbox.readProcess);
  const { processId } = await sandbox.startProcess(handle, "pwd; printf background > shared.txt");
  let poll = await sandbox.readProcess(handle, processId, { waitMs: 2_000 });
  if (poll.status.state === "running") poll = await sandbox.readProcess(handle, processId, { waitMs: 2_000 });
  assert.deepEqual(poll.status, { state: "exited", code: 0 });
  assert.match(poll.chunks, new RegExp(handle.rootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await readFile(join(handle.rootDir, "shared.txt"), "utf8"), "background");
});

test("host sandbox rejects an environment directory symlink outside the configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-host-workspaces-"));
  const outside = await mkdtemp(join(tmpdir(), "qm-host-outside-"));
  const { sandbox } = await hostSandbox({ workspacesRoot: root });
  await symlink(outside, join(root, "channel-C1"));
  await assert.rejects(sandbox.provision(layers("channel:C1")), /cannot be a symlink/);
});

test("host sandbox materializes read-only workspace layers", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-host-workspaces-"));
  const { sandbox, workspaceRoot } = await hostSandbox({ workspacesRoot: root });
  const workspace = createLocalWorkspaceStore(workspaceRoot);
  const org = scopeId("org", "default-org");
  await mkdir(workspace.scopeDir(org), { recursive: true });
  await writeFile(join(workspace.scopeDir(org), "policy.txt"), "shared policy");
  const handle = await sandbox.provision([
    { scopeId: org, mountPath: "global", mode: "ro" },
    ...layers("group:web-project-p001"),
  ]);
  assert.equal(await sandbox.readFile(handle, "global/policy.txt"), "shared policy");
});

test("host sandbox home migration uses workspace-relative transfer files", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "qm-host-source-"));
  const destinationRoot = await mkdtemp(join(tmpdir(), "qm-host-destination-"));
  const { sandbox: source } = await hostSandbox({ workspacesRoot: sourceRoot });
  const { sandbox: destination } = await hostSandbox({ workspacesRoot: destinationRoot });
  const sourceHandle = await source.provision(layers("group:web-project-p001"));
  const destinationHandle = await destination.provision(layers("group:web-project-p001"));
  await writeFile(join(sourceHandle.homeDir!, "state.txt"), "migrated");
  const result = await copyHome({
    fromSandbox: source,
    fromHandle: sourceHandle,
    fromHome: sourceHandle.homeDir!,
    toSandbox: destination,
    toHandle: destinationHandle,
    toHome: destinationHandle.homeDir!,
  });
  assert.equal(result.sourceFiles, 1);
  assert.equal(result.destFiles, 1);
  assert.equal(await readFile(join(destinationHandle.homeDir!, "state.txt"), "utf8"), "migrated");
});
