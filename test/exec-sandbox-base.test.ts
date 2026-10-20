import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecRun, createHandleFileOps, prepareExecHandle } from "../src/sandbox/exec-sandbox-base.ts";
import { SandboxProvisionCleanupError } from "../src/sandbox/sandbox.ts";
import type { ExecResult, SandboxHandle, TeardownOptions } from "../src/sandbox/sandbox.ts";
import type { WorkspaceStore } from "../src/workspace/workspace-store.ts";
import { shq } from "../src/util/shell.ts";

const ok: ExecResult = { stdout: "", stderr: "", code: 0, timedOut: false };
const homeDir = "/home/t";
const workspaceDir = `${homeDir}/workspace`;

function fakeIo(overrides: { prepResult?: ExecResult; execImpl?: (script: string) => Promise<ExecResult> } = {}) {
  const calls: string[] = [];
  const files = new Map<string, Uint8Array>();
  const io = {
    workspace: {} as WorkspaceStore,
    label: "fake",
    homeDir,
    defaultTimeoutSec: 30,
    credentialPaths: [],
    exec: async (name: string, script: string, timeoutSec: number): Promise<ExecResult> => {
      calls.push(`exec ${name} ${timeoutSec} ${script}`);
      if (overrides.execImpl) return overrides.execImpl(script);
      return script.startsWith("mkdir -p") ? (overrides.prepResult ?? ok) : ok;
    },
    writeAbsBytes: async (name: string, abs: string, data: Uint8Array): Promise<void> => {
      calls.push(`write ${name} ${abs}`);
      files.set(abs, data);
    },
    readAbsBytes: async (name: string, abs: string): Promise<Uint8Array | null> => {
      calls.push(`read ${name} ${abs}`);
      return files.get(abs) ?? null;
    },
  };
  return { io, calls, files };
}

function owner(fail?: Error) {
  const teardowns: Array<{ handle: SandboxHandle; opts?: TeardownOptions }> = [];
  return {
    teardowns,
    async teardown(handle: SandboxHandle, opts?: TeardownOptions): Promise<void> {
      teardowns.push({ handle, ...(opts ? { opts } : {}) });
      if (fail) throw fail;
    },
  };
}

test("handle file ops resolve paths under the handle root and round-trip bytes and text", async () => {
  const { io, files } = fakeIo();
  const ops = createHandleFileOps(io);
  const handle: SandboxHandle = { id: "box", rootDir: workspaceDir };
  await ops.writeFile(handle, "notes/a.txt", "héllo");
  await ops.writeFileBytes(handle, "b.bin", new Uint8Array([0, 255, 7]));
  assert.deepEqual([...files.keys()], [`${workspaceDir}/notes/a.txt`, `${workspaceDir}/b.bin`]);
  assert.equal(await ops.readFile(handle, "notes/a.txt"), "héllo");
  assert.deepEqual([...(await ops.readFileBytes(handle, "b.bin"))!], [0, 255, 7]);
  assert.equal(await ops.readFile(handle, "missing"), null);
  assert.equal(await ops.readFileBytes(handle, "missing"), null);
});

test("prepare links credentials for resident handles, skips them for scratch, then installs layer tools", async () => {
  const { io, calls } = fakeIo();
  const installs: Array<string | undefined> = [];
  const prepIo = {
    ...io,
    installLayerTools: async (
      tool: { exec(script: string, t: number): Promise<{ code: number }> },
      prepare?: string,
    ): Promise<void> => {
      installs.push(prepare);
      await tool.exec("install-tools", 5);
    },
  };
  const resident = await prepareExecHandle(
    prepIo,
    [],
    { id: "res", coldStart: true, scratch: false },
    undefined,
    owner(),
  );
  assert.deepEqual(resident, { id: "res", rootDir: workspaceDir, homeDir, coldStart: true });
  assert.ok(calls[0]!.startsWith(`exec res 60 mkdir -p ${shq(workspaceDir)} && `));
  assert.equal(calls[1], "exec res 5 install-tools");
  assert.deepEqual(installs, [undefined]);

  calls.length = 0;
  const scratch = await prepareExecHandle(
    prepIo,
    [],
    { id: "tmp", coldStart: false, scratch: true },
    undefined,
    owner(),
  );
  assert.equal(scratch.scratch, true);
  assert.equal(calls[0], `exec tmp 60 mkdir -p ${shq(workspaceDir)}`);
});

