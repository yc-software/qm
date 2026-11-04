import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionSyscalls, sessionContextOf } from "../src/sessions/session-syscalls.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { prepareChildWorkdir } from "../src/sessions/child-isolation.ts";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { createSandboxResources, type SandboxDefault, type SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { shq } from "../src/util/shell.ts";
import {
  scopeId,
  type ChildIsolation,
  type Conversation,
  type Principal,
  type ScopeId,
  type Session,
} from "../src/types.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "./support/test-database.ts";

const actor: Principal = { id: "alice", type: "internal", displayName: "Alice" };
const scope: ScopeId = scopeId("personal", "alice");
const conversation: Conversation = { kind: "dm", threadRef: "web:dm:alice", audience: [actor] };

async function syscallsRig() {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const factory = createSessionSyscalls({
    mailbox: createSessionMailbox(testMap<SessionMessage>()),
    sessions,
    runs,
    signals: createPostgresRunSignalStore(testDatabaseUrl()),
    advisoryLock: testAdvisoryLock(),
    maxAttempts: 3,
  });
  const room = await sessions.getOrCreateByThread(conversation.threadRef, "dm", scope, undefined, "web", undefined, {
    context: sessionContextOf({ origin: { kind: "human" }, surface: "web", text: "", actor, conversation }),
  });
  await sessions.addParticipant(room.id, actor.id);
  const syscallsFor = (session: Session) =>
    factory.forTurn({ session, scopeId: scope, request: { surface: "web", conversation, actor } });
  const child = async (id: string): Promise<Session> => {
    const session = await sessions.get(id);
    assert.ok(session);
    return session;
  };
  const taskText = async (session: Session): Promise<string> => {
    const [run] = await runs.inFlightForThread(session.threadRef);
    assert.ok(run);
    return run.request.text;
  };
  return { room, syscallsFor, child, taskText };
}

async function openChild(
  rig: Awaited<ReturnType<typeof syscallsRig>>,
  parent: Session,
  input: Parameters<ReturnType<ReturnType<typeof createSessionSyscalls>["forTurn"]>["open"]>[0],
): Promise<Session> {
  const opened = await rig.syscallsFor(parent).open(input);
  assert.ok(opened.ok, opened.ok ? "" : opened.message);
  return rig.child(opened.sessionId);
}

test("a top-level parent's children share its computer unless told otherwise", async () => {
  const rig = await syscallsRig();
  for (const isolation of [undefined, "shared" as const]) {
    const child = await openChild(rig, rig.room, { task: "look around", ...(isolation ? { isolation } : {}) });
    assert.equal(child.spawnMeta?.isolation, undefined);
    assert.doesNotMatch(await rig.taskText(child), /omit sandbox_id/);
  }
  const listed = await rig.syscallsFor(rig.room).read({});
  assert.ok(listed.ok && listed.mode === "children");
  assert.deepEqual(
    listed.children.map((c) => c.isolation),
    [undefined, undefined],
  );
});

test("worktree isolation gives each child its own directory and branch, named in its brief and in read", async () => {
  const rig = await syscallsRig();
  const first = await openChild(rig, rig.room, {
    task: "fix the flaky test",
    name: "Fix flaky test",
    isolation: "worktree",
  });
  const second = await openChild(rig, rig.room, {
    task: "fix the flaky test",
    name: "Fix flaky test",
    isolation: "worktree",
  });
  const a = first.spawnMeta?.isolation;
  const b = second.spawnMeta?.isolation;
  assert.equal(a?.mode, "worktree");
  assert.match(a?.workdir ?? "", /^subagents\/fix-flaky-test-[0-9a-f]{8}$/);
  assert.equal(a?.branch, `subagent/${a?.workdir?.slice("subagents/".length)}`);
  assert.equal(a?.base, undefined);
  assert.notEqual(a?.workdir, b?.workdir);
  const brief = await rig.taskText(first);
  assert.ok(brief.includes(`start in your own directory, ${a?.workdir} in the workspace`));
  assert.ok(brief.includes(`branch ${a?.branch} if the workspace root is a git repository`));
  const listed = await rig.syscallsFor(rig.room).read({});
  assert.ok(listed.ok && listed.mode === "children");
  assert.deepEqual(listed.children.map((c) => c.isolation?.workdir).sort(), [a?.workdir, b?.workdir].sort());
});

