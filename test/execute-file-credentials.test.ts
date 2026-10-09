import { finishProcessCredentials, prepareExecutionFiles } from "../src/credentials/execute-files.ts";
import { createBackgroundBroker } from "../src/connectors/background-exec-broker.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeychain, type CredentialFile, type Keychain } from "../src/credentials/keychain.ts";
import { reconcileProcesses } from "../src/processes/reconcile.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import type { ProcessSandbox, ProcessState, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

const run = promisify(execFile);
const SECRET_TOKEN = "synthetic-background-token-123";
const owner = "file-execution-test";
const scope = scopeId("personal", owner);
const files = (value: string): CredentialFile[] => [
  { path: ".aws/sso/cache/session.json", contentBase64: Buffer.from(value).toString("base64") },
];

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "qm-file-execution-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("synthetic-test-key"),
  });
  const credential = await keychain.save({
    ownerId: owner,
    service: "aws",
    files: files("original"),
    origin: "agent-session:original",
    accountLabel: "original owner",
  });
  const handle: SandboxHandle = { id: "default", rootDir: root, homeDir: root };
  const commands: Array<{ handle: SandboxHandle; command: string }> = [];
  const sandbox = {
    async run(h: SandboxHandle, command: string) {
      commands.push({ handle: h, command });
      try {
        const result = await run("/bin/sh", ["-c", command], {
          cwd: h.rootDir,
          env: { PATH: process.env.PATH, HOME: h.homeDir, ...h.env },
          maxBuffer: 1024 * 1024,
        });
        return { ...result, code: 0, timedOut: false };
      } catch (error) {
        const result = error as Error & { stdout: string; stderr: string; code: number };
        return { stdout: result.stdout, stderr: result.stderr, code: result.code, timedOut: false };
      }
    },
    async writeFileBytes(h: SandboxHandle, path: string, bytes: Uint8Array) {
      await mkdir(join(h.rootDir, path, ".."), { recursive: true });
      await writeFile(join(h.rootDir, path), bytes);
    },
    async readFile(h: SandboxHandle, path: string) {
      try {
        return await readFile(path.startsWith("/") ? path : join(h.rootDir, path), "utf8");
      } catch {
        return null;
      }
    },
    async readFileBytes(h: SandboxHandle, path: string) {
      return readFile(join(h.rootDir, path));
    },
  } as unknown as Sandbox;
  let resolutions = 0;
  const context = (extra: Partial<ToolContextDeps> = {}, ownerScope = false) =>
    createToolContext({
      sandbox,
      provision: async () => handle,
      provisionOwnerAuth: async () => ({ ...handle, id: "owner" }),
      provisionScratch: async () => ({ ...handle, id: "scratch" }),
      layers: [{ scopeId: scope, mountPath: "", mode: "rw" }],
      commandPolicy: () => ({ mode: "denylist", rules: [] }),
      authorizeCommand: () => false,
      commandCredentials: [
        {
          handle: "aws",
          scope: ownerScope ? "owner" : "scoped",
          async resolve() {
            resolutions++;
            const materialized = await keychain.materializeOwnById(owner, credential.id, scope);
            assert.equal(materialized.kind, "file");
            if (materialized.kind !== "file") throw new Error("Expected files");
            return {
              env: [],
              files: {
                files: materialized.files,
                save: (updated: CredentialFile[]) => keychain.updateFiles(materialized, updated),
                source: { credentialId: materialized.credentialId, ownerId: owner, service: "aws" },
              },
            };
          },
        },
        {
          handle: "token",
          scope: "scoped",
          async resolve() {
            return { env: [{ key: "API_TOKEN", value: SECRET_TOKEN }] };
          },
        },
      ],
      grantedHandles: [],
      workspace: {} as never,
      deploy: {} as never,
      acl: {} as never,
      createdBy: owner,
      ...extra,
    });
  return { keychain, credential, handle, sandbox, commands, context, resolutions: () => resolutions };
}

