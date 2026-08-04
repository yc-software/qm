import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecProcessSessions, type ExecProcessIo, redactCommand } from "../src/sandbox/exec-process-session.ts";
import type { ExecResult, SandboxHandle } from "../src/sandbox/sandbox.ts";

function shellIo(home: string): ExecProcessIo {
  return {
    run(handle: SandboxHandle, command: string, opts): Promise<ExecResult> {
      return new Promise((resolve) => {
        const child = spawn(command, {
          shell: true,
          cwd: handle.rootDir,
          env: { ...process.env, HOME: home },
          timeout: opts?.timeoutMs ?? 30_000,
          killSignal: "SIGKILL",
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("close", (code, signal) =>
          resolve({ stdout, stderr, code: code ?? -1, timedOut: signal === "SIGKILL" }),
        );
      });
    },
  };
}

function fixture(): {
  proc: ReturnType<typeof createExecProcessSessions>;
  handle: SandboxHandle;
  io: ExecProcessIo;
  home: string;
} {
  const home = mkdtempSync(join(tmpdir(), "proc-home-"));
  const root = mkdtempSync(join(tmpdir(), "proc-root-"));
  const io = shellIo(home);
  return { proc: createExecProcessSessions(io), handle: { id: "t", rootDir: root }, io, home };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a started process is reattachable: cursor reads stream its output then exit", async () => {
  const { proc, handle } = fixture();
  const { processId } = await proc.startProcess(handle, "for i in 1 2 3; do echo line$i; sleep 0.05; done");

  let cursor = 0;
  let out = "";
  for (let i = 0; i < 20 && !out.includes("line3"); i++) {
    const r = await proc.readProcess(handle, processId, { sinceCursor: cursor, waitMs: 500 });
    cursor = r.cursor;
    out += r.chunks;
    if (r.status.state === "exited") break;
  }
  assert.match(out, /line1/);
  assert.match(out, /line2/);
  assert.match(out, /line3/);

  await sleep(100);
  const final = await proc.readProcess(handle, processId, { sinceCursor: cursor, waitMs: 1000 });
  assert.equal(final.status.state, "exited");
});

test("listProcesses reports the live session (command redacted)", async () => {
  const { proc, handle } = fixture();
  const { processId } = await proc.startProcess(handle, "sleep 2");
  const sessions = await proc.listProcesses(handle);
  const mine = sessions.find((s) => s.processId === processId);
  assert.ok(mine, "the started process should be listed");
  assert.equal(mine!.status.state, "running");
});

test("writeStdin feeds a reattached process's stdin", async () => {
  const { proc, handle } = fixture();
  const { processId } = await proc.startProcess(handle, "cat");
  await sleep(100);
  await proc.writeStdin(handle, processId, "hello-stdin\n");

  let out = "";
  for (let i = 0; i < 20 && !out.includes("hello-stdin"); i++) {
    const r = await proc.readProcess(handle, processId, { sinceCursor: 0, waitMs: 300 });
    out = r.chunks;
    await sleep(50);
  }
  assert.match(out, /hello-stdin/);
  await proc.signalProcess(handle, processId, "KILL");
});

test("signalProcess stops a long-running process", async () => {
  const { proc, handle, io, home } = fixture();
  const { processId } = await proc.startProcess(handle, "sleep 30");
  await sleep(150);

  const procDir = `${home}/.agent-proc/${processId}`;
  const aliveProbe = async (): Promise<boolean> => {
    const r = await io.run(
      handle,
      `pid=$(cat "${procDir}/pid"); if kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then echo ALIVE; else echo DEAD; fi`,
    );
    return r.stdout.includes("ALIVE");
  };
  assert.equal(await aliveProbe(), true, "the sleep process should be running before the signal");

  await proc.signalProcess(handle, processId, "TERM");

  let dead = false;
  for (let i = 0; i < 30 && !dead; i++) {
    if (!(await aliveProbe())) dead = true;
    else await sleep(100);
  }
  assert.equal(dead, true, "signalProcess(TERM) must terminate the running process");

  let state = "running";
  for (let i = 0; i < 30 && state === "running"; i++) {
    state = (await proc.readProcess(handle, processId, { sinceCursor: 0, maxBytes: 1 })).status.state;
    if (state === "running") await sleep(100);
  }
  assert.equal(state, "exited", "a TERM'd process must be recorded as exited (trap writes code), not stuck running");
});

test("signalProcess(KILL) records an exit even though the launcher trap can't catch SIGKILL", async () => {
  const { proc, handle } = fixture();
  const { processId } = await proc.startProcess(handle, "sleep 30");
  await sleep(150);
  await proc.signalProcess(handle, processId, "KILL");
  let state = "running";
  for (let i = 0; i < 30 && state === "running"; i++) {
    state = (await proc.readProcess(handle, processId, { sinceCursor: 0, maxBytes: 1 })).status.state;
    if (state === "running") await sleep(100);
  }
  assert.equal(state, "exited", "a KILL'd process must be recorded as exited via the signalProcess sentinel");
});

test("reading or writing an unknown process id is rejected", async () => {
  const { proc, handle } = fixture();
  const bogus = "00000000-0000-0000-0000-000000000000";
  await assert.rejects(proc.readProcess(handle, bogus), /no such process/);
  await assert.rejects(proc.writeStdin(handle, bogus, "x"), /writeStdin failed/);
});

test("redactCommand strips secret-bearing flags", () => {
  assert.match(redactCommand("gh auth login --with-token"), /--with-token/);
  assert.match(redactCommand("foo --token abcdef123"), /--token <redacted>/);
  assert.match(redactCommand("svc --client-secret=shh"), /<redacted>/);
});

test("redactCommand hides a token piped into --with-token", () => {
  for (const cmd of [
    "echo ghp_secretvalue12345 | gh auth login --with-token",
    'echo "ghp_secretvalue12345" | gh auth login --with-token',
    "printf ghp_secretvalue12345 | gh auth login --with-token",
    "echo -n ghp_secretvalue12345 | gh auth login --hostname x.test --with-token",
  ]) {
    const out = redactCommand(cmd);
    assert.ok(!out.includes("ghp_secretvalue12345"), `leaked in: ${out}`);
    assert.match(out, /<redacted>/);
    assert.match(out, /--with-token/);
  }
});

test("redactCommand masks known injected env values the pattern layer misses", () => {
  const env = { GITHUB_TOKEN: "ghp_secretvalue12345" };
  for (const cmd of [
    'export GITHUB_TOKEN="ghp_secretvalue12345"; gh api user',
    "curl -u me:ghp_secretvalue12345 https://api.github.com",
    'curl -H "Authorization: Bearer ghp_secretvalue12345" https://x.test',
  ]) {
    const out = redactCommand(cmd, env);
    assert.ok(!out.includes("ghp_secretvalue12345"), `leaked in: ${out}`);
    assert.match(out, /<redacted:GITHUB_TOKEN>/);
  }
  assert.ok(
    redactCommand("curl -u me:ghp_secretvalue12345 https://x.test").includes("ghp_secretvalue12345"),
    "without env the value layer has nothing to mask by",
  );
});

const readAll = async (
  proc: ReturnType<typeof createExecProcessSessions>,
  handle: SandboxHandle,
  processId: string,
): Promise<string> => {
  let out = "";
  for (let i = 0; i < 40; i++) {
    const r = await proc.readProcess(handle, processId, { sinceCursor: 0, waitMs: 500 });
    out = r.chunks;
    if (r.status.state === "exited") break;
  }
  return out;
};

test("a launched process gets the turn env off the handle, exactly like execute's run()", async () => {
  const { proc, handle } = fixture();
  const withEnv: SandboxHandle = {
    ...handle,
    env: { AGENT_API_URL: "https://core.test", AGENT_CREDENTIAL_TOKEN: "cap-token-abcdef123" },
  };
  const { processId } = await proc.startProcess(
    withEnv,
    `printf 'URL=%s TOKEN=%s\\n' "$AGENT_API_URL" "$AGENT_CREDENTIAL_TOKEN"`,
  );
  assert.match(await readAll(proc, withEnv, processId), /URL=https:\/\/core\.test TOKEN=cap-token-abcdef123/);
});

test("the env file is consumed at launch, leaving no turn secrets on the volume", async () => {
  const { proc, handle, io, home } = fixture();
  const withEnv: SandboxHandle = { ...handle, env: { AGENT_CREDENTIAL_TOKEN: "cap-token-abcdef123" } };
  const { processId } = await proc.startProcess(withEnv, `sleep 1; printf 'TOKEN=%s\\n' "$AGENT_CREDENTIAL_TOKEN"`);

  const envFile = `${home}/.agent-proc/${processId}/env`;
  let onDisk = "yes";
  for (let i = 0; i < 40 && onDisk === "yes"; i++) {
    onDisk = (await io.run(withEnv, `[ -f "${envFile}" ] && echo yes || echo no`)).stdout.trim();
    if (onDisk === "yes") await sleep(100);
  }
  assert.equal(onDisk, "no", "the launch env file must not survive on the volume");
  assert.match(await readAll(proc, withEnv, processId), /TOKEN=cap-token-abcdef123/);
});

test("caller-supplied env wins over the handle's on conflict", async () => {
  const { proc, handle } = fixture();
  const withEnv: SandboxHandle = { ...handle, env: { LANG: "C", SHARED_KEY: "from-handle" } };
  const { processId } = await proc.startProcess(withEnv, `printf '%s %s\\n' "$SHARED_KEY" "$LANG"`, {
    env: { SHARED_KEY: "from-caller" },
  });
  assert.match(await readAll(proc, withEnv, processId), /from-caller C/);
});

test("the turn env rides beside the command file, so listProcesses still shows the real command", async () => {
  const { proc, handle } = fixture();
  const withEnv: SandboxHandle = {
    ...handle,
    env: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`PADDING_VAR_${i}`, "x".repeat(80)])),
  };
  const { processId } = await proc.startProcess(withEnv, "sleep 2");
  const mine = (await proc.listProcesses(withEnv)).find((s) => s.processId === processId);
  assert.ok(mine);
  assert.equal(mine.command, "sleep 2");
  await proc.signalProcess(withEnv, processId, "KILL");
});

