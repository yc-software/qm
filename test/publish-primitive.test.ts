import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolContext } from "../src/tools/primitives.ts";
import { createDeployStore, type DeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createDeployService, type DeployService, type DeployOrUpdateInput } from "../src/deploy/deploy-service.ts";
import { createAclStore, type AclStore } from "../src/acl/acl-store.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import type { ToolLedger } from "../src/runs/tool-ledger.ts";
import { CapabilityUnsupportedError } from "../src/sandbox/sandbox.ts";
import type { AgentComputerBackupEntry, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

function svc() {
  const deployStore: DeployStore = createDeployStore();
  const acl: AclStore = createAclStore();
  let starts = 0;
  const deploy: DeployService = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        starts++;
        return { host: "127.0.0.1", port: 20000 };
      },
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "pub-")),
  });
  return {
    deploy,
    deployStore,
    acl,
    get starts() {
      return starts;
    },
  };
}

interface CtxOpts {
  files?: Array<{ path: string; data: Uint8Array }>;
  sandbox?: Sandbox;
  provision?: () => Promise<SandboxHandle>;
  ledger?: ToolLedger;
  runId?: string;
  rw?: boolean;
}

function fileSandbox(files: Array<{ path: string; data: Uint8Array }>): Sandbox {
  const under = (dir: string) => {
    const d = (dir ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
    return files.filter((f) => !d || d === "." || f.path === d || f.path.startsWith(`${d}/`));
  };
  return {
    listDir: async (_h: SandboxHandle, dir: string) => under(dir).map((f) => f.path),
    readFileBytes: async (_h: SandboxHandle, p: string) => files.find((f) => f.path === p)?.data ?? null,
    backupComputer: async (_h: SandboxHandle, opts?: { includePaths?: readonly string[] }) => {
      const dir = opts?.includePaths?.[0] ?? "";
      return under(dir).map((f) => ({ area: "workspace" as const, path: f.path, data: f.data }));
    },
  } as unknown as Sandbox;
}

function ctx(deploy: DeployService, opts: CtxOpts = {}) {
  const files = opts.files ?? [];
  const sandbox = opts.sandbox ?? fileSandbox(files);
  return createToolContext({
    sandbox,
    provision: opts.provision ?? (async () => ({}) as SandboxHandle),
    layers: opts.rw === false ? [] : [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy,
    acl: {} as never,
    createdBy: "U1",
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
  });
}

const bytes = (s: string) => new TextEncoder().encode(s);
const appFile = (path = "server.js", data = "listen") => [{ path, data: bytes(data) }];

test("publish collects only the published dir (prefix-stripped) and returns a /d/<name>/ link", async () => {
  const s = svc();
  const files = [
    { path: "dist/server.js", data: bytes("listen") },
    { path: "dist/public/index.html", data: bytes("<h1>") },
    { path: "notes.txt", data: bytes("ignore me") },
  ];
  const tc = ctx(s.deploy, { files });
  const r = await tc.publish({ dir: "dist", entrypoint: "node server.js", name: "my-app" });

  assert.equal(r.url, "/d/my-app/");
  assert.equal(r.name, "my-app");
  assert.equal(r.version, 1);

  const d = (await s.deployStore.getByName("my-app"))!;
  assert.ok(d, "deployment is reachable by name");
  const snap = (await s.deployStore.versionOf(d.id, 1))!.snapshotDir;
  const top = readdirSync(snap).sort();
  assert.deepEqual(top, ["public", "server.js"], "dir prefix stripped; outside-dir file excluded");
  assert.deepEqual(
    (await s.deployStore.treeOf(d.id, 1))?.map((f) => f.path),
    ["public/index.html", "server.js"],
    "the app tree is also committed without outside-dir files",
  );
});

test("publish falls back to per-file reads when the routed backend refuses backupComputer", async () => {
  const s = svc();
  const files = [
    { path: "dist/server.js", data: bytes("listen") },
    { path: "dist/public/index.html", data: bytes("<h1>") },
  ];
  const sandbox = fileSandbox(files);
  sandbox.backupComputer = async () => {
    throw new CapabilityUnsupportedError("sprites", "backupComputer");
  };
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const tc = ctx(s.deploy, { files, sandbox });
  const r = await (async () => {
    try {
      return await tc.publish({ dir: "dist", entrypoint: "node server.js", name: "sprite-app" });
    } finally {
      console.warn = warn;
    }
  })();
  assert.equal(r.url, "/d/sprite-app/");
  assert.deepEqual(warnings, [
    ["[publish] this computer's substrate (sprites) does not support backupComputer; falling back to per-file reads"],
  ]);
  const d = (await s.deployStore.getByName("sprite-app"))!;
  assert.deepEqual(
    (await s.deployStore.treeOf(d.id, 1))?.map((f) => f.path).sort(),
    ["public/index.html", "server.js"],
    "tree collected through the listDir/readFileBytes fallback",
  );
});

test("publish still fails loudly when backupComputer breaks for any other reason", async () => {
  const s = svc();
  const files = appFile("dist/server.js");
  const sandbox = fileSandbox(files);
  sandbox.backupComputer = async () => {
    throw new Error("archive read failed");
  };
  const tc = ctx(s.deploy, { files, sandbox });
  await assert.rejects(
    () => tc.publish({ dir: "dist", entrypoint: "node server.js", name: "broken" }),
    /archive read failed/,
  );
});

test("publish by name updates in place: bumps the version, keeps the id and the link", async () => {
  const s = svc();
  const first = await ctx(s.deploy, { files: [{ path: "app/server.js", data: bytes("v1") }] }).publish({
    dir: "app",
    entrypoint: "node server.js",
    name: "dash",
  });
  const second = await ctx(s.deploy, { files: [{ path: "app/server.js", data: bytes("v2") }] }).publish({
    dir: "app",
    entrypoint: "node server.js",
    name: "dash",
  });

  assert.equal(second.id, first.id, "same deployment");
  assert.equal(second.version, 2, "new immutable version");
  assert.equal(second.url, "/d/dash/", "stable link");
});

test("publish by name inherits the current entrypoint when redeploying without one", async () => {
  const s = svc();
  await ctx(s.deploy, { files: [{ path: "app/server.js", data: bytes("v1") }] }).publish({
    dir: "app",
    entrypoint: "node server.js",
    name: "dash",
  });
  const second = await ctx(s.deploy, { files: [{ path: "app/server.js", data: bytes("v2") }] }).publish({
    dir: "app",
    name: "dash",
  });

  const d = (await s.deployStore.getByName("dash"))!;
  assert.equal(second.version, 2);
  assert.equal(d.versions[1]!.entrypoint, "node server.js");
  assert.deepEqual(
    (await s.deployStore.filesOf(d.id, 2))?.map((f) => ({ path: f.path, data: [...f.data] })),
    [{ path: "server.js", data: [...bytes("v2")] }],
  );
});

test("publish without an entrypoint and without a prior version fails before provisioning", async () => {
  const s = svc();
  let provisioned = false;
  const tc = ctx(s.deploy, {
    files: appFile("app/server.js"),
    provision: async () => {
      provisioned = true;
      return {} as SandboxHandle;
    },
  });

  await assert.rejects(() => tc.publish({ dir: "app", name: "new-app" }), {
    message: 'publish requires an entrypoint, e.g. "node server.js"',
  });
  assert.equal(provisioned, false);
  assert.equal((await s.deployStore.list()).length, 0);
});

test("publish: a different scope claiming a taken name is rejected", async () => {
  const s = svc();
  await ctx(s.deploy, { files: appFile() }).publish({ entrypoint: "x", name: "taken" });
  const other = createToolContext({
    sandbox: fileSandbox(appFile()),
    provision: async () => ({}) as SandboxHandle,
    layers: [{ scopeId: scopeId("personal", "U2"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: s.deploy,
    acl: {} as never,
    createdBy: "U2",
  });
  await assert.rejects(() => other.publish({ entrypoint: "x", name: "taken" }), /name taken/);
});

test("publish: renameFrom moves the link but keeps the id (and shares ride the id)", async () => {
  const s = svc();
  const created = await ctx(s.deploy, { files: appFile() }).publish({
    entrypoint: "x",
    name: "old-name",
    share: [{ scope: scopeId("personal", "U2"), permission: "read" }],
  });
  const renamed = await ctx(s.deploy).publish({ renameFrom: "old-name", name: "new-name" });

  assert.equal(renamed.id, created.id);
  assert.equal(renamed.url, "/d/new-name/");
  assert.equal(await s.deployStore.getByName("old-name"), null);
  assert.equal((await s.deployStore.getByName("new-name"))!.id, created.id);
  assert.equal((await s.acl.grantsFor(scopeId("personal", "U1"), `deployment:${created.id}`)).length, 1);
});

test("publish rejects an entrypoint deploy when no files were collected", async () => {
  const s = svc();
  await assert.rejects(
    () =>
      ctx(s.deploy, { files: appFile("other/server.js") }).publish({
        dir: "missing",
        entrypoint: "node server.js",
        name: "empty-app",
      }),
    /publish: no files found under missing - nothing to deploy/,
  );
  assert.equal((await s.deployStore.list()).length, 0, "empty app was not recorded");
});

test("publish collects the app tree as ONE archive (not file-by-file)", async () => {
  const files = [
    { path: "app/server.js", data: bytes("listen") },
    { path: "app/a.txt", data: bytes("a") },
    { path: "app/b.txt", data: bytes("b") },
    { path: "app/c/d.txt", data: bytes("d") },
  ];
  let archives = 0;
  let perFileReads = 0;
  const sandbox = {
    listDir: async () => {
      throw new Error("collectTree must not list the tree");
    },
    readFileBytes: async () => {
      perFileReads++;
      return null;
    },
    backupComputer: async (
      _h: SandboxHandle,
      opts?: { include?: Array<"workspace" | "home">; includePaths?: readonly string[] },
    ) => {
      if (opts?.include?.includes("home")) return [];
      archives++;
      const dir = opts?.includePaths?.[0] ?? "";
      return files
        .filter((f) => !dir || f.path.startsWith(`${dir}/`))
        .map((f) => ({ area: "workspace" as const, path: f.path, data: f.data }));
    },
  } as unknown as Sandbox;
  const { deploy, captured } = spyDeploy();
  const tc = createToolContext({
    sandbox,
    provision: async () => ({}) as SandboxHandle,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy,
    acl: {} as never,
    createdBy: "U1",
  });
  await tc.publish({ dir: "app", entrypoint: "node server.js", name: "agg-app" });
  assert.equal(archives, 1, "the whole tree rides one archive, not N reads");
  assert.equal(perFileReads, 0, "no per-file readFileBytes round-trips");
  assert.deepEqual(
    (captured()!.files ?? []).map((f) => f.path).sort(),
    ["a.txt", "b.txt", "c/d.txt", "server.js"],
    "every tree file is in the deploy, prefix-stripped",
  );
});

test("publish FAILS LOUDLY on a flaky archive read — it never silently drops files", async () => {
  const s = svc();
  const sandbox = {
    listDir: async () => [],
    readFileBytes: async () => null,
    backupComputer: async (_h: SandboxHandle, opts?: { include?: Array<"workspace" | "home"> }) => {
      if (opts?.include?.includes("home")) return [];
      throw new Error("fly backup workspace read-back failed");
    },
  } as unknown as Sandbox;
  const tc = createToolContext({
    sandbox,
    provision: async () => ({}) as SandboxHandle,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: s.deploy,
    acl: {} as never,
    createdBy: "U1",
  });
  await assert.rejects(
    () => tc.publish({ dir: "app", entrypoint: "node server.js", name: "flaky-app" }),
    /read-back failed/,
    "a failed archive read surfaces as an error, not a partial deploy",
  );
  assert.equal((await s.deployStore.list()).length, 0, "nothing half-shipped");
});

test("publish on a sandbox WITHOUT backupComputer (AWS) still collects the tree, and a null read FAILS LOUDLY", async () => {
  const files = [
    { path: "app/server.js", data: bytes("listen") },
    { path: "app/ok.txt", data: bytes("ok") },
  ];
  const awsLike = (readFor: (p: string) => Uint8Array | null): Sandbox =>
    ({
      listDir: async (_h: SandboxHandle, dir: string) => {
        const d = (dir ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
        return files.filter((f) => !d || d === "." || f.path.startsWith(`${d}/`)).map((f) => f.path);
      },
      readFileBytes: async (_h: SandboxHandle, p: string) => readFor(p),
    }) as unknown as Sandbox;

  {
    const { deploy, captured } = spyDeploy();
    const tc = createToolContext({
      sandbox: awsLike((p) => files.find((f) => f.path === p)?.data ?? null),
      provision: async () => ({}) as SandboxHandle,
      layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
      commandPolicy: () => ({}) as never,
      authorizeCommand: () => false,
      grantedHandles: [],
      workspace: {} as never,
      deploy,
      acl: {} as never,
      createdBy: "U1",
    });
    await tc.publish({ dir: "app", entrypoint: "node server.js", name: "aws-ok" });
    assert.deepEqual(
      (captured()!.files ?? []).map((f) => f.path).sort(),
      ["ok.txt", "server.js"],
      "AWS publish still collects every tree file",
    );
  }

  {
    const s = svc();
    const tc = createToolContext({
      sandbox: awsLike((p) => (p === "app/ok.txt" ? null : (files.find((f) => f.path === p)?.data ?? null))),
      provision: async () => ({}) as SandboxHandle,
      layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
      commandPolicy: () => ({}) as never,
      authorizeCommand: () => false,
      grantedHandles: [],
      workspace: {} as never,
      deploy: s.deploy,
      acl: {} as never,
      createdBy: "U1",
    });
    await assert.rejects(
      () => tc.publish({ dir: "app", entrypoint: "node server.js", name: "aws-flaky" }),
      /could not read app\/ok\.txt/,
      "a null per-file read throws instead of silently dropping the file",
    );
    assert.equal((await s.deployStore.list()).length, 0, "nothing half-shipped");
  }
});

test("publish rejects parent traversal before listing outside the workspace", async () => {
  const s = svc();
  const listed: string[] = [];
  const sandbox = {
    listDir: async (_h: SandboxHandle, dir: string) => {
      listed.push(dir);
      return ["../.ssh/id_ed25519"];
    },
    readFileBytes: async () => bytes("secret"),
  } as unknown as Sandbox;
  const tc = ctx(s.deploy, { sandbox });
  await assert.rejects(
    () => tc.publish({ dir: "../", entrypoint: "node server.js", name: "escaped" }),
    /publish directory must stay inside the workspace/,
  );
  assert.deepEqual(listed, []);
  assert.equal((await s.deployStore.list()).length, 0);
});

test("publish: rollbackTo flips the named deployment's pointer", async () => {
  const s = svc();
  await ctx(s.deploy, { files: [{ path: "a/s.js", data: bytes("v1") }] }).publish({
    dir: "a",
    entrypoint: "x",
    name: "roll",
  });
  await ctx(s.deploy, { files: [{ path: "a/s.js", data: bytes("v2") }] }).publish({
    dir: "a",
    entrypoint: "x",
    name: "roll",
  });
  assert.equal((await s.deployStore.getByName("roll"))!.currentVersion, 2);

  await ctx(s.deploy).publish({ name: "roll", rollbackTo: 1 });
  assert.equal((await s.deployStore.getByName("roll"))!.currentVersion, 1);
});

test("publish is ledgered (G6): a crash-replay returns the cached result, not a second deploy", async () => {
  const s = svc();
  const seen = new Map<string, string>();
  const ledger: ToolLedger = {
    async begin(runId, attempt, i) {
      const key = `${runId}:${attempt}:${i}`;
      return seen.has(key) ? { cached: true, output: seen.get(key)! } : { cached: false };
    },
    async record(runId, attempt, i, output) {
      seen.set(`${runId}:${attempt}:${i}`, output);
    },
  };
  const files = [{ path: "app/s.js", data: bytes("x") }];
  const r1 = await ctx(s.deploy, { files, ledger, runId: "r1" }).publish({
    dir: "app",
    entrypoint: "x",
    name: "once-app",
  });
  const r2 = await ctx(s.deploy, { files, ledger, runId: "r1" }).publish({
    dir: "app",
    entrypoint: "x",
    name: "once-app",
  });

  assert.deepEqual(r2, r1, "replay returns the cached PublishResult");
  assert.equal((await s.deployStore.list()).length, 1, "no second deployment created");
  assert.equal(s.starts, 1, "the container was started exactly once");
});

test("publish never copies resident credentials into the deployment", async () => {
  const home: AgentComputerBackupEntry[] = [
    { area: "home", path: ".aws/credentials", data: bytes("[default]") },
    { area: "home", path: ".config/gh/hosts.yml", data: bytes("gh") },
    { area: "home", path: ".config/gcloud/access_tokens.db", data: bytes("gcloud") },
    { area: "home", path: ".ssh/id_ed25519", data: bytes("key") },
    { area: "home", path: ".netrc", data: bytes("machine") },
    { area: "home", path: ".git-credentials", data: bytes("https://") },
    { area: "home", path: ".bash_history", data: bytes("rm -rf") },
    { area: "home", path: "secret-notes.txt", data: bytes("private") },
    { area: "home", path: ".config/fish/config.fish", data: bytes("shell") },
  ];
  const sandbox = backupSandbox(home);

  let captured: DeployOrUpdateInput | undefined;
  const deploy = {
    deployOrUpdate: async (input: DeployOrUpdateInput) => {
      captured = input;
      return {
        id: "d1",
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        ...(input.name ? { name: input.name } : {}),
        currentVersion: 1,
        status: "running",
        endpoint: null,
        versions: [],
      } satisfies Deployment;
    },
    deploymentGrantees: async () => [],
  } as unknown as DeployService;

  const tc = createToolContext({
    sandbox,
    provision: async () => ({}) as SandboxHandle,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy,
    acl: {} as never,
    createdBy: "U1",
  });
  await tc.publish({ entrypoint: "node s.js", name: "authed" });

  assert.equal(captured!.homeFiles, undefined);
});

function backupSandbox(entries: AgentComputerBackupEntry[], workspace = appFile("s.js")): Sandbox {
  const all: AgentComputerBackupEntry[] = [
    ...workspace.map((f) => ({ area: "workspace" as const, path: f.path, data: f.data })),
    ...entries,
  ];
  return {
    listDir: async () => workspace.map((f) => f.path),
    readFileBytes: async (_h: SandboxHandle, p: string) => workspace.find((f) => f.path === p)?.data ?? null,
    backupComputer: async (
      _h: SandboxHandle,
      opts?: {
        include?: Array<"workspace" | "home">;
        includePaths?: readonly string[];
        exclude?: (e: { area: "workspace" | "home"; path: string }) => boolean;
      },
    ) => {
      const include = opts?.include ?? ["workspace", "home"];
      const exclude = opts?.exclude ?? (() => false);
      const scoped = opts?.includePaths
        ? all.filter((e) => opts.includePaths!.some((p) => e.path === p || e.path.startsWith(`${p}/`)))
        : all;
      return scoped.filter((e) => include.includes(e.area) && !exclude(e));
    },
  } as unknown as Sandbox;
}

function spyDeploy(): { deploy: DeployService; captured: () => DeployOrUpdateInput | undefined } {
  let captured: DeployOrUpdateInput | undefined;
  const deploy = {
    deployOrUpdate: async (input: DeployOrUpdateInput) => {
      captured = input;
      return {
        id: "d1",
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        ...(input.name ? { name: input.name } : {}),
        currentVersion: 1,
        status: "running",
        endpoint: null,
        versions: [],
      } satisfies Deployment;
    },
    deploymentGrantees: async () => [],
  } as unknown as DeployService;
  return { deploy, captured: () => captured };
}

const RESIDENT_HOME: AgentComputerBackupEntry[] = [
  { area: "home", path: ".aws/credentials", data: bytes("[default]") },
  { area: "home", path: ".acmecli/config.json", data: bytes("{}") },
  { area: "home", path: ".config/gh/hosts.yml", data: bytes("gh") },
  { area: "home", path: ".netrc", data: bytes("machine") },
];

test("publish always splits: bakes NO resident creds, injects the layer's acting-as env", async () => {
  const config = createMemoryConfigStore("default-org");
  const { deploy, captured } = spyDeploy();
  const tc = createToolContext({
    sandbox: backupSandbox(RESIDENT_HOME),
    provision: async () => ({}) as SandboxHandle,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy,
    acl: {} as never,
    createdBy: "U1",
    config,
    actingSlackUserId: "U1",
    layerAuth: {
      credentialPaths: [{ path: ".acmecli", kind: "directory" }],
      splitEnvTemplates: [{ ACMECLI_ACTING_SLACK_USER_ID: "{actingSlackUserId}", ACMECLI_PLATFORM: "slack" }],
    },
  });
  await tc.publish({ entrypoint: "node s.js", name: "split-app" });

  const c = captured()!;
  assert.equal((c.homeFiles ?? []).length, 0, "split bakes no third-party creds and no raw .acmecli");
  assert.equal(c.env?.ACMECLI_ACTING_SLACK_USER_ID, "U1", "the layer CLI acts AS the originator via env");
  assert.equal(c.env?.ACMECLI_PLATFORM, "slack");
});

test("publish off-Slack: injects nothing (no acting-as id, no baked creds)", async () => {
  const config = createMemoryConfigStore("default-org");
  const { deploy, captured } = spyDeploy();
  const tc = createToolContext({
    sandbox: backupSandbox(RESIDENT_HOME),
    provision: async () => ({}) as SandboxHandle,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy,
    acl: {} as never,
    createdBy: "U1",
    config,
  });
  await tc.publish({ entrypoint: "node s.js", name: "split-web" });

  const c = captured()!;
  assert.equal((c.homeFiles ?? []).length, 0, "no creds baked under split");
  assert.equal(c.env, undefined, "no acting-as env without a Slack id");
});

test("publish rejects an invalid or id-shaped name, and a turn with no writable scope", async () => {
  const s = svc();
  await assert.rejects(
    () => ctx(s.deploy, { files: appFile() }).publish({ entrypoint: "x", name: "Bad_Name" }),
    /invalid deployment name/,
  );
  await assert.rejects(
    () =>
      ctx(s.deploy, { files: appFile() }).publish({ entrypoint: "x", name: "00000000-0000-4000-8000-000000000000" }),
    /looks like an id/,
  );
  await assert.rejects(
    () => ctx(s.deploy, { rw: false }).publish({ entrypoint: "x", name: "noscope" }),
    /writable scope/,
  );
});

test("publish drops a workspace's git metadata instead of deploying it", async () => {
  const s = svc();
  const files = [
    { path: "server.js", data: bytes("listen") },
    { path: ".git/config", data: bytes('[core]\n\tfsmonitor = "touch /tmp/qm-should-not-run"\n') },
    { path: ".git/HEAD", data: bytes("ref: refs/heads/main\n") },
    { path: "vendor/dep/.GIT/config", data: bytes("[core]\n") },
  ];
  const tc = ctx(s.deploy, { files });
  await tc.publish({ entrypoint: "node server.js", name: "gitty-app" });

  const d = (await s.deployStore.getByName("gitty-app"))!;
  assert.deepEqual(
    (await s.deployStore.treeOf(d.id, 1))?.map((f) => f.path),
    ["server.js"],
    "git metadata never reaches the deployment's archive",
  );
  const snap = (await s.deployStore.versionOf(d.id, 1))!.snapshotDir;
  assert.deepEqual(readdirSync(snap).sort(), ["server.js"], "and never reaches the running app");
});

test("publish drops git metadata on the per-file fallback path too", async () => {
  const s = svc();
  const files = [
    { path: "server.js", data: bytes("listen") },
    { path: ".git/config", data: bytes("[core]\n") },
  ];
  const sandbox = fileSandbox(files);
  sandbox.backupComputer = async () => {
    throw new CapabilityUnsupportedError("sprites", "backupComputer");
  };
  const tc = ctx(s.deploy, { files, sandbox });
  await tc.publish({ entrypoint: "node server.js", name: "gitty-fallback" });

  const d = (await s.deployStore.getByName("gitty-fallback"))!;
  assert.deepEqual(
    (await s.deployStore.treeOf(d.id, 1))?.map((f) => f.path),
    ["server.js"],
  );
});