for (const target of ["default", "owner", "scratch", "selected"] as const) {
  test(`${target} execution persists refreshed files and cleans its temporary home`, async (t) => {
    const f = await fixture(t);
    const selected = { ...f.handle, id: "selected" };
    const resource = { id: "selected", ownerScopeId: scope };
    const ctx = f.context(
      target === "selected"
        ? {
            sandboxResources: {} as never,
            accessSandboxResource: async () =>
              ({ resource, crossScope: false, egress: { mode: "allowlist", hosts: [] }, commandPolicy: null }) as never,
            provisionResource: async (_access, authorize) => {
              authorize?.({ resource, crossScope: false, egress: {} } as never);
              return selected;
            },
          }
        : {},
      target === "owner",
    );
    const result = await ctx.execute('printf refreshed > "$HOME/.aws/sso/cache/session.json"; printf "%s" "$HOME"', {
      credentials: ["aws"],
      ...(target === "owner" ? { ownerAuth: true } : {}),
      ...(target === "scratch" ? { scratch: true } : {}),
      ...(target === "selected" ? { sandboxId: "selected" } : {}),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.commands.find((entry) => entry.command.startsWith("printf refreshed"))?.handle.id, target);
    await assert.rejects(access(result.stdout));
    const next = await f.keychain.materializeOwnById(owner, f.credential.id, scope);
    assert.equal(next.kind, "file");
    if (next.kind === "file") assert.equal(Buffer.from(next.files[0]!.contentBase64, "base64").toString(), "refreshed");
    const meta = await f.keychain.getCredential(f.credential.id);
    assert.equal(meta?.origin, "agent-session:original");
    assert.equal(meta?.accountLabel, "original owner");
    const second = await f.context().execute('cat "$HOME/.aws/sso/cache/session.json"', { credentials: ["aws"] });
    assert.equal(second.stdout, "refreshed");
  });
}

test("unrequested credentials are never materialized", async (t) => {
  const f = await fixture(t);
  const result = await f.context().execute('test ! -e "$HOME/.aws/sso/cache/session.json"');
  assert.equal(result.code, 0);
  assert.equal(f.resolutions(), 0);
});

test("failed commands still persist refreshes", async (t) => {
  const f = await fixture(t);
  const result = await f
    .context()
    .execute('printf refreshed > "$HOME/.aws/sso/cache/session.json"; exit 7', { credentials: ["aws"] });
  assert.equal(result.code, 7);
  const second = await f.context().execute('cat "$HOME/.aws/sso/cache/session.json"', { credentials: ["aws"] });
  assert.equal(second.stdout, "refreshed");
});

test("concurrent file updates cannot overwrite a newer credential or its grants", async (t) => {
  const f = await fixture(t);
  const grant = await f.keychain.createGrant({
    credentialId: f.credential.id,
    ownerId: owner,
    audienceScopeId: scopeId("channel", "test"),
    mode: "standing",
    purpose: "test",
  });
  const a = await f.keychain.materializeOwnById(owner, f.credential.id, scope);
  const b = await f.keychain.materializeOwnById(owner, f.credential.id, scope);
  if (a.kind !== "file" || b.kind !== "file") throw new Error("Expected files");
  await f.keychain.updateFiles(a, files("newer"));
  await assert.rejects(f.keychain.updateFiles(b, files("stale")), /changed during execution/);
  assert.equal((await f.keychain.getGrant(grant.id))?.status, "active");
});

test("symlink replacement is rejected and the ephemeral home is removed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f
      .context()
      .execute('rm "$HOME/.aws/sso/cache/session.json"; ln -s /etc/passwd "$HOME/.aws/sso/cache/session.json"', {
        credentials: ["aws"],
      }),
    /symlinks/,
  );
  const execution = f.commands.find((entry) => entry.command.startsWith('rm "$HOME'))!;
  await assert.rejects(access(execution.handle.env!.HOME!));
});

test("a use grant permits AWS token rotation but cannot poison the owner's configuration", async (t) => {
  const f = await fixture(t);
  const cache = (token: string) =>
    files(JSON.stringify({ accessToken: token, refreshToken: "refresh", expiresAt: "2030-01-01", clientId: "client" }));
  await f.keychain.save({ ownerId: owner, service: "aws", files: cache("before"), origin: "agent-session:original" });
  const grant = await f.keychain.createGrant({
    credentialId: f.credential.id,
    ownerId: owner,
    audienceScopeId: scope,
    mode: "standing",
    purpose: "test rotation",
  });
  const prepared = await f.keychain.prepareMaterialize(grant.id, scope, owner);
  assert.equal(prepared.materialized.kind, "file");
  if (prepared.materialized.kind !== "file") throw new Error("Expected files");
  await prepared.commit();
  await f.keychain.updateFiles(prepared.materialized, cache("after"));
  const current = await f.keychain.prepareMaterialize(grant.id, scope, owner);
  if (current.materialized.kind !== "file") throw new Error("Expected files");
  await assert.rejects(
    f.keychain.updateFiles(current.materialized, [
      ...cache("after"),
      { path: ".aws/config", contentBase64: Buffer.from("credential_process=malicious").toString("base64") },
    ]),
    /cannot replace credential configuration/,
  );
  const saved = await f.keychain.materializeOwnById(owner, f.credential.id, scope);
  assert.equal(saved.kind, "file");
  if (saved.kind === "file") assert.equal(saved.files.length, 1);
});