test("combined layer-tool prep hands the prepare script to the installer instead of a separate exec", async () => {
  const { io, calls } = fakeIo();
  const installs: Array<string | undefined> = [];
  await prepareExecHandle(
    {
      ...io,
      combineLayerToolPrep: true,
      installLayerTools: async (_tool, prepare) => {
        installs.push(prepare);
      },
    },
    [],
    { id: "box", coldStart: false, scratch: true },
    undefined,
    owner(),
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(installs, [`mkdir -p ${shq(workspaceDir)}`]);
});

test("prepare drops turn proxy env and forces egress through the proxy only with a token", async () => {
  const { io } = fakeIo();
  const egress: string[] = [];
  const prepIo = {
    ...io,
    egressProxyUrl: "http://proxy.internal:8080",
    ensureEgress: async (name: string): Promise<void> => {
      egress.push(name);
    },
  };
  const env = { HTTPS_PROXY: "http://elsewhere", FOO: "bar" };
  const open = await prepareExecHandle(prepIo, [], { id: "a", coldStart: false, scratch: true }, { env }, owner());
  assert.deepEqual(open.env, { FOO: "bar" });
  assert.deepEqual(egress, []);
  const forced = await prepareExecHandle(
    prepIo,
    [],
    { id: "b", coldStart: false, scratch: true },
    { env, egressToken: "tok" },
    owner(),
  );
  assert.deepEqual(egress, ["b"]);
  assert.equal(forced.env?.FOO, "bar");
  assert.match(forced.env?.HTTPS_PROXY ?? "", /^http:\/\/x:tok@proxy\.internal:8080/);
});

test("failed prep is cleaned up through the owning provider's teardown", async () => {
  const failing = { stdout: "", stderr: "disk full\n", code: 1, timedOut: false };
  const { io } = fakeIo({ prepResult: failing });

  const resident = owner();
  await assert.rejects(
    prepareExecHandle(io, [], { id: "res", coldStart: false, scratch: false }, undefined, resident),
    /^Error: fake provision prep failed: disk full$/,
  );
  assert.deepEqual(resident.teardowns, [{ handle: { id: "res", rootDir: workspaceDir, homeDir, coldStart: false } }]);

  const scratch = owner();
  await assert.rejects(
    prepareExecHandle(io, [], { id: "tmp", coldStart: true, scratch: true }, undefined, scratch),
    /fake provision prep failed/,
  );
  assert.deepEqual(scratch.teardowns[0]?.opts, { destroy: true });
});

test("a scratch whose cleanup also fails surfaces both failures; a resident cleanup failure is swallowed", async () => {
  const failing = { stdout: "", stderr: "", code: 3, timedOut: false };
  const { io } = fakeIo({ prepResult: failing });
  const cleanupError = new Error("gone");
  const failure = await prepareExecHandle(
    io,
    [],
    { id: "tmp", coldStart: true, scratch: true },
    undefined,
    owner(cleanupError),
  ).then(
    () => assert.fail("prepare should fail"),
    (e: unknown) => e,
  );
  assert.ok(failure instanceof SandboxProvisionCleanupError);
  const [initError, reportedCleanup] = failure.errors as Error[];
  assert.equal(initError!.message, "fake provision prep failed: exit 3 with no output");
  assert.equal(reportedCleanup, cleanupError);
  assert.equal(failure.cause, cleanupError);
  assert.deepEqual(failure.handle, { id: "tmp", rootDir: workspaceDir, homeDir, coldStart: true, scratch: true });
  await assert.rejects(
    prepareExecHandle(io, [], { id: "res", coldStart: true, scratch: false }, undefined, owner(new Error("gone"))),
    /^Error: fake provision prep failed: exit 3 with no output$/,
  );
});

test("run exports handle env, enters the root and applies the default timeout", async () => {
  const { io, calls } = fakeIo();
  const run = createExecRun(io);
  await run({ id: "box", rootDir: workspaceDir, env: { A: "1 2" } }, "echo hi");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^exec box 30 /);
  assert.ok(calls[0]!.includes(`export A=${shq("1 2")}; cd ${workspaceDir} 2>/dev/null; echo hi`));
  calls.length = 0;
  await run({ id: "box", rootDir: workspaceDir }, "true", { timeoutMs: 1500 });
  assert.match(calls[0]!, /^exec box 2 /);
});

test("run refuses an already-aborted signal and kills the process group when aborted mid-flight", async () => {
  const handle: SandboxHandle = { id: "box", rootDir: workspaceDir };
  const { io, calls } = fakeIo();
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(createExecRun(io)(handle, "sleep 1", { signal: pre.signal }));
  assert.deepEqual(calls, []);

  let release!: (r: ExecResult) => void;
  const pending = new Promise<ExecResult>((resolve) => (release = resolve));
  const { io: slowIo, calls: slowCalls } = fakeIo({
    execImpl: (script) => (script.startsWith("exec setsid") ? pending : Promise.resolve(ok)),
  });
  const ac = new AbortController();
  const running = createExecRun(slowIo)(handle, "sleep 100", { signal: ac.signal });
  await new Promise((resolve) => setImmediate(resolve));
  ac.abort();
  release({ ...ok, code: 137 });
  assert.equal((await running).code, 137);
  assert.equal(slowCalls.length, 2);
  assert.match(slowCalls[0]!, /^exec box 30 exec setsid sh -c /);
  assert.match(slowCalls[1]!, /^exec box 15 i=0/);
});
