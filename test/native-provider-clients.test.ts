import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createE2bSandbox } from "../src/sandbox/e2b-sandbox.ts";
import { createModalSandbox } from "../src/sandbox/modal-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createSdkModalClient,
  modalEgressAllowlist,
  MODAL_EXEC_GRACE_MS,
  MODAL_MAX_EXEC_ARG_BYTES,
} from "../src/sandbox/modal-client.ts";
import {
  createSdkE2bClient,
  e2bEgressNetwork,
  E2B_EXEC_MARGIN_MS,
  E2bCommandLostError,
  E2bSandboxGoneError,
} from "../src/sandbox/e2b-client.ts";

const modalCalls: unknown[][] = [];
const modalCreateParams: Record<string, unknown>[] = [];
const modalExecs: { args: string[]; params: Record<string, unknown> }[] = [];
const modalWrites: { path: string; bytes: number }[] = [];
const modalRunning = new Map<string, boolean>();
class SandboxFilesystemFileTooLargeError extends Error {
  override name = "SandboxFilesystemFileTooLargeError";
}
const modalSandbox = {
  sandboxId: "sb-native",
  async exec(args: string[], params: Record<string, unknown>) {
    if (typeof params.timeoutMs === "number" && params.timeoutMs % 1000 !== 0)
      throw new Error(`timeoutMs must be a multiple of 1000ms, got ${params.timeoutMs}`);
    modalExecs.push({ args, params });
    return { stdout: { readText: async () => "ok" }, stderr: { readText: async () => "" }, wait: async () => 0 };
  },
  filesystem: {
    async writeBytes(data: Uint8Array, path: string) {
      modalWrites.push({ path, bytes: data.byteLength });
    },
    async readBytes(path: string) {
      if (path.endsWith("huge.bin")) throw new SandboxFilesystemFileTooLargeError("file too large");
      return new Uint8Array([1]);
    },
  },
  async snapshotDirectory(path: string, options: unknown) {
    modalCalls.push(["snapshot", path, options]);
    return { imageId: "im-native" };
  },
  async mountImage(path: string, image: unknown) {
    modalCalls.push(["mount", path, image]);
  },
};
mock.module("modal", {
  namedExports: {
    ModalClient: class {
      apps = { fromName: async () => ({ appId: "ap-1" }) };
      images = { fromRegistry: () => ({}), fromId: async (imageId: string) => ({ imageId }) };
      sandboxes = {
        create: async (_app: unknown, _image: unknown, params: Record<string, unknown>) => {
          modalCreateParams.push(params);
          return modalSandbox;
        },
        list: async function* (params: { appId?: string; tags?: Record<string, string> }) {
          modalCalls.push(["list", params]);
          for (const [sandboxId, running] of modalRunning) yield { sandboxId, poll: async () => (running ? null : 0) };
        },
      };
    },
  },
});