test("an execution sweeps only stale credential directories", async (t) => {
  const f = await fixture(t);
  const stale = await prepareExecutionFiles(f.sandbox, f.handle, [{ files: files("stale"), save: async () => {} }]);
  const live = await prepareExecutionFiles(f.sandbox, f.handle, [{ files: files("live"), save: async () => {} }]);
  const staleDir = stale.env.HOME!.replace(/\/home$/, "");
  await f.sandbox.run(f.handle, `touch -d '3 hours ago' ${staleDir}`);
  await f.context().execute("true", { credentials: ["aws"] });
  await assert.rejects(access(stale.env.HOME!));
  await access(`${live.env.HOME}/.aws/sso/cache/session.json`);
  await live.finish();
});

test("concurrent executions keep their own credential directories", async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const sandbox = {
    ...f.sandbox,
    async run(handle: SandboxHandle, command: string, opts: Parameters<Sandbox["run"]>[2]) {
      if (command.startsWith("credential-hold")) {
        entered.resolve(handle.env!.HOME!);
        await release.promise;
      }
      return f.sandbox.run(handle, command, opts);
    },
  };
  const ctx = f.context({ sandbox });
  const held = ctx.execute("credential-hold 2>/dev/null; cat ~/.aws/sso/cache/session.json", { credentials: ["aws"] });
  const home = await entered.promise;
  assert.equal((await ctx.execute("echo unrelated")).stdout.trim(), "unrelated");
  await ctx.execute("true", { credentials: ["aws"] });
  await access(`${home}/.aws/sso/cache/session.json`);
  release.resolve();
  assert.equal((await held).stdout, "original");
  await assert.rejects(access(home));
});

function background(
  f: Awaited<ReturnType<typeof fixture>>,
  opts: {
    keychain?: Pick<Keychain, "writebackBaseline" | "updateFiles">;
    readFailures?: number;
    startFailure?: boolean;
  } = {},
) {
  const registry = createMemoryProcessRegistry();
  const jobs = new Map<string, { output: string; code?: number; child: ChildProcess }>();
  let readFailures = opts.readFailures ?? 0;
  const sandbox = {
    ...f.sandbox,
    profile: { processSessions: true },
    async startProcess(h: SandboxHandle, command: string, startOpts?: { env?: Record<string, string> }) {
      if (opts.startFailure) throw new Error("sandbox refused the process");
      const processId = `job-${jobs.size}`;
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: h.rootDir,
        env: { PATH: process.env.PATH, HOME: h.homeDir, ...h.env, ...startOpts?.env },
      });
      const job: { output: string; code?: number; child: ChildProcess } = { output: "", child };
      child.stdout!.on("data", (chunk) => (job.output += chunk));
      child.on("exit", (code) => (job.code = code ?? 143));
      jobs.set(processId, job);
      return { processId };
    },
    async readProcess(_h: SandboxHandle, processId: string, readOpts?: { sinceCursor?: number; waitMs?: number }) {
      if (readFailures-- > 0) throw new Error("transient read failure");
      const job = jobs.get(processId)!;
      if (job.code === undefined && readOpts?.waitMs)
        await new Promise((resolve) => setTimeout(resolve, Math.min(readOpts.waitMs!, 50)));
      return {
        chunks: job.output.slice(readOpts?.sinceCursor ?? 0),
        cursor: job.output.length,
        status: job.code === undefined ? { state: "running" as const } : { state: "exited" as const, code: job.code },
      };
    },
    async writeStdin() {},
    async signalProcess(_h: SandboxHandle, processId: string) {
      jobs.get(processId)!.child.kill();
    },
    async listProcesses() {
      return [...jobs].map(([processId, job]) => ({
        processId,
        status: job.code === undefined ? { state: "running" as const } : { state: "exited" as const, code: job.code },
      }));
    },
  } as unknown as ProcessSandbox;
  const finish = (h: SandboxHandle, processId: string, keychain = opts.keychain ?? f.keychain) =>
    finishProcessCredentials({ sandbox, processes: registry, keychain }, h, processId);
  const broker = () =>
    createBackgroundBroker({
      sandbox,
      registry,
      scopeId: scope,
      pollMs: 10,
      onExit: (h, processId) => finish(h, processId),
    });
  const ctx = (b = broker()) => f.context({ sandbox, backgroundBroker: b });
  const waitForExit = async (processId: string) => {
    while (jobs.get(processId)?.code === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { registry, sandbox, broker, ctx, finish, waitForExit };
}

const savedValue = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const saved = await f.keychain.materializeOwnById(owner, f.credential.id, scope);
  assert.equal(saved.kind, "file");
  return saved.kind === "file" ? Buffer.from(saved.files[0]!.contentBase64, "base64").toString() : "";
};