test("sandbox isolation reserves a sandbox named by the child's own id; open replays keep it", async () => {
  const rig = await syscallsRig();
  const syscalls = rig.syscallsFor(rig.room);
  const opened = await syscalls.open({ requestId: "r1", task: "run the dev server", isolation: "sandbox" });
  assert.ok(opened.ok);
  assert.deepEqual(opened.isolation, { mode: "sandbox", sandboxId: opened.sessionId });
  const replay = await syscalls.open({ requestId: "r1", task: "run the dev server", isolation: "sandbox" });
  assert.ok(replay.ok);
  assert.equal(replay.sessionId, opened.sessionId);
  assert.deepEqual(replay.isolation, opened.isolation);
  const child = await rig.child(opened.sessionId);
  assert.match(
    await rig.taskText(child),
    new RegExp(`run on your own sandbox, ${opened.sessionId}, created the first time`),
  );
});

test("children without a computer get no isolation", async () => {
  const rig = await syscallsRig();
  const child = await openChild(rig, rig.room, { task: "summarize", readOnly: true, isolation: "sandbox" });
  assert.equal(child.spawnMeta?.isolation, undefined);
});

test("grandchildren default from their parent's placement", async () => {
  const rig = await syscallsRig();
  const worker = await openChild(rig, rig.room, { task: "lead the refactor", isolation: "worktree" });
  const workdir = worker.spawnMeta?.isolation?.workdir;
  assert.ok(workdir);
  const nested = await openChild(rig, worker, { task: "split the module" });
  assert.equal(nested.spawnMeta?.isolation?.mode, "worktree");
  assert.equal(nested.spawnMeta?.isolation?.base, workdir);
  assert.notEqual(nested.spawnMeta?.isolation?.workdir, workdir);
  const helper = await openChild(rig, worker, { task: "run the linter", isolation: "shared" });
  assert.deepEqual(helper.spawnMeta?.isolation, { mode: "shared", workdir });

  const boxed = await openChild(rig, rig.room, { task: "own box", isolation: "sandbox" });
  const sharer = await openChild(rig, boxed, { task: "use the box" });
  assert.deepEqual(sharer.spawnMeta?.isolation, { mode: "shared", sandboxId: boxed.id });
  const branched = await openChild(rig, boxed, { task: "branch on the box", isolation: "worktree" });
  assert.equal(branched.spawnMeta?.isolation?.sandboxId, boxed.id);
  assert.match(branched.spawnMeta?.isolation?.workdir ?? "", /^subagents\//);
});

function sh(cwd: string, command: string) {
  const out = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });
  return { stdout: out.stdout, stderr: out.stderr, code: out.status ?? 1, timedOut: false };
}