const e2bCalls: unknown[][] = [];
let pauseError: Error | undefined;
let startError: Error | undefined;
let onDispatch: ((command: string) => void) | undefined;
let waitError: Error | undefined;
class FakeSandboxError extends Error {}
class FakeNotFoundError extends FakeSandboxError {}
class FakeSandboxNotFoundError extends FakeNotFoundError {}
class FakeFileNotFoundError extends FakeNotFoundError {}
class FakeTimeoutError extends FakeSandboxError {}
class FakeCommandExitError extends FakeSandboxError {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  constructor(exitCode: number, stdout: string, stderr: string) {
    super(`exit ${exitCode}`);
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}
const fakeE2bSandbox = (sandboxId: string) => ({
  sandboxId,
  async setTimeout(ms: number) {
    e2bCalls.push(["setTimeout", ms]);
  },
  async updateNetwork(network: unknown) {
    e2bCalls.push(["updateNetwork", network]);
  },
  commands: {
    async run(cmd: string, options: { background?: boolean }) {
      e2bCalls.push(["run", cmd, options]);
      if (options?.background !== true) throw new Error("the client must start commands in the background");
      onDispatch?.(cmd);
      if (startError) throw startError;
      return {
        pid: 7,
        async wait() {
          if (waitError) throw waitError;
          return { exitCode: 0, stdout: "ran", stderr: "" };
        },
      };
    },
  },
  files: {
    async read(path: string) {
      e2bCalls.push(["read", path]);
      throw new FakeFileNotFoundError(`${path} not found`);
    },
  },
  async pause(options: unknown) {
    e2bCalls.push(["pause", options]);
    if (pauseError) throw pauseError;
    return false;
  },
  async createSnapshot(options: unknown) {
    e2bCalls.push(["createSnapshot", options]);
    return { snapshotId: "snap-native", names: [] };
  },
  async getMetrics() {
    return [
      { timestamp: new Date(0), cpuUsedPct: 1, cpuCount: 2, memUsed: 1, memTotal: 2, diskUsed: 3, diskTotal: 4 },
      {
        timestamp: new Date(1),
        cpuUsedPct: 12.5,
        cpuCount: 2,
        memUsed: 2 ** 30,
        memTotal: 2 ** 31,
        diskUsed: 2 ** 30,
        diskTotal: 20 * 2 ** 30,
      },
    ];
  },
});
mock.module("e2b", {
  namedExports: {
    SandboxError: FakeSandboxError,
    NotFoundError: FakeNotFoundError,
    SandboxNotFoundError: FakeSandboxNotFoundError,
    FileNotFoundError: FakeFileNotFoundError,
    TimeoutError: FakeTimeoutError,
    CommandExitError: FakeCommandExitError,
    Sandbox: class {
      static list() {
        return { hasNext: false, nextItems: async () => [] };
      }
      static async create(template: string, options: unknown) {
        e2bCalls.push(["create", template, options]);
        return fakeE2bSandbox("e2b-native");
      }
      static async connect(sandboxId: string, options: unknown) {
        e2bCalls.push(["connect", sandboxId, options]);
        return fakeE2bSandbox(sandboxId);
      }
      static async getInfo() {
        e2bCalls.push(["info"]);
        return {
          state: "paused",
          endAt: new Date(1000),
          lifecycle: { onTimeout: "pause" },
          cpuCount: 2,
          memoryMB: 512,
        };
      }
      static async deleteSnapshot(snapshotId: string) {
        e2bCalls.push(["deleteSnapshot", snapshotId]);
        return true;
      }
    },
  },
});

test("Modal native directory snapshot has a ten-minute timeout, finite retention, and restores the exact image", async () => {
  const client = createSdkModalClient({
    tokenId: "id",
    tokenSecret: "secret",
    appName: "test",
    image: "ubuntu",
    snapshotRetentionMs: 60_000,
  });
  const session = await client.create({ name: "test" });
  const before = Date.now();
  const snapshot = await session.snapshotHome!();
  assert.deepEqual(modalCalls[0], ["snapshot", "/root", { ttlMs: 60_000, timeoutMs: 600_000 }]);
  assert.ok(snapshot.expiresAtMs >= before + 60_000);
  await session.restoreHome!(snapshot.imageId);
  assert.deepEqual(modalCalls[1], ["mount", "/root", { imageId: "im-native" }]);
  assert.equal(client.lifetimeMs, 24 * 3600_000);
});

test("Modal exec deadlines are whole seconds with a single grace margin, even near a snapshot deadline", async () => {
  const client = createSdkModalClient({ tokenId: "id", tokenSecret: "secret", appName: "test", image: "ubuntu" });
  const session = await client.create({});
  modalExecs.length = 0;
  await session.runCommand("wc -c < /root/.qm-home.tar", { timeoutMs: 12_345 });
  await session.runCommand("true", { timeoutMs: 7 });
  await session.runCommand("true");
  assert.deepEqual(
    modalExecs.map((call) => call.params.timeoutMs),
    [13_000 + MODAL_EXEC_GRACE_MS, 1000 + MODAL_EXEC_GRACE_MS, 3600_000 + MODAL_EXEC_GRACE_MS],
  );
  assert.deepEqual(modalExecs[0]!.args, ["timeout", "13", "sh", "-c", "wc -c < /root/.qm-home.tar"]);
});

test("Modal passes command env through exec and spools oversized commands through the filesystem", async () => {
  const client = createSdkModalClient({ tokenId: "id", tokenSecret: "secret", appName: "test", image: "ubuntu" });
  const session = await client.create({});
  modalExecs.length = 0;
  modalWrites.length = 0;
  await session.runCommand("echo $SECRET_TOKEN", { env: { SECRET_TOKEN: "s3cret" } });
  assert.deepEqual(modalExecs[0]!.params.env, { SECRET_TOKEN: "s3cret" });
  assert.ok(!modalExecs[0]!.args[2]!.includes("s3cret"));
  await session.runCommand("true", { env: {} });
  assert.equal("env" in modalExecs[1]!.params, false);
  const huge = `printf '%s' '${"A".repeat(MODAL_MAX_EXEC_ARG_BYTES)}' | base64 -d`;
  await session.runCommand(huge);
  assert.equal(modalWrites.length, 1);
  assert.equal(modalWrites[0]!.bytes, Buffer.byteLength(huge));
  assert.match(modalWrites[0]!.path, /^\/tmp\/\.qm-exec-[0-9a-f-]{36}\.sh$/);
  assert.equal(
    modalExecs[2]!.args[2],
    `timeout 3600 sh ${modalWrites[0]!.path}; rc=$?; rm -f ${modalWrites[0]!.path}; exit $rc`,
  );
  assert.ok(Buffer.byteLength(modalExecs[2]!.args[2]!) < MODAL_MAX_EXEC_ARG_BYTES);
});

test("Modal creates sandboxes with a real reservation, an idle backstop, tags and the egress allowlist", async () => {
  modalCreateParams.length = 0;
  const bare = createSdkModalClient({ tokenId: "id", tokenSecret: "secret", appName: "test", image: "ubuntu" });
  await bare.create({ name: "qm-scope", tags: { "qm-kind": "scope" } });
  assert.deepEqual(modalCreateParams[0], {
    name: "qm-scope",
    tags: { "qm-kind": "scope" },
    timeoutMs: 24 * 3600_000,
    idleTimeoutMs: 12 * 3600_000,
    cpu: 1,
    memoryMiB: 2048,
  });
  const tuned = createSdkModalClient({
    tokenId: "id",
    tokenSecret: "secret",
    appName: "test",
    image: "ubuntu",
    cpus: 4,
    memoryMb: 8192,
    regions: ["us-west-2"],
    idleTimeoutMs: 6 * 3600_000 + 1,
    egressProxyUrl: "https://egress.example.com",
  });
  await tuned.create({});
  assert.deepEqual(modalCreateParams[1], {
    timeoutMs: 24 * 3600_000,
    idleTimeoutMs: 6 * 3600_000 + 1000,
    cpu: 4,
    memoryMiB: 8192,
    regions: ["us-west-2"],
    outboundDomainAllowlist: ["egress.example.com"],
  });
  assert.deepEqual(modalEgressAllowlist("http://10.1.2.3:3128"), { outboundCidrAllowlist: ["10.1.2.3/32"] });
  assert.deepEqual(modalEgressAllowlist("http://[2001:db8::1]:3128"), { outboundCidrAllowlist: ["2001:db8::1/128"] });
  assert.throws(() => modalEgressAllowlist("http://egress.example.com:3128"), /https URL on port 443/);
  assert.throws(() => modalEgressAllowlist("https://egress.example.com:8443"), /https URL on port 443/);
});

test("Modal lists running tagged sandboxes within the app and reports oversized reads clearly", async () => {
  const client = createSdkModalClient({ tokenId: "id", tokenSecret: "secret", appName: "test", image: "ubuntu" });
  modalRunning.set("sb-live", true);
  modalRunning.set("sb-done", false);
  modalCalls.length = 0;
  const ids: string[] = [];
  for await (const id of client.listRunning!({ "qm-kind": "scope" })) ids.push(id);
  assert.deepEqual(ids, ["sb-live"]);
  assert.deepEqual(modalCalls[0], ["list", { appId: "ap-1", tags: { "qm-kind": "scope" } }]);
  const session = await client.create({});
  assert.deepEqual(await session.readFileBytes("/root/small.bin"), new Uint8Array([1]));
  await assert.rejects(session.readFileBytes("/root/huge.bin"), /exceeds Modal's filesystem read limit/);
});

test("Modal rejects invalid checkpoint retention", () => {
  for (const snapshotRetentionMs of [0, -1, Infinity, NaN]) {
    assert.throws(
      () =>
        createSdkModalClient({
          tokenId: "id",
          tokenSecret: "secret",
          appName: "test",
          image: "ubuntu",
          snapshotRetentionMs,
        }),
      /positive finite/,
    );
  }
});

test("E2B sends explicit pause lifecycle, reads state without connect, and surfaces failed pause", async () => {
  e2bCalls.length = 0;
  const client = createSdkE2bClient({ apiKey: "test" });
  const session = await client.create({ metadata: { name: "test" }, autoPause: true });
  const createOpts = e2bCalls[0]![2] as { lifecycle: unknown; timeoutMs: number; network?: unknown };
  assert.deepEqual(createOpts.lifecycle, { onTimeout: "pause", autoResume: false });
  assert.equal(createOpts.timeoutMs, 3600_000 + E2B_EXEC_MARGIN_MS, "default TTL covers the longest command");
  assert.equal(createOpts.network, undefined, "no egress proxy means no network rules");
  const info = await client.info!(session.sandboxId);
  assert.equal(info.state, "paused");
  assert.equal(info.cpuCount, 2);
  assert.equal(info.memoryMb, 512);
  await session.pause();
  assert.deepEqual(e2bCalls.at(-1), ["pause", { keepMemory: true }]);
  pauseError = new Error("snapshot backlog");
  await assert.rejects(session.pause(), /snapshot backlog/);
  pauseError = undefined;
  await client.create({ metadata: {}, autoPause: false });
  assert.deepEqual((e2bCalls.at(-1)![2] as { lifecycle: unknown }).lifecycle, { onTimeout: "kill", autoResume: false });
});

test("E2B extends the sandbox timeout only when a command outlives the remaining lifetime, capped by the plan", async () => {
  e2bCalls.length = 0;
  const client = createSdkE2bClient({ apiKey: "test", sandboxTtlMs: 120_000 });
  const session = await client.create({ metadata: {}, autoPause: true });
  await session.runCommand("echo short", { timeoutMs: 1_000 });
  assert.equal(e2bCalls.filter((c) => c[0] === "setTimeout").length, 0, "a short command fits the TTL");
  await session.runCommand("sleep long", { timeoutMs: 600_000 });
  assert.deepEqual(
    e2bCalls.filter((c) => c[0] === "setTimeout"),
    [["setTimeout", 600_000 + E2B_EXEC_MARGIN_MS]],
  );
  await session.runCommand("echo again", { timeoutMs: 1_000 });
  assert.equal(e2bCalls.filter((c) => c[0] === "setTimeout").length, 1, "the extension covers later short commands");
  await session.keepAlive(30_000);
  const kept = e2bCalls.filter((c) => c[0] === "setTimeout").at(-1)![1] as number;
  assert.ok(kept > 600_000, `keepAlive never shortens a lifetime already covering a command (${kept})`);

  e2bCalls.length = 0;
  const hobby = createSdkE2bClient({ apiKey: "test", maxLifetimeMs: 3600_000 });
  const capped = await hobby.create({ metadata: {}, autoPause: true });
  assert.equal((e2bCalls[0]![2] as { timeoutMs: number }).timeoutMs, 3600_000, "TTL never exceeds the plan cap");
  await capped.runCommand("sleep", { timeoutMs: 3600_000 });
  await capped.keepAlive(7200_000);
  const caps = e2bCalls.filter((c) => c[0] === "setTimeout").map((c) => c[1]);
  assert.ok(caps.length >= 1, "the keep-warm request beyond the cap still extends to the cap");
  assert.ok(
    caps.every((ms) => ms === 3600_000),
    `every extension is capped at the plan maximum (${caps.join(",")})`,
  );
  assert.throws(() => createSdkE2bClient({ apiKey: "test", maxLifetimeMs: 0 }), /above 60000/);
});

test("E2B refuses to re-run a command lost mid-flight and classifies gone sandboxes by SDK error class", async () => {
  const client = createSdkE2bClient({ apiKey: "test" });
  const session = await client.create({ metadata: {}, autoPause: true });
  startError = new FakeSandboxNotFoundError("Sandbox is probably not running anymore");
  const beforeDispatch = e2bCalls.filter(([kind]) => kind === "run").length;
  await assert.rejects(session.runCommand("echo"), E2bCommandLostError);
  assert.equal(e2bCalls.filter(([kind]) => kind === "run").length, beforeDispatch + 1);
  startError = new Error("upstream returned 410: resource not found");
  await assert.rejects(
    session.runCommand("echo"),
    (e: Error) => !(e instanceof E2bSandboxGoneError) && /410/.test(e.message),
  );
  startError = undefined;
  waitError = new FakeTimeoutError(
    "connection terminated: The sandbox was killed or reached its end of life while the request was in flight.",
  );
  await assert.rejects(session.runCommand("echo"), E2bCommandLostError);
  waitError = new FakeSandboxNotFoundError("Sandbox is probably not running anymore");
  await assert.rejects(session.runCommand("echo"), E2bCommandLostError);
  waitError = new FakeTimeoutError("deadline exceeded: This error is likely due to exceeding 'timeoutMs'");
  await assert.rejects(
    session.runCommand("echo"),
    (e: Error) => e instanceof FakeTimeoutError && !(e instanceof E2bCommandLostError),
    "a command deadline is neither a lost sandbox nor a gone one",
  );
  waitError = new FakeCommandExitError(3, "out", "err");
  assert.deepEqual(await session.runCommand("exit 3"), { stdout: "out", stderr: "err", exitCode: 3 });
  waitError = undefined;
  assert.deepEqual(await session.runCommand("echo"), { stdout: "ran", stderr: "", exitCode: 0 });
  assert.equal(await session.readFileBytes("/home/user/missing"), null, "a missing file is null, not a gone sandbox");
});

test("E2B turns the egress proxy into host-level network rules on create and on reconnect", async () => {
  e2bCalls.length = 0;
  const client = createSdkE2bClient({ apiKey: "test", egressProxyUrl: "https://egress.example.com" });
  const rules = { allowOut: ["egress.example.com"], denyOut: ["0.0.0.0/0"] };
  await client.create({ metadata: {}, autoPause: true });
  assert.deepEqual((e2bCalls.at(-1)![2] as { network: unknown }).network, rules);
  await client.connect("e2b-native");
  assert.deepEqual(e2bCalls.at(-1), ["updateNetwork", rules]);
  assert.deepEqual(e2bEgressNetwork("http://10.0.0.5:3128"), { allowOut: ["10.0.0.5"], denyOut: ["0.0.0.0/0"] });
  assert.deepEqual(e2bEgressNetwork("http://egress.example.com"), rules);
  assert.throws(() => e2bEgressNetwork("http://proxy.internal:3128"), /ports 80 and 443/);
  assert.throws(() => e2bEgressNetwork("https://egress.example.com:8443"), /ports 80 and 443/);
});

test("E2B persistent snapshots and metrics map onto the client contract", async () => {
  e2bCalls.length = 0;
  const client = createSdkE2bClient({ apiKey: "test" });
  const session = await client.create({ metadata: {}, autoPause: true, fromSnapshot: "snap-old" });
  assert.equal(e2bCalls[0]![1], "snap-old", "a restore creates from the snapshot instead of the template");
  assert.deepEqual(await session.createSnapshot(), { snapshotId: "snap-native" });
  assert.deepEqual(await session.metrics(), {
    cpuUsedPct: 12.5,
    cpuCount: 2,
    memUsedBytes: 2 ** 30,
    memTotalBytes: 2 ** 31,
    diskUsedBytes: 2 ** 30,
    diskTotalBytes: 20 * 2 ** 30,
  });
  await client.deleteSnapshot("snap-old");
  assert.deepEqual(e2bCalls.at(-1), ["deleteSnapshot", "snap-old"]);
});

test("E2B does not dispatch twice when execution occurs before its start acknowledgment is lost", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "e2b-lost-start-"));
  t.after(() => {
    startError = undefined;
    onDispatch = undefined;
    rmSync(root, { recursive: true, force: true });
  });
  const sandbox = createE2bSandbox(createLocalWorkspaceStore(root), { client: createSdkE2bClient({ apiKey: "test" }) });
  const handle = await sandbox.provision([{ scopeId: "lost-start", mountPath: "", mode: "rw" }]);
  let effects = 0;
  onDispatch = (command) => {
    if (command.includes("perform-side-effect")) effects++;
  };
  startError = new FakeSandboxNotFoundError("start stream unavailable after dispatch");
  await assert.rejects(sandbox.run(handle, "perform-side-effect"), /may have partially executed and was not retried/);
  assert.equal(effects, 1);
});