test("listProcesses masks handle.env secrets that appear in the command itself", async () => {
  const { proc, handle } = fixture();
  const secretEnv = { HTTPS_PROXY: "http://u:egresstoken99@[fdaa::1]:3128" };
  const withEnv: SandboxHandle = { ...handle, env: secretEnv };
  const { processId } = await proc.startProcess(withEnv, `echo hi ${secretEnv.HTTPS_PROXY}`, { env: secretEnv });
  await proc.readProcess(withEnv, processId, { sinceCursor: 0, waitMs: 2000 });
  const mine = (await proc.listProcesses(withEnv)).find((s) => s.processId === processId);
  assert.ok(mine);
  assert.ok(!mine.command.includes("egresstoken99"), `leaked in: ${mine.command}`);
  assert.match(mine.command, /<redacted:HTTPS_PROXY>/);
});

test("a session that predates the current boot is reported exited, not running forever", async () => {
  const { proc, handle, home } = fixture();
  const { processId } = await proc.startProcess(handle, "sleep 30");

  const before = await proc.listProcesses(handle);
  assert.deepEqual(before.find((s) => s.processId === processId)?.status, { state: "running" });

  writeFileSync(join(home, ".agent-proc", processId, "boot"), "a-previous-boot\n");

  const after = await proc.listProcesses(handle);
  assert.deepEqual(
    after.find((s) => s.processId === processId)?.status,
    { state: "exited", code: 137 },
    "a reboot kills the launcher before it can write code; status must not stay running",
  );
  const read = await proc.readProcess(handle, processId);
  assert.deepEqual(read.status, { state: "exited", code: 137 });
});

test("a session from the current boot keeps running, and one with no boot marker is left alone", async () => {
  const { proc, handle, home } = fixture();
  const live = await proc.startProcess(handle, "sleep 30");
  const legacy = await proc.startProcess(handle, "sleep 30");
  rmSync(join(home, ".agent-proc", legacy.processId, "boot"), { force: true });

  const sessions = await proc.listProcesses(handle);
  assert.deepEqual(sessions.find((s) => s.processId === live.processId)?.status, { state: "running" });
  assert.deepEqual(
    sessions.find((s) => s.processId === legacy.processId)?.status,
    { state: "running" },
    "sessions predating this change have no marker and must not be reaped on a guess",
  );
});