function localDisk() {
  const root = mkdtempSync(join(tmpdir(), "child-isolation-"));
  const destroyed: string[] = [];
  const created: string[] = [];
  const backend: Sandbox = {
    profile: { backend: "local", writablePersistence: "resident_disk", processSessions: false },
    async provision(id) {
      const rootDir = join(root, id, "workspace");
      if (!existsSync(rootDir)) created.push(id);
      mkdirSync(rootDir, { recursive: true });
      return { id, rootDir };
    },
    async run(handle, command) {
      return sh(handle.rootDir, `cd ${shq(handle.rootDir)} 2>/dev/null; ${command}`);
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async readFileBytes() {
      return null;
    },
    async writeFileBytes() {},
    async listDir() {
      return [];
    },
    async removeDir() {},
    async teardown() {},
    async destroyScope(id) {
      destroyed.push(id);
      rmSync(join(root, id), { recursive: true, force: true });
    },
    async computerStatus(id) {
      return { machine: id, guestResponsive: true, provisioned: false };
    },
  };
  return { root, backend, destroyed, created };
}

const workdirOf = (handle: SandboxHandle, isolation: ChildIsolation) => join(handle.rootDir, isolation.workdir ?? "");

test("a worktree child's directory becomes a git worktree on its own branch when the base is a git repository", async () => {
  const { backend } = localDisk();
  const handle = await backend.provision("box");
  const repo = join(handle.rootDir, "repo");
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const isolation: ChildIsolation = {
    mode: "worktree",
    workdir: "subagents/fix-1",
    branch: "subagent/fix-1",
    base: "repo",
  };
  await prepareChildWorkdir(backend, handle, isolation);
  const dir = workdirOf(handle, isolation);
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "subagent/fix-1");
  assert.ok(existsSync(join(dir, "README.md")));
  writeFileSync(join(dir, "work.txt"), "kept\n");
  await prepareChildWorkdir(backend, handle, isolation);
  assert.ok(existsSync(join(dir, "work.txt")));
  rmSync(dir, { recursive: true, force: true });
  await prepareChildWorkdir(backend, handle, isolation);
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "subagent/fix-1");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

test("a worktree child outside a git repository gets an empty directory, and a blocked path is reported", async () => {
  const { backend } = localDisk();
  const handle = await backend.provision("box");
  const isolation: ChildIsolation = { mode: "worktree", workdir: "subagents/notes-1", branch: "subagent/notes-1" };
  await prepareChildWorkdir(backend, handle, isolation);
  assert.deepEqual(readdirSync(workdirOf(handle, isolation)), []);
  const other = await backend.provision("blocked");
  writeFileSync(join(other.rootDir, "subagents"), "a file where the directory should be");
  await assert.rejects(
    prepareChildWorkdir(backend, other, isolation),
    /could not prepare this subagent's directory subagents\/notes-1/,
  );
});

function turnRig() {
  const disk = localDisk();
  const records = testMap<SandboxResource>();
  const resources = createSandboxResources({
    records,
    defaults: testMap<SandboxDefault>(),
    backends: { local: disk.backend },
    defaultBackend: "local",
    lock: testAdvisoryLock(),
    canUseScope: async (who, owner) => owner === `personal:${who}`,
  });
  const router = createSandboxRouter({ backends: { local: disk.backend }, defaultBackend: "local", resources });
  const turn = (session: Session) => {
    const sandboxes = createTurnSandboxes({
      deps: { sandbox: router, sandboxResources: resources },
      input: { origin: { kind: "human" } },
      actor,
      session,
      resolution: { writableScopeId: scope, readOnlyScopeIds: [] },
      scopeId: scope,
      memoryScopeId: scope,
      transferId: "t",
      swarmSandboxId: undefined,
      turnSessionDir: "turn/s",
      turnFilesDir: "turn/s/t",
      connectorEnv: {},
      egressTokenForTurn: undefined,
      visibleSkillsForTurn: async () => [],
    } as unknown as TurnSandboxContext);
    const tools = createToolContext({
      sandbox: router,
      sandboxResources: resources,
      provision: sandboxes.provision,
      provisionResource: sandboxes.provisionResource,
      accessSandboxResource: sandboxes.accessResource,
      boundSandboxId: sandboxes.boundSandboxId,
      workdir: sandboxes.workdir,
      writableScopeId: scope,
      readOnlyScopeIds: [],
      commandPolicy: () => ({ mode: "denylist", rules: [] }),
      authorizeCommand: () => true,
      grantedHandles: [],
      deploy: {} as never,
      acl: {} as never,
      createdBy: actor.id,
      backgroundBroker: {
        async start(handle, command) {
          const out = await router.run(handle, command);
          return { processId: "job", output: out.stdout, cursor: 0, status: { state: "running" }, reattached: false };
        },
        async poll(_handle, processId) {
          return { processId, chunks: "", cursor: 0, status: { state: "running" } };
        },
        async stop(_handle, processId) {
          return { processId, status: { state: "exited", code: 0 }, stopped: true };
        },
        async write(_handle, processId) {
          return { processId, bytes: 0, status: { state: "running" } };
        },
        async list() {
          return [];
        },
      },
    });
    return { sandboxes, tools };
  };
  const session = (id: string, isolation?: ChildIsolation): Session => ({
    id,
    type: "dm",
    scopeId: scope,
    threadRef: `subagent:${id}`,
    createdAt: 0,
    title: "dev server",
    ...(isolation
      ? { spawnMeta: { surface: "web", conversation, actor, isolation } }
      : { spawnMeta: { surface: "web", conversation, actor } }),
  });
  return { ...disk, resources, records, router, turn, session };
}

test("a sandbox-isolated child's commands run on its own computer, created once and kept across turns", async () => {
  const rig = turnRig();
  const shared = await rig.resources.create(actor.id, scope, "local", "scope default");
  await rig.resources.setDefault(actor.id, scope, shared.id);
  const childId = "11111111-2222-4333-8444-555555555555";
  const child = rig.session(childId, { mode: "sandbox", sandboxId: childId });

  const first = rig.turn(child);
  const ran = await first.tools.execute("pwd");
  assert.equal(ran.stdout.trim(), join(rig.root, `sandbox-${childId}`, "workspace"));
  assert.equal((await first.tools.computerStatus()).machine, `sandbox-${childId}`);
  await first.sandboxes.reclaimBox();
  const own = await rig.resources.get(childId);
  assert.equal(own.state, "ready");
  assert.equal(own.name, "dev server");

  const second = rig.turn(child);
  await second.tools.execute("true");
  await second.sandboxes.reclaimBox();
  assert.deepEqual(
    rig.created.filter((id) => id === `sandbox-${childId}`),
    [`sandbox-${childId}`],
  );

  const parentTurn = rig.turn(rig.session("parent"));
  assert.equal(
    (await parentTurn.tools.execute("pwd")).stdout.trim(),
    join(rig.root, `sandbox-${shared.id}`, "workspace"),
  );
  await parentTurn.sandboxes.reclaimBox();

  await rig.resources.retire(actor.id, childId);
  await rig.resources.retire(actor.id, childId);
  assert.deepEqual(rig.destroyed, [`sandbox-${childId}`]);
  assert.equal((await rig.resources.get(shared.id)).state, "ready");
  await assert.rejects(
    rig.turn(child).tools.execute("true"),
    /sandbox 11111111-2222-4333-8444-555555555555 has been retired/,
  );
});

test("a worktree child's commands and background jobs start in its directory unless sandbox_id is given", async () => {
  const rig = turnRig();
  const shared = await rig.resources.create(actor.id, scope, "local", "scope default");
  await rig.resources.setDefault(actor.id, scope, shared.id);
  const isolation: ChildIsolation = { mode: "worktree", workdir: "subagents/web-1", branch: "subagent/web-1" };
  const { tools, sandboxes } = rig.turn(rig.session("worker", isolation));
  const workspace = join(rig.root, `sandbox-${shared.id}`, "workspace");
  assert.equal((await tools.execute("pwd")).stdout.trim(), join(workspace, "subagents/web-1"));
  assert.equal(
    (await tools.backgroundStart("pwd", { purpose: "checking" })).output.trim(),
    join(workspace, "subagents/web-1"),
  );
  assert.equal((await tools.execute("pwd", { sandboxId: shared.id })).stdout.trim(), workspace);
  await sandboxes.reclaimBox();
  assert.equal(sandboxes.boundSandboxId, undefined);
});

test("a child never adopts a sandbox from another scope as its own", async () => {
  const rig = turnRig();
  const foreign = await rig.resources.create("bob", scopeId("personal", "bob"), "local", "bob's box");
  const child = rig.session("intruder", { mode: "shared", sandboxId: foreign.id });
  await assert.rejects(rig.turn(child).tools.execute("true"), /belongs to another scope/);
  assert.equal((await rig.resources.get(foreign.id)).state, "ready");
});