test("Modal executes a one-megabyte payload through the sandbox and SDK without nested oversized arguments", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "modal-large-command-"));
  const home = join(root, "home");
  mkdirSync(home);
  const map = (value: string) =>
    value
      .replaceAll("/root", home)
      .replaceAll("/tmp/.qm-exec-", `${root}/.qm-exec-`)
      .replaceAll("exec setsid ", process.platform === "darwin" ? "exec " : "exec setsid ");
  const originalExec = modalSandbox.exec;
  const originalWrite = modalSandbox.filesystem.writeBytes;
  t.after(() => {
    modalSandbox.exec = originalExec;
    modalSandbox.filesystem.writeBytes = originalWrite;
    rmSync(root, { recursive: true, force: true });
  });
  modalSandbox.filesystem.writeBytes = async (data, path) => {
    const file = map(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, map(Buffer.from(data).toString("utf8")));
  };
  modalSandbox.exec = async (args, params) => {
    const mapped = args.map(map);
    const result = spawnSync(mapped[0]!, mapped.slice(1), {
      encoding: "utf8",
      env: { ...process.env, HOME: home, ...(params.env as Record<string, string> | undefined) },
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    return {
      stdout: { readText: async () => result.stdout },
      stderr: { readText: async () => result.stderr },
      wait: async () => result.status ?? -1,
    };
  };
  const client = createSdkModalClient({ tokenId: "id", tokenSecret: "secret", appName: "test", image: "ubuntu" });
  const session = await client.create({});
  const sandbox = createModalSandbox(createLocalWorkspaceStore(join(root, "workspace")), {
    client: {
      create: async () => session,
      fromId: async () => session,
      fromName: async () => null,
      terminate: async () => {},
    },
  });
  const handle = await sandbox.provision([{ scopeId: "large-command", mountPath: "", mode: "rw" }]);
  const size = 1024 * 1024;
  const result = await sandbox.run(handle, `payload='${"x".repeat(size)}'; printf '%s' "${"${#payload}"}"`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, String(size));
  const signalled = await sandbox.run(handle, `payload='${"x".repeat(size)}'; printf '%s' "${"${#payload}"}"`, {
    signal: new AbortController().signal,
  });
  assert.equal(signalled.code, 0, signalled.stderr);
  assert.equal(signalled.stdout, String(size));
});