const refresh =
  'printf %s "$HOME" > staged-home; sleep 0.5; cat "$HOME/.aws/sso/cache/session.json" > seen; printf background > "$HOME/.aws/sso/cache/session.json"';

test("background credentials stay staged until the job exits, then refreshes are saved", async (t) => {
  const f = await fixture(t);
  const bg = background(f);
  const ctx = bg.ctx();
  const started = await ctx.backgroundStart(refresh, { purpose: "Refresh a background login", credentials: ["aws"] });
  assert.equal(started.status.state, "running");
  assert.equal((await ctx.execute("echo unrelated")).stdout.trim(), "unrelated");
  let status: ProcessState = started.status;
  while (status.state !== "exited") status = (await ctx.backgroundPoll(started.processId, { waitSeconds: 1 })).status;
  assert.equal(await readFile(join(f.handle.rootDir, "seen"), "utf8"), "original");
  assert.equal(await savedValue(f), "background");
  await assert.rejects(access(await readFile(join(f.handle.rootDir, "staged-home"), "utf8")));
  assert.equal(await bg.registry.credentialFiles(started.processId), null);
});

test("background start output masks the command's credential values", async (t) => {
  const f = await fixture(t);
  const bg = background(f);
  const started = await bg.ctx().backgroundStart('echo "early $API_TOKEN"; sleep 0.3', {
    purpose: "Print a token",
    credentials: ["token"],
  });
  assert.match(started.output, /early <redacted:credential>/);
  assert.ok(!started.output.includes(SECRET_TOKEN));
  assert.ok(!JSON.stringify(await bg.registry.get(started.processId)).includes(SECRET_TOKEN));
});

test("a failed background writeback keeps the refresh for a later retry", async (t) => {
  const f = await fixture(t);
  let outage = true;
  const keychain: Pick<Keychain, "writebackBaseline" | "updateFiles"> = {
    writebackBaseline: (source, fingerprint) => f.keychain.writebackBaseline(source, fingerprint),
    async updateFiles(materialized, updated) {
      if (outage) throw new Error("keychain database unavailable");
      await f.keychain.updateFiles(materialized, updated);
    },
  };
  const bg = background(f, { keychain });
  const started = await bg.ctx().backgroundStart(refresh, { purpose: "Refresh a login", credentials: ["aws"] });
  await bg.waitForExit(started.processId);
  await assert.rejects(bg.ctx().backgroundPoll(started.processId), /will retry/);
  const staged = await readFile(join(f.handle.rootDir, "staged-home"), "utf8");
  await access(staged);
  assert.equal(await savedValue(f), "original");
  assert.equal((await bg.registry.get(started.processId))?.credentialsPending, true);
  outage = false;
  await reconcileProcesses(bg.sandbox, f.handle, bg.registry, scope, (h, processId) => bg.finish(h, processId));
  assert.equal(await savedValue(f), "background");
  await assert.rejects(access(staged));
  assert.equal(await bg.registry.credentialFiles(started.processId), null);
});

test("a background start that fails after launch leaves staging to the exit hook", async (t) => {
  const f = await fixture(t);
  const bg = background(f, { readFailures: 1 });
  await assert.rejects(
    bg.ctx().backgroundStart(refresh, { purpose: "Refresh a login", credentials: ["aws"] }),
    /transient read failure/,
  );
  const [record] = await bg.registry.listByScope(scope);
  await bg.waitForExit(record!.processId);
  assert.equal(await readFile(join(f.handle.rootDir, "seen"), "utf8"), "original");
  await bg.ctx().backgroundPoll(record!.processId);
  assert.equal(await savedValue(f), "background");
  await assert.rejects(access(await readFile(join(f.handle.rootDir, "staged-home"), "utf8")));
});

test("a background start that fails before launch removes its staging", async (t) => {
  const f = await fixture(t);
  const bg = background(f, { startFailure: true });
  const before = (await run("sh", ["-c", "ls -d /tmp/qm-credentials.* 2>/dev/null | wc -l"])).stdout;
  await assert.rejects(
    bg.ctx().backgroundStart(refresh, { purpose: "Refresh a login", credentials: ["aws"] }),
    /sandbox refused/,
  );
  assert.equal((await run("sh", ["-c", "ls -d /tmp/qm-credentials.* 2>/dev/null | wc -l"])).stdout, before);
});
