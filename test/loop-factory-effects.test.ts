import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFactoryLoopEffects,
  loadFactoryContext,
  FACTORY_SOURCE_DEFAULT_REF,
  factorySourceRef,
  FACTORY_SOURCE_DIR,
  FACTORY_STAGES,
  type FactoryStage,
  type FactoryContext,
  type FactoryEffectsDeps,
  type FactoryWorkEffects,
  factorySessionIdFor,
} from "../src/loops/factory/effects.ts";
import { FACTORY_REQUIRED_TOOLS } from "../src/loops/factory/preflight.ts";
import { FACTORY_WRAPPER, renderFactoryEnv } from "../src/loops/factory/process-work.ts";
import { shq } from "../src/util/shell.ts";
import { LINEAR_GRAPHQL_URL } from "../src/loops/factory/linear-intake.ts";
import { FORGE_CHECKS } from "../src/loops/factory/forge-evaluate.ts";
import type { FactoryConfig } from "../src/resolution/config-store.ts";
import type {
  ProcessState,
  ReadProcessResult,
  Sandbox,
  SandboxHandle,
  StartProcessOptions,
  TeardownOptions,
} from "../src/sandbox/sandbox.ts";
import type { Loop, LoopItem, LoopState, WorkspaceLayer } from "../src/types.ts";

const LINEAR_KEY = "lin_oauth_FAKE_CONNECTOR_TOKEN";
const GITHUB_TOKEN = "ghp_FAKE_CONNECTOR_TOKEN";
const GITHUB_HOST = "api.github.com";
const LINEAR_HOST = "api.linear.app";
const ANTHROPIC_KEY = "sk-ant-FAKE_KEY";
const INSTALLATION_TOKEN = "xoxb-FAKE_ORG_INSTALLATION_TOKEN";
const REPO_DIR = "/workspace/repo";
const CLONE_DIR = "/workspace/qm-source";
const CLONE_URL = "https://github.com/yc-software/qm.git";
const TICKET = "QM-12";

const CONFIG: FactoryConfig = {
  forge: "github",
  publishProject: "acme/app",
  targetBranch: "main",
  repoCloneUrl: "https://github.com/acme/app.git",
  linearTeamId: "TEAM-1",
  sourceAppDirs: "src",
  sourceTestRe: "\\.test\\.ts$",
  verifyTestsCmd: "npm test",
  verifyTestFileCmd: "npm test --",
  verifyLintCmd: "npm run lint",
  bugbotRequired: true,
  followupsEnabled: false,
};

const LOOP: Loop = {
  id: "loop-1",
  ownerScopeId: "personal:U1",
  owner: "U1",
  createdBy: "U1",
  enabled: true,
  createdAt: 1_000,
  name: "factory",
  playbook: "ship the ticket",
  playbookVersion: 1,
  playbookHistory: [],
  policyVersion: 1,
  successCondition: "pull request converged",
  shipActions: [{ action: "open_pr", gate: "hold" }],
  state: "enabled",
  health: "healthy",
};

const ITEM: LoopItem = {
  id: "item-1",
  loopId: LOOP.id,
  sourceKey: TICKET,
  status: "in_progress",
  attempts: 0,
  runIds: [],
  outputIds: [],
  createdAt: 1_000,
  updatedAt: 1_000,
};

const WORK_STDOUT = "working\nBRANCH:fix/qm-12\nMR:42\n";

const HEAD_SHA = "1111111111111111111111111111111111111111";

const GH_PULL = "https://api.github.com/repos/acme/app/pulls/42";

const convergedForge = (): Response[] => [
  Response.json({ head: { sha: HEAD_SHA }, mergeable: true, mergeable_state: "clean" }),
  Response.json({ commit: { sha: HEAD_SHA } }),
  Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success" }] }),
  Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
  Response.json([{ user: { login: "cursor[bot]" }, commit_id: HEAD_SHA }]),
];

const OPEN_PR_ARTIFACT = {
  shipAction: "open_pr",
  title: "QM-12: pull request #42",
  label: "fix/qm-12",
  externalRef: "https://github.com/acme/app/pull/42",
  capturedBy: "classifier",
};

type Call =
  | { op: "provision"; layers: WorkspaceLayer[]; handle: SandboxHandle }
  | { op: "run"; handle: SandboxHandle; command: string }
  | {
      op: "startProcess";
      handle: SandboxHandle;
      command: string;
      opts: StartProcessOptions | undefined;
      processId: string;
    }
  | { op: "readProcess"; handle: SandboxHandle; processId: string }
  | { op: "signalProcess"; handle: SandboxHandle; processId: string; signal: string }
  | { op: "teardown"; handle: SandboxHandle; opts: TeardownOptions | undefined };

interface FakeSandbox {
  sandbox: Sandbox;
  calls: Call[];
}

const probeStdout = (missing: string[]): string =>
  `${FACTORY_REQUIRED_TOOLS.filter((tool) => !missing.includes(tool))
    .map((tool) => `${tool}=ok 1.0`)
    .join("\n")}\n`;

function fakeSandbox(
  opts: {
    processSessions?: boolean;
    probeMissing?: string[];
    stdout?: string;
    teardownError?: Error;
    bootstrapExit?: number;
    bootstrapOutput?: string;
    read?: (n: number, calls: Call[]) => Promise<ReadProcessResult>;
  } = {},
): FakeSandbox {
  const calls: Call[] = [];
  const stdout = opts.stdout ?? WORK_STDOUT;
  const running: ProcessState = { state: "running" };
  const exited: ProcessState = { state: "exited", code: 0 };
  const defaultRead = async (n: number): Promise<ReadProcessResult> =>
    n === 1
      ? { chunks: stdout, cursor: stdout.length, status: running }
      : { chunks: "", cursor: stdout.length, status: exited };
  const unused = (name: string) => () => Promise.reject(new Error(`the factory effects must not call ${name}`));
  let provisioned = 0;
  let started = 0;
  const sandbox: Record<string, unknown> = {
    profile: {
      backend: "fake",
      writablePersistence: "resident_disk",
      processSessions: opts.processSessions ?? true,
    },
    provision: (layers: WorkspaceLayer[]) => {
      provisioned += 1;
      const handle: SandboxHandle = { id: `sbx-${provisioned}`, rootDir: "/workspace" };
      calls.push({ op: "provision", layers, handle });
      return Promise.resolve(handle);
    },
    run: (handle: SandboxHandle, command: string) => {
      calls.push({ op: "run", handle, command });
      return Promise.resolve({
        stdout: probeStdout(opts.probeMissing ?? []),
        stderr: "",
        code: 0,
        timedOut: false,
      });
    },
    readFile: unused("readFile"),
    writeFile: unused("writeFile"),
    writeFileBytes: unused("writeFileBytes"),
    readFileBytes: unused("readFileBytes"),
    listDir: unused("listDir"),
    removeDir: unused("removeDir"),
    startProcess: (handle: SandboxHandle, command: string, startOpts?: StartProcessOptions) => {
      started += 1;
      const processId = `p${started}`;
      calls.push({ op: "startProcess", handle, command, opts: startOpts, processId });
      return Promise.resolve({ processId });
    },
    readProcess: (handle: SandboxHandle, processId: string) => {
      calls.push({ op: "readProcess", handle, processId });
      const start = calls.find((call) => call.op === "startProcess" && call.processId === processId);
      if (start?.op === "startProcess" && !start.command.includes(FACTORY_WRAPPER)) {
        const chunks = opts.bootstrapOutput ?? "";
        return Promise.resolve({
          chunks,
          cursor: chunks.length,
          status: { state: "exited", code: opts.bootstrapExit ?? 0 },
        });
      }
      const n = calls.filter((call) => call.op === "readProcess" && call.processId === processId).length;
      return (opts.read ?? defaultRead)(n, calls);
    },
    writeStdin: unused("writeStdin"),
    signalProcess: (handle: SandboxHandle, processId: string, signal: string) => {
      calls.push({ op: "signalProcess", handle, processId, signal });
      return Promise.resolve();
    },
    listProcesses: unused("listProcesses"),
    teardown: (handle: SandboxHandle, teardownOpts?: TeardownOptions) => {
      calls.push({ op: "teardown", handle, opts: teardownOpts });
      return opts.teardownError ? Promise.reject(opts.teardownError) : Promise.resolve();
    },
  };
  return { sandbox: sandbox as unknown as Sandbox, calls };
}

const ops = (calls: Call[]): string[] => calls.map((call) => call.op);

const wrapperStart = (calls: Call[]): Extract<Call, { op: "startProcess" }> => {
  const start = calls.find((call) => call.op === "startProcess" && call.command.includes(FACTORY_WRAPPER));
  assert.ok(start?.op === "startProcess", "the wrapper was never started");
  return start;
};

const wrapperEnvs = (calls: Call[]): Record<string, string>[] =>
  calls.flatMap((call) =>
    call.op === "startProcess" && call.command.includes(FACTORY_WRAPPER) ? [call.opts?.env ?? {}] : [],
  );

const bootstrapStarts = (calls: Call[]): Extract<Call, { op: "startProcess" }>[] =>
  calls.filter(
    (call): call is Extract<Call, { op: "startProcess" }> =>
      call.op === "startProcess" && !call.command.includes(FACTORY_WRAPPER),
  );

const runWithFakeGit = (script: string, failOn = ""): { code: number; git: string[]; output: string } => {
  const bin = mkdtempSync(join(tmpdir(), "factory-bootstrap-bin-"));
  const log = join(bin, "git.log");
  const fakeGit = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${shq(log)}`,
    'if [ -n "${FAKE_GIT_FAIL:-}" ]; then case "$*" in *"$FAKE_GIT_FAIL"*) exit 1;; esac; fi',
    "",
  ].join("\n");
  writeFileSync(join(bin, "git"), fakeGit, "utf8");
  chmodSync(join(bin, "git"), 0o755);
  const result = spawnSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAKE_GIT_FAIL: failOn },
  });
  const git = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
  rmSync(bin, { recursive: true, force: true });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(typeof result.status, "number", `killed by ${result.signal}`);
  return { code: result.status ?? 1, git, output: `${result.stdout}${result.stderr}` };
};

function fakeConfig(initial: FactoryConfig | null): {
  config: FactoryEffectsDeps["config"];
  set: (c: FactoryConfig | null) => void;
} {
  let current = initial;
  return {
    config: { getFactoryConfig: () => current },
    set: (c) => {
      current = c;
    },
  };
}

const connectorSlot = (host: string, principalId: string, accountType?: string): string =>
  `${host}|${principalId}|${accountType ?? "default"}`;

function fakeConnectorTokens(slots: Record<string, string | string[]>): {
  connectorTokens: FactoryEffectsDeps["connectorTokens"];
  probes: string[];
} {
  const asked = new Map<string, number>();
  const probes: string[] = [];
  return {
    probes,
    connectorTokens: {
      connectorAccessToken: async (host, principalId, accountType) => {
        const key = connectorSlot(host, principalId, accountType);
        probes.push(key);
        const slot = slots[key];
        if (slot === undefined) return null;
        const values = Array.isArray(slot) ? slot : [slot];
        const index = asked.get(key) ?? 0;
        asked.set(key, index + 1);
        return values[Math.min(index, values.length - 1)] ?? null;
      },
    },
  };
}

const grant = (
  host: string,
  token: string | string[],
  over: { principalId?: string; accountType?: string } = {},
): Record<string, string | string[]> => ({
  [connectorSlot(host, over.principalId ?? LOOP.owner, over.accountType)]: token,
});

const linearGrant = grant(LINEAR_HOST, LINEAR_KEY);

const githubProbes = (probes: string[]): string[] => probes.filter((probe) => probe.startsWith(`${GITHUB_HOST}|`));

function fakeLoops(states: (LoopState | null)[]): { loops: FactoryEffectsDeps["loops"]; ids: string[] } {
  const ids: string[] = [];
  return {
    loops: {
      get: async (id) => {
        ids.push(id);
        const state = states[Math.min(ids.length - 1, states.length - 1)];
        return state === null || state === undefined ? null : { ...LOOP, state };
      },
    },
    ids,
  };
}

interface FakeFetch {
  fetch: typeof globalThis.fetch;
  calls: { url: string; init: RequestInit | undefined }[];
}

function fakeFetch(responses: Response[]): FakeFetch {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url: String(url), init });
      const response = responses[calls.length - 1];
      if (!response) return Promise.reject(new Error(`unscripted fetch #${calls.length}`));
      return Promise.resolve(response);
    },
  };
}

const intakePage = (identifiers: string[], endCursor: string | null = null): Response =>
  Response.json({
    data: {
      team: {
        issues: {
          nodes: identifiers.map((identifier, index) => ({
            identifier,
            title: `${identifier} title`,
            createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
            inverseRelations: { nodes: [] },
          })),
          pageInfo: { hasNextPage: endCursor !== null, endCursor },
        },
      },
    },
  });

function fakeModelAuthEnv(...envs: NodeJS.ProcessEnv[]): {
  modelAuthEnv: () => Promise<NodeJS.ProcessEnv>;
  calls: number;
} {
  const stub = {
    calls: 0,
    modelAuthEnv: async (): Promise<NodeJS.ProcessEnv> => {
      const env = envs[Math.min(stub.calls, envs.length - 1)] ?? {};
      stub.calls += 1;
      return env;
    },
  };
  return stub;
}

type SlackInstallationDep = FactoryEffectsDeps["slackInstallation"];
type StoredInstallation = Awaited<ReturnType<SlackInstallationDep["get"]>>;

const orgInstallation = (botToken: string): StoredInstallation => ({
  botToken,
  appToken: "xapp-FAKE_APP_TOKEN",
  teamId: "T1",
  teamName: "Acme",
  updatedAt: 1_000,
  updatedBy: "josh",
  version: "1000:0",
});

function fakeSlackInstallation(...outcomes: (StoredInstallation | Error)[]): {
  slackInstallation: SlackInstallationDep;
  calls: number;
} {
  const stub = {
    calls: 0,
    slackInstallation: {
      get: async (): Promise<StoredInstallation> => {
        const outcome = outcomes[Math.min(stub.calls, outcomes.length - 1)] ?? null;
        stub.calls += 1;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  };
  return stub;
}

interface FakeItems {
  items: FactoryEffectsDeps["items"];
  writes: { id: string; patch: Record<string, unknown> }[];
}

function fakeItems(over: { reject?: boolean; delayMs?: (call: number) => number } = {}): FakeItems {
  const writes: { id: string; patch: Record<string, unknown> }[] = [];
  let calls = 0;
  return {
    writes,
    items: {
      annotate: async (id, patch) => {
        calls += 1;
        const delay = over.delayMs?.(calls) ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (over.reject) throw new Error("loop_item_ledger_down");
        writes.push({ id, patch });
        return { ...ITEM, sourcePayload: { ...patch } };
      },
    },
  };
}

const trails = (fake: FakeItems): FactoryStage[][] => fake.writes.map((write) => write.patch.stages as FactoryStage[]);

const lastTrail = (fake: FakeItems): [string, string][] =>
  (trails(fake).at(-1) ?? []).map((stage) => [stage.name, stage.state]);

const trailReads =
  (...chunks: string[]) =>
  async (n: number): Promise<ReadProcessResult> =>
    n <= chunks.length
      ? { chunks: chunks[n - 1] ?? "", cursor: n, status: { state: "running" } }
      : { chunks: "", cursor: n, status: { state: "exited", code: 0 } };

function deps(over: Partial<FactoryEffectsDeps> = {}): FactoryEffectsDeps {
  return {
    sandbox: fakeSandbox().sandbox,
    config: fakeConfig(CONFIG).config,
    loops: fakeLoops(["enabled"]).loops,
    items: fakeItems().items,
    slackInstallation: fakeSlackInstallation(null).slackInstallation,
    connectorTokens: fakeConnectorTokens({ ...linearGrant, ...grant(GITHUB_HOST, GITHUB_TOKEN) }).connectorTokens,
    modelAuthEnv: fakeModelAuthEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY }).modelAuthEnv,
    ...over,
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to reject");
}

async function workedRunId(effects: FactoryWorkEffects, item: LoopItem = ITEM): Promise<string> {
  const { runId } = await effects.work({ loop: LOOP, item });
  return runId;
}

const tempCloneDir = (t: TestContext): string => {
  const root = mkdtempSync(join(tmpdir(), "factory-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "qm-source");
};

async function recordedBootstrapScript(cloneDir: string, buildSha?: string): Promise<string> {
  const fake = fakeSandbox();
  await workedRunId(createFactoryLoopEffects(deps({ sandbox: fake.sandbox, ...(buildSha ? { buildSha } : {}) })));
  const bootstrap = bootstrapStarts(fake.calls)[0];
  assert.ok(bootstrap);
  return bootstrap.command.replaceAll(CLONE_DIR, cloneDir);
}

test("the composed object exposes exactly the four work-side effects and does no I/O to build them", async () => {
  const fake = fakeSandbox();
  const fetched = fakeFetch([intakePage(["QM-12", "QM-13"])]);
  const config = fakeConfig(CONFIG);
  const effects = createFactoryLoopEffects(
    deps({ sandbox: fake.sandbox, config: config.config, fetch: fetched.fetch }),
  );

  assert.deepEqual(Object.keys(effects).sort(), ["captureOutputs", "enumerate", "evaluate", "work"]);
  assert.equal("ship" in effects, false);
  assert.equal("authorizeAutoShip" in effects, false);
  assert.deepEqual(fake.calls, []);
  assert.equal(fetched.calls.length, 0);

  const candidates = await effects.enumerate(LOOP);
  const blankBoardFields = { url: "", assignee: "", project: "" };
  assert.deepEqual(candidates, [
    { sourceKey: "QM-12", sourceSummary: "QM-12 title", sourcePayload: blankBoardFields },
    { sourceKey: "QM-13", sourceSummary: "QM-13 title", sourcePayload: blankBoardFields },
  ]);
  assert.deepEqual(fake.calls, []);

  const call = fetched.calls[0];
  assert.ok(call);
  assert.equal(call.url, LINEAR_GRAPHQL_URL);
  const body = JSON.parse(String(call.init?.body)) as { variables: Record<string, unknown> };
  assert.equal(body.variables.teamId, "TEAM-1");
});

test("every intake request carries Authorization: Bearer <the owner's Linear connector token>, never the bare token", async () => {
  const fetched = fakeFetch([intakePage(["QM-12"], "CURSOR-1"), intakePage(["QM-13"])]);
  const effects = createFactoryLoopEffects(deps({ fetch: fetched.fetch }));

  await effects.enumerate(LOOP);

  assert.equal(fetched.calls.length, 2);
  for (const call of fetched.calls) {
    assert.equal(call.url, LINEAR_GRAPHQL_URL);
    assert.equal(new Headers(call.init?.headers).get("Authorization"), `Bearer ${LINEAR_KEY}`);
  }
});

test("enumerate re-reads the factory context on every call rather than caching it", async () => {
  const fetched = fakeFetch([intakePage(["QM-12"]), intakePage(["QM-20"])]);
  const config = fakeConfig(CONFIG);
  const effects = createFactoryLoopEffects(deps({ config: config.config, fetch: fetched.fetch }));

  await effects.enumerate(LOOP);
  config.set({ ...CONFIG, linearTeamId: "TEAM-2" });
  await effects.enumerate(LOOP);

  const teamIds = fetched.calls.map(
    (call) => (JSON.parse(String(call.init?.body)) as { variables: { teamId: string } }).variables.teamId,
  );
  assert.deepEqual(teamIds, ["TEAM-1", "TEAM-2"]);
});

test("a Linear failure propagates unwrapped out of enumerate", async () => {
  const fetched = fakeFetch([new Response("nope", { status: 500 })]);
  const effects = createFactoryLoopEffects(deps({ fetch: fetched.fetch }));
  const error = await rejection(effects.enumerate(LOOP));
  assert.equal(error.message, "linear_intake_failed: 500");
});

test("loadFactoryContext resolves the org config, the Linear key and the owner's connector token", async () => {
  const context: FactoryContext = await loadFactoryContext(deps(), LOOP.owner);
  assert.deepEqual(context, {
    config: CONFIG,
    linearApiKey: LINEAR_KEY,
    githubToken: GITHUB_TOKEN,
    modelAuth: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
  });
});

test("a missing factory config fails every entry point before any sandbox, network or connector call", async () => {
  const fake = fakeSandbox();
  const fetched = fakeFetch([]);
  const connector = fakeConnectorTokens({ ...linearGrant, ...grant(GITHUB_HOST, GITHUB_TOKEN) });
  const base = deps({
    sandbox: fake.sandbox,
    config: fakeConfig(null).config,
    fetch: fetched.fetch,
    connectorTokens: connector.connectorTokens,
  });
  const effects = createFactoryLoopEffects(base);

  for (const promise of [loadFactoryContext(base, LOOP.owner), effects.enumerate(LOOP), workedRunId(effects)]) {
    assert.equal((await rejection(promise)).message, "factory_config_missing");
  }
  assert.deepEqual(fake.calls, []);
  assert.equal(fetched.calls.length, 0);
  assert.deepEqual(connector.probes, []);
});

test("a loop owner with no usable Linear connector token fails every entry point before any sandbox or Linear call", async () => {
  for (const slots of [{}, grant(LINEAR_HOST, "   ")]) {
    const fake = fakeSandbox();
    const fetched = fakeFetch([]);
    const base = deps({
      sandbox: fake.sandbox,
      fetch: fetched.fetch,
      connectorTokens: fakeConnectorTokens({ ...slots, ...grant(GITHUB_HOST, GITHUB_TOKEN) }).connectorTokens,
    });
    const effects = createFactoryLoopEffects(base);

    for (const promise of [loadFactoryContext(base, LOOP.owner), effects.enumerate(LOOP), workedRunId(effects)]) {
      assert.equal((await rejection(promise)).message, "linear: the loop owner has not connected Linear");
    }
    assert.deepEqual(fake.calls, []);
    assert.equal(fetched.calls.length, 0);
  }

  const company = fakeConnectorTokens({
    ...grant(LINEAR_HOST, LINEAR_KEY, { accountType: "company" }),
    ...grant(GITHUB_HOST, GITHUB_TOKEN),
  });
  const context = await loadFactoryContext(deps({ connectorTokens: company.connectorTokens }), LOOP.owner);
  assert.equal(context.linearApiKey, LINEAR_KEY);
});

test("work preflights on a warm-released handle, then runs the wrapper with the rendered env", async () => {
  const fake = fakeSandbox();
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));

  const { runId } = await effects.work({ loop: LOOP, item: ITEM, guidance: "smaller diff please" });

  assert.deepEqual(ops(fake.calls), [
    "provision",
    "run",
    "startProcess",
    "readProcess",
    "teardown",
    "provision",
    "startProcess",
    "readProcess",
    "readProcess",
    "readProcess",
    "teardown",
  ]);
  const preflightTeardown = fake.calls.find((call) => call.op === "teardown");
  assert.ok(preflightTeardown?.op === "teardown");
  assert.deepEqual(preflightTeardown.opts, { keepWarm: true });
  const provision = fake.calls[0];
  assert.ok(provision?.op === "provision");
  assert.deepEqual(provision.layers, [{ scopeId: LOOP.ownerScopeId, mode: "rw", mountPath: "" }]);

  const started = wrapperStart(fake.calls);
  assert.equal(started.command, `bash ${FACTORY_SOURCE_DIR}/.claude/io-coding-agent-js.sh ${TICKET}`);
  assert.equal(started.opts?.cwd, REPO_DIR);
  assert.notEqual(started.handle.id, preflightTeardown.handle.id);
  assert.deepEqual(
    started.opts?.env,
    renderFactoryEnv({
      config: CONFIG,
      guidance: "smaller diff please",
      linearApiKey: LINEAR_KEY,
      githubToken: GITHUB_TOKEN,
      modelAuth: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      factorySessionId: factorySessionIdFor("factory:loop-1:item-1"),
      repoDir: REPO_DIR,
      factorySourceDir: FACTORY_SOURCE_DIR,
    }),
  );
  assert.equal(runId, "factory:loop-1:item-1:1");
});

test("work omits IO_FEEDBACK without guidance, honours repoDir, and numbers the run from the item's attempts", async () => {
  const fake = fakeSandbox();
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, repoDir: "/srv/code" }));

  const runId = await workedRunId(effects, { ...ITEM, attempts: 2 });

  const started = wrapperStart(fake.calls);
  assert.equal(started.opts?.cwd, "/srv/code");
  assert.equal("IO_FEEDBACK" in (started.opts?.env ?? {}), false);
  assert.equal(started.opts?.env?.IO_REPO_DIR, "/srv/code");
  assert.equal(started.opts?.env?.IO_FACTORY_SOURCE_DIR, FACTORY_SOURCE_DIR);
  assert.notEqual(started.opts?.env?.IO_FACTORY_SOURCE_DIR, started.opts?.env?.IO_REPO_DIR);
  assert.equal(runId, "factory:loop-1:item-1:3");
});

test("a run with no pull request carries the wrapper's redacted diagnostics in its reason", async () => {
  const stdout = `npm warn noise\n[io-coding-agent] git configured to reach github.com with IO_GITHUB_TOKEN\n[claude-stderr] token ${GITHUB_TOKEN} rejected\n[io-coding-agent-js] FAIL: normal factory runs require a numeric CODING_AGENT_SESSION_URL\n`;
  const fake = fakeSandbox({ stdout });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));

  const runId = await workedRunId(effects);
  const verdict = await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId });

  assert.equal(verdict.outcome, "continue");
  assert.match(verdict.reason, /^no pull request — /);
  assert.match(verdict.reason, /FAIL: normal factory runs require a numeric CODING_AGENT_SESSION_URL/);
  assert.match(verdict.reason, /\[claude-stderr\] token \*\*\* rejected/);
  assert.equal(verdict.reason.includes(GITHUB_TOKEN), false);
  assert.equal(verdict.reason.includes("npm warn"), false);
});

test("loadFactoryContext re-resolves modelAuthEnv per run, so a rotated core credential reaches the next run without a restart", async () => {
  const fake = fakeSandbox();
  const auth = fakeModelAuthEnv({ ANTHROPIC_API_KEY: "key-before" }, { ANTHROPIC_API_KEY: "key-after" });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, modelAuthEnv: auth.modelAuthEnv }));

  await workedRunId(effects);
  await workedRunId(effects, { ...ITEM, attempts: 1 });

  assert.deepEqual(
    wrapperEnvs(fake.calls).map((env) => env.ANTHROPIC_API_KEY),
    ["key-before", "key-after"],
  );
  assert.equal(auth.calls, 2);
});

test("a model auth env with no credential key fails every entry point with the model-auth note and no sandbox call", async () => {
  const empty: NodeJS.ProcessEnv[] = [{}, { ANTHROPIC_BASE_URL: "https://gw.internal" }, { ANTHROPIC_API_KEY: "   " }];
  for (const env of empty) {
    const fake = fakeSandbox();
    const fetched = fakeFetch([]);
    const base = deps({
      sandbox: fake.sandbox,
      fetch: fetched.fetch,
      modelAuthEnv: fakeModelAuthEnv(env).modelAuthEnv,
    });
    const effects = createFactoryLoopEffects(base);

    for (const promise of [loadFactoryContext(base, LOOP.owner), effects.enumerate(LOOP), workedRunId(effects)]) {
      assert.equal(
        (await rejection(promise)).message,
        "model auth: core has no Anthropic credential configured",
        JSON.stringify(env),
      );
    }
    assert.deepEqual(fake.calls, []);
    assert.equal(fetched.calls.length, 0);
  }
});

test("a deployment missing its Linear grant, its model auth and its GitHub grant is told about Linear first", async () => {
  const base = deps({
    modelAuthEnv: fakeModelAuthEnv({}).modelAuthEnv,
    connectorTokens: fakeConnectorTokens({}).connectorTokens,
  });

  assert.equal(
    (await rejection(loadFactoryContext(base, LOOP.owner))).message,
    "linear: the loop owner has not connected Linear",
  );
});

test("the sandbox's IO_GITHUB_TOKEN and the bootstrap git env are the owner's connector token", async () => {
  const fake = fakeSandbox();
  const connector = fakeConnectorTokens({ ...linearGrant, ...grant(GITHUB_HOST, GITHUB_TOKEN) });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, connectorTokens: connector.connectorTokens }));

  await workedRunId(effects);

  assert.ok(githubProbes(connector.probes).length > 0, "the connector store was never asked for GitHub");
  for (const probe of githubProbes(connector.probes))
    assert.ok(probe.startsWith(`${GITHUB_HOST}|${LOOP.owner}|`), `asked for ${probe}`);
  assert.equal(wrapperStart(fake.calls).opts?.env?.IO_GITHUB_TOKEN, GITHUB_TOKEN);
  assert.equal(
    bootstrapStarts(fake.calls)[0]?.opts?.env?.GIT_CONFIG_KEY_0,
    `url.https://x-access-token:${GITHUB_TOKEN}@github.com/.insteadOf`,
  );
});

const unconnectedGrants: [string, Record<string, string | string[]>][] = [
  ["no GitHub grant at all", {}],
  ["a whitespace-only access token", grant(GITHUB_HOST, "   ")],
];

for (const [label, slots] of unconnectedGrants) {
  test(`a loop owner with ${label} fails every entry point before any sandbox or Linear call`, async () => {
    const fake = fakeSandbox();
    const fetched = fakeFetch([]);
    const base = deps({
      sandbox: fake.sandbox,
      fetch: fetched.fetch,
      connectorTokens: fakeConnectorTokens({ ...linearGrant, ...slots }).connectorTokens,
    });
    const effects = createFactoryLoopEffects(base);

    for (const promise of [loadFactoryContext(base, LOOP.owner), effects.enumerate(LOOP), workedRunId(effects)]) {
      assert.equal((await rejection(promise)).message, "github: the loop owner has not connected GitHub");
    }
    assert.deepEqual(fake.calls, []);
    assert.equal(fetched.calls.length, 0);
  });
}

test("an owner who connected GitHub under a personal or company account is resolved, not treated as disconnected", async () => {
  const personal = fakeConnectorTokens({
    ...linearGrant,
    ...grant(GITHUB_HOST, "gho_PERSONAL", { accountType: "personal" }),
  });
  const personalContext = await loadFactoryContext(deps({ connectorTokens: personal.connectorTokens }), LOOP.owner);
  assert.equal(personalContext.githubToken, "gho_PERSONAL");
  assert.deepEqual(githubProbes(personal.probes), [connectorSlot(GITHUB_HOST, LOOP.owner, "personal")]);

  const company = fakeConnectorTokens({
    ...linearGrant,
    ...grant(GITHUB_HOST, "gho_COMPANY", { accountType: "company" }),
  });
  const companyContext = await loadFactoryContext(deps({ connectorTokens: company.connectorTokens }), LOOP.owner);
  assert.equal(companyContext.githubToken, "gho_COMPANY");
  assert.deepEqual(githubProbes(company.probes), [
    connectorSlot(GITHUB_HOST, LOOP.owner, "personal"),
    connectorSlot(GITHUB_HOST, LOOP.owner),
    connectorSlot(GITHUB_HOST, LOOP.owner, "company"),
  ]);
});

test("the token is never cached, so a refreshed grant reaches the next run and the forge poll without a restart", async () => {
  const fake = fakeSandbox();
  const fetched = fakeFetch(convergedForge());
  const effects = createFactoryLoopEffects(
    deps({
      sandbox: fake.sandbox,
      fetch: fetched.fetch,
      connectorTokens: fakeConnectorTokens({
        ...linearGrant,
        ...grant(GITHUB_HOST, ["gho_1", "gho_2", "gho_3"]),
      }).connectorTokens,
    }),
  );

  await workedRunId(effects);
  const runId = await workedRunId(effects, { ...ITEM, attempts: 1 });
  await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId });

  assert.deepEqual(
    wrapperEnvs(fake.calls).map((env) => env.IO_GITHUB_TOKEN),
    ["gho_1", "gho_2"],
  );
  assert.equal(new Headers(fetched.calls[0]?.init?.headers).get("Authorization"), "Bearer gho_3");
});

test("resolution is keyed by the firing loop's owner, not by a fixed principal", async () => {
  const otherOwner = "U2";
  const connector = fakeConnectorTokens({
    ...linearGrant,
    ...grant(LINEAR_HOST, LINEAR_KEY, { principalId: otherOwner }),
    ...grant(GITHUB_HOST, GITHUB_TOKEN, { principalId: otherOwner }),
  });
  const base = deps({ connectorTokens: connector.connectorTokens });
  const effects = createFactoryLoopEffects(base);

  assert.equal((await loadFactoryContext(base, otherOwner)).githubToken, GITHUB_TOKEN);
  assert.equal(
    (await rejection(effects.work({ loop: LOOP, item: ITEM }))).message,
    "github: the loop owner has not connected GitHub",
  );
  assert.ok(connector.probes.includes(connectorSlot(GITHUB_HOST, LOOP.owner)), connector.probes.join(", "));
});

test("the sandbox env carries exactly the model-auth and base-URL keys core resolved, and none of the other env it was handed", async () => {
  const fake = fakeSandbox();
  const effects = createFactoryLoopEffects(
    deps({
      sandbox: fake.sandbox,
      modelAuthEnv: fakeModelAuthEnv({
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        ANTHROPIC_AUTH_TOKEN: "auth-token",
        ANTHROPIC_BASE_URL: "https://gw.internal",
        PATH: "/usr/bin",
        HTTP_PROXY: "http://proxy.internal:3128",
        HOME: "/root",
        TMPDIR: "/tmp",
      }).modelAuthEnv,
    }),
  );

  await workedRunId(effects);

  const env = wrapperEnvs(fake.calls)[0] ?? {};
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-token");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "auth-token");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://gw.internal");
  for (const key of ["ANTHROPIC_API_KEY", "PATH", "HTTP_PROXY", "HOME", "TMPDIR"]) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not reach the sandbox`);
  }
});

test("the no-PR diagnostic tail redacts a resolved model token but leaves the base URL readable", async () => {
  const stdout = [
    "[claude-stderr] token oauth-token rejected",
    "[io-coding-agent-js] FAIL: https://gw.internal refused the request",
    "",
  ].join("\n");
  const fake = fakeSandbox({ stdout });
  const effects = createFactoryLoopEffects(
    deps({
      sandbox: fake.sandbox,
      modelAuthEnv: fakeModelAuthEnv({
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        ANTHROPIC_BASE_URL: "https://gw.internal",
      }).modelAuthEnv,
    }),
  );

  const runId = await workedRunId(effects);
  const verdict = await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId });

  assert.match(verdict.reason, /\[claude-stderr\] token \*\*\* rejected/);
  assert.match(verdict.reason, /FAIL: https:\/\/gw\.internal refused the request/);
});

test("a modelAuthEnv that rejects surfaces its own failure instead of being swallowed into the no-credential note", async () => {
  const base = deps({
    modelAuthEnv: () => Promise.reject(new Error("keychain_unavailable")),
  });

  assert.equal((await rejection(loadFactoryContext(base, LOOP.owner))).message, "keychain_unavailable");
});

test("factorySessionIdFor is a stable positive integer per item and differs across items and loops", () => {
  const a = factorySessionIdFor("factory:loop-1:item-1");
  assert.equal(a, factorySessionIdFor("factory:loop-1:item-1"));
  assert.ok(Number.isInteger(a) && a > 0 && a <= 2_000_000_000);
  assert.notEqual(a, factorySessionIdFor("factory:loop-1:item-2"));
  assert.notEqual(a, factorySessionIdFor("factory:loop-2:item-1"));
});

test("a second attempt of the same item launches the wrapper with the same session id", async () => {
  const first = fakeSandbox();
  await createFactoryLoopEffects(deps({ sandbox: first.sandbox })).work({ loop: LOOP, item: ITEM });
  const second = fakeSandbox();
  await createFactoryLoopEffects(deps({ sandbox: second.sandbox })).work({
    loop: LOOP,
    item: { ...ITEM, attempts: 1 },
  });
  const sessionOf = (calls: Call[]) => wrapperStart(calls).opts?.env?.IO_FACTORY_SESSION_ID;
  assert.ok(sessionOf(first.calls));
  assert.equal(sessionOf(second.calls), sessionOf(first.calls));
});

test("work bootstraps the factory control plane on the preflight handle before the wrapper, once per call", async () => {
  const fake = fakeSandbox();
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));

  await workedRunId(effects);

  assert.ok(FACTORY_SOURCE_DIR.startsWith(`${CLONE_DIR}/`), FACTORY_SOURCE_DIR);
  const bootstraps = bootstrapStarts(fake.calls);
  assert.equal(bootstraps.length, 1);
  const bootstrap = bootstraps[0];
  assert.ok(bootstrap);
  assert.ok(fake.calls.indexOf(bootstrap) < fake.calls.indexOf(wrapperStart(fake.calls)));
  const preflightProvision = fake.calls[0];
  assert.ok(preflightProvision?.op === "provision");
  assert.equal(bootstrap.handle.id, preflightProvision.handle.id);

  await workedRunId(effects, { ...ITEM, attempts: 1 });
  assert.equal(bootstrapStarts(fake.calls).length, 2);
});

test("the bootstrap command initializes a cold checkout and converges a warm one without re-cloning", async (t) => {
  const cloneDir = tempCloneDir(t);
  const script = await recordedBootstrapScript(cloneDir);

  const cold = runWithFakeGit(script);

  assert.equal(cold.code, 0, cold.output);
  assert.deepEqual(cold.git, [
    `init -q ${cloneDir}`,
    `-C ${cloneDir} remote add origin ${CLONE_URL}`,
    `-C ${cloneDir} fetch --depth 1 origin ${FACTORY_SOURCE_DEFAULT_REF}`,
    `-C ${cloneDir} checkout -f FETCH_HEAD`,
  ]);

  mkdirSync(join(cloneDir, ".git"), { recursive: true });
  const warm = runWithFakeGit(script);

  assert.equal(warm.code, 0, warm.output);
  assert.deepEqual(warm.git, [
    `-C ${cloneDir} fetch --depth 1 origin ${FACTORY_SOURCE_DEFAULT_REF}`,
    `-C ${cloneDir} checkout -f FETCH_HEAD`,
  ]);
});

test("a core that knows its build commit fetches the wrapper at that exact commit", async (t) => {
  const cloneDir = tempCloneDir(t);
  const script = await recordedBootstrapScript(cloneDir, "0123abcd4567ef890123abcd4567ef8901234567-dirty");

  const result = runWithFakeGit(script);

  assert.equal(result.code, 0, result.output);
  assert.ok(
    result.git.includes(`-C ${cloneDir} fetch --depth 1 origin 0123abcd4567ef890123abcd4567ef8901234567`),
    result.git.join("\n"),
  );
  assert.equal(
    result.git.some((line) => line.includes("-dirty")),
    false,
  );
});

test("factorySourceRef pins a real commit and falls back to the default branch otherwise", () => {
  assert.equal(
    factorySourceRef("2d10c86b6863a99edd0eab891a6dde17d6ac60f1"),
    "2d10c86b6863a99edd0eab891a6dde17d6ac60f1",
  );
  assert.equal(
    factorySourceRef("2d10c86b6863a99edd0eab891a6dde17d6ac60f1-dirty"),
    "2d10c86b6863a99edd0eab891a6dde17d6ac60f1",
  );
  assert.equal(factorySourceRef("2d10c86"), FACTORY_SOURCE_DEFAULT_REF);
  assert.equal(factorySourceRef("2d10c86-dirty"), FACTORY_SOURCE_DEFAULT_REF);
  assert.equal(factorySourceRef(undefined), FACTORY_SOURCE_DEFAULT_REF);
  assert.equal(factorySourceRef(""), FACTORY_SOURCE_DEFAULT_REF);
  assert.equal(factorySourceRef("main; rm -rf /"), FACTORY_SOURCE_DEFAULT_REF);
  assert.equal(factorySourceRef("abc"), FACTORY_SOURCE_DEFAULT_REF);
});

test("a failed fetch fails the bootstrap instead of checking out a stale FETCH_HEAD", async (t) => {
  const cloneDir = tempCloneDir(t);
  const script = await recordedBootstrapScript(cloneDir);
  mkdirSync(join(cloneDir, ".git"), { recursive: true });

  const result = runWithFakeGit(script, "fetch");

  assert.notEqual(result.code, 0);
  assert.deepEqual(result.git, [`-C ${cloneDir} fetch --depth 1 origin ${FACTORY_SOURCE_DEFAULT_REF}`]);
});

test("a bootstrap that exits non-zero fails the run loudly, starts no wrapper and stores nothing", async () => {
  const fake = fakeSandbox({ bootstrapExit: 128 });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));

  const error = await rejection(workedRunId(effects));

  assert.equal(error.message, "factory_source_bootstrap_failed: exit 128");
  assert.deepEqual(ops(fake.calls), ["provision", "run", "startProcess", "readProcess", "teardown"]);
  assert.equal(
    fake.calls.some((call) => call.op === "startProcess" && call.command.includes(FACTORY_WRAPPER)),
    false,
  );
  const teardown = fake.calls.find((call) => call.op === "teardown");
  assert.ok(teardown?.op === "teardown");
  assert.deepEqual(teardown.opts, { keepWarm: true });
  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId: "factory:loop-1:item-1:1" }), []);
});

test("a failed bootstrap names git's reason in the error and masks the token", async () => {
  const fake = fakeSandbox({
    bootstrapExit: 128,
    bootstrapOutput: `Cloning into '/workspace/qm-source'...\nfatal: could not read Username for 'https://github.com/': terminal prompts disabled\nremote: ${GITHUB_TOKEN}\n`,
  });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));

  const error = await rejection(workedRunId(effects));

  assert.match(error.message, /^factory_source_bootstrap_failed: exit 128 — /);
  assert.match(error.message, /could not read Username/);
  assert.equal(error.message.includes(GITHUB_TOKEN), false);
  assert.match(error.message, /\*\*\*/);
});

test("the bootstrap authenticates through the process env alone and never puts the token in a command", async () => {
  const fake = fakeSandbox();
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));

  await workedRunId(effects);

  for (const call of fake.calls) {
    if (call.op === "run" || call.op === "startProcess") {
      assert.equal(call.command.includes(GITHUB_TOKEN), false, call.command);
    }
  }
  const bootstrap = bootstrapStarts(fake.calls)[0];
  assert.ok(bootstrap);
  assert.deepEqual(bootstrap.opts?.env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.https://x-access-token:${GITHUB_TOKEN}@github.com/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
  });
});

test("a preflight that misses tools names them and never starts the wrapper", async () => {
  const fake = fakeSandbox({ probeMissing: ["jq", "gh"] });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));

  const error = await rejection(workedRunId(effects));

  assert.equal(error.message, "factory_preflight_failed: missing_tools: gh, jq");
  assert.deepEqual(ops(fake.calls), ["provision", "run", "teardown"]);
});

test("a sandbox without process sessions fails preflight instead of leaking a capability error", async () => {
  const fake = fakeSandbox({ processSessions: false });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));

  const error = await rejection(workedRunId(effects));

  assert.equal(error.message, "factory_preflight_failed: no_process_sessions");
  assert.equal(error.name, "Error");
  assert.deepEqual(ops(fake.calls), ["provision", "teardown"]);
});

test("captureOutputs parses the stored stdout for the returned runId and yields [] for anything else", async () => {
  const fake = fakeSandbox();
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));
  const runId = await workedRunId(effects);

  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId }), [OPEN_PR_ARTIFACT]);
  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId: "factory:nope:nope:1" }), []);
});

test("captureOutputs reports an already-fixed run and an empty run from the same stored stdout", async () => {
  const silent = createFactoryLoopEffects(deps({ sandbox: fakeSandbox({ stdout: "nothing here\n" }).sandbox }));
  assert.deepEqual(await silent.captureOutputs({ loop: LOOP, item: ITEM, runId: await workedRunId(silent) }), []);

  const fixed = createFactoryLoopEffects(
    deps({ sandbox: fakeSandbox({ stdout: "ALREADY_FIXED:true\nALREADY_FIXED_EVIDENCE:landed in main\n" }).sandbox }),
  );
  assert.deepEqual(await fixed.captureOutputs({ loop: LOOP, item: ITEM, runId: await workedRunId(fixed) }), [
    {
      shipAction: "close_already_fixed",
      title: "QM-12: already fixed",
      capturedBy: "classifier",
      summary: "landed in main",
    },
  ]);
});

test("captureOutputs parses against the forge the run executed with", async () => {
  const config = fakeConfig({ ...CONFIG, forge: "gitlab", publishProject: "acme%2Fapp" });
  const effects = createFactoryLoopEffects(deps({ config: config.config }));
  const runId = await workedRunId(effects);

  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId }), [
    { ...OPEN_PR_ARTIFACT, externalRef: "https://gitlab.com/acme/app/-/merge_requests/42" },
  ]);
});

test("evaluate reads the pull request from the forge and provisions no sandbox", async () => {
  const fake = fakeSandbox();
  const fetched = fakeFetch(convergedForge());
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, fetch: fetched.fetch }));
  const runId = await workedRunId(effects);
  const before = fake.calls.length;

  const verdict = await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId });

  assert.equal(verdict.outcome, "met");
  assert.equal(verdict.reason, "converged");
  assert.equal(verdict.judged, false);
  assert.deepEqual(
    verdict.checks.map((check) => check.command),
    [...FORGE_CHECKS],
  );
  assert.equal(fake.calls.length, before);
  const first = fetched.calls[0];
  assert.ok(first);
  assert.equal(first.url, GH_PULL);
  assert.equal(fetched.calls[1]?.url, "https://api.github.com/repos/acme/app/branches/fix/qm-12");
  assert.equal(new Headers(first.init?.headers).get("Authorization"), `Bearer ${GITHUB_TOKEN}`);
});

test("evaluate reports the first failing forge check without an attempt cap", async () => {
  const fetched = fakeFetch([
    Response.json({ head: { sha: HEAD_SHA }, mergeable: true, mergeable_state: "clean" }),
    Response.json({ commit: { sha: HEAD_SHA } }),
    Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] }),
  ]);
  const effects = createFactoryLoopEffects(deps({ fetch: fetched.fetch }));
  const runId = await workedRunId(effects);

  const verdict = await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 9, runId });

  assert.deepEqual(verdict, {
    outcome: "continue",
    reason: "check failed: ci_green_on_head — test",
    judged: false,
    checks: [
      { command: "exact_head", passed: true },
      { command: "ci_green_on_head", passed: false, detail: "test" },
    ],
  });
});

test("evaluate settles an already-fixed run as met without touching the forge or the sandbox", async () => {
  const fake = fakeSandbox({ stdout: "ALREADY_FIXED:true\nALREADY_FIXED_EVIDENCE:landed in main\n" });
  const fetched = fakeFetch([]);
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, fetch: fetched.fetch }));
  const runId = await workedRunId(effects);
  const before = fake.calls.length;

  const verdict = await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId });

  assert.deepEqual(verdict, { outcome: "met", reason: "already fixed", checks: [], judged: false });
  assert.equal(fake.calls.length, before);
  assert.equal(fetched.calls.length, 0);
});

test("evaluate uses the config the run executed with, not a config edited since", async () => {
  const config = fakeConfig(CONFIG);
  const fetched = fakeFetch(convergedForge());
  const effects = createFactoryLoopEffects(deps({ config: config.config, fetch: fetched.fetch }));
  const runId = await workedRunId(effects);

  config.set({ ...CONFIG, forge: "gitlab", publishProject: "acme%2Fapp", bugbotRequired: false });
  const verdict = await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId });

  assert.equal(verdict.outcome, "met");
  assert.equal(fetched.calls[0]?.url, GH_PULL);
  assert.equal(fetched.calls.length, 5);
});

test("a forge failure propagates unwrapped out of evaluate", async () => {
  const fetched = fakeFetch([new Response("nope", { status: 403 })]);
  const effects = createFactoryLoopEffects(deps({ fetch: fetched.fetch }));
  const runId = await workedRunId(effects);

  const error = await rejection(effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId }));

  assert.equal(error.message, "forge_evaluate_failed: 403");
  assert.equal(error.message.includes(GITHUB_TOKEN), false);
});

test("evaluate releases the stored run whatever the outcome", async () => {
  for (const responses of [convergedForge(), [new Response("nope", { status: 403 })]]) {
    const effects = createFactoryLoopEffects(deps({ fetch: fakeFetch(responses).fetch }));
    const runId = await workedRunId(effects);
    assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId }), [OPEN_PR_ARTIFACT]);

    await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId }).catch(() => undefined);

    assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId }), []);
    assert.deepEqual(await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId }), {
      outcome: "continue",
      reason: "no pull request",
      checks: [],
      judged: false,
    });
  }
});

test("a fresh attempt for an item evicts the previous attempt's stored run and leaves other items alone", async () => {
  const effects = createFactoryLoopEffects(deps({ sandbox: fakeSandbox().sandbox }));
  const other = { ...ITEM, id: "item-2" };

  const first = await workedRunId(effects);
  const otherRunId = await workedRunId(effects, other);
  const second = await workedRunId(effects, { ...ITEM, attempts: 1 });

  assert.equal(first, "factory:loop-1:item-1:1");
  assert.equal(second, "factory:loop-1:item-1:2");
  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId: first }), []);
  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId: second }), [OPEN_PR_ARTIFACT]);
  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: other, runId: otherRunId }), [OPEN_PR_ARTIFACT]);
});

test("a teardown that rejects neither loses the run nor masks a preflight failure", async () => {
  const teardownError = new Error("warm release refused");
  const fake = fakeSandbox({ teardownError });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox }));

  const runId = await workedRunId(effects);

  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId }), [OPEN_PR_ARTIFACT]);
  assert.equal(fake.calls.filter((call) => call.op === "teardown").length, 2);

  const missingTool = createFactoryLoopEffects(
    deps({ sandbox: fakeSandbox({ teardownError, probeMissing: ["gh"] }).sandbox }),
  );
  assert.equal((await rejection(workedRunId(missingTool))).message, "factory_preflight_failed: missing_tools: gh");
});

test("evaluate returns the no-pull-request verdict without provisioning when there is no open_pr", async () => {
  const fake = fakeSandbox({ stdout: "nothing here\n" });
  const fetched = fakeFetch([]);
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, fetch: fetched.fetch }));
  const runId = await workedRunId(effects);
  const before = fake.calls.length;

  const noPr = await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId });
  const unknown = await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId: "factory:nope:nope:1" });

  const expected = { outcome: "continue", reason: "no pull request", checks: [], judged: false };
  assert.deepEqual(noPr, expected);
  assert.deepEqual(unknown, expected);
  assert.notEqual(noPr.checks, unknown.checks);
  assert.equal(fake.calls.length, before);
  assert.equal(fetched.calls.length, 0);
});

test("pausing the loop mid-run terminates the process, rejects work, and stores nothing", async () => {
  for (const state of [null, "paused", "archived", "quarantined"] as const) {
    const fake = fakeSandbox({
      read: async (_n, calls) => {
        const terminated = calls.some((call) => call.op === "signalProcess");
        if (terminated) return { chunks: "", cursor: 0, status: { state: "exited", code: 143 } };
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { chunks: "", cursor: 0, status: { state: "running" } };
      },
    });
    const loops = fakeLoops(["enabled", state]);
    const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, loops: loops.loops, pausePollMs: 5 }));

    const error = await rejection(effects.work({ loop: LOOP, item: ITEM }));

    assert.equal(error.message, "factory_run_aborted", `state ${String(state)}`);
    assert.ok(loops.ids.length >= 2, `state ${String(state)} polled ${loops.ids.length} times`);
    assert.deepEqual(new Set(loops.ids), new Set([LOOP.id]));
    const signal = fake.calls.find((call) => call.op === "signalProcess");
    assert.ok(signal?.op === "signalProcess");
    assert.equal(signal.signal, "TERM");
    const started = wrapperStart(fake.calls);
    assert.equal(signal.processId, started.processId);
    assert.equal(signal.handle.id, started.handle.id);
    assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId: "factory:loop-1:item-1:1" }), []);
  }
});

test("an enabled loop is never signalled and the pause poll stops when the process returns", async () => {
  const fake = fakeSandbox();
  const loops = fakeLoops(["enabled"]);
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, loops: loops.loops, pausePollMs: 1 }));

  const runId = await workedRunId(effects);
  const polledAtReturn = loops.ids.length;
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(runId, "factory:loop-1:item-1:1");
  assert.equal(
    fake.calls.some((call) => call.op === "signalProcess"),
    false,
  );
  assert.equal(loops.ids.length, polledAtReturn);
});

test("a stage line split across two chunks still lands, and the exit closes the last stage", async () => {
  const items = fakeItems();
  const fake = fakeSandbox({
    read: trailReads("working\n[trail] [Fetch] a\n[trail] [Anal", "yze] b\nBRANCH:fix/qm-12\nMR:42\n"),
  });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  const runId = await workedRunId(effects);

  assert.deepEqual(lastTrail(items), [
    ["Fetch", "done"],
    ["Analyze", "done"],
  ]);
  assert.deepEqual(
    items.writes.map((write) => write.id),
    [ITEM.id, ITEM.id, ITEM.id],
  );
  assert.deepEqual([...new Set(items.writes.flatMap((write) => Object.keys(write.patch)))], ["stages"]);
  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId }), [OPEN_PR_ARTIFACT]);
});

test("the write a stage opens marks it active and the one before it done, so a live run shows where it is", async () => {
  const items = fakeItems();
  const fake = fakeSandbox({ read: trailReads("[trail] [Fetch] a\n", "[trail] [Analyze] b\n") });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  await workedRunId(effects);

  assert.deepEqual(
    trails(items).map((stages) => stages.map((stage) => [stage.name, stage.state])),
    [
      [["Fetch", "active"]],
      [
        ["Fetch", "done"],
        ["Analyze", "active"],
      ],
      [
        ["Fetch", "done"],
        ["Analyze", "done"],
      ],
    ],
  );
});

test("trail-channel noise never becomes a stage, and the trail writes once per change, not once per line", async () => {
  const items = fakeItems();
  const fake = fakeSandbox({
    read: trailReads(
      "[trail] --- streaming /tmp/trail\n[trail] [Setup] a\n[trail] [Setup] b\n[trail] [Fetch] c\n",
      "[bogus] x\n[Bogus] y\nnote: [trail] [Ship] z\n[trail] [setup] w\n[trail] [Analyze] d\n",
      "[trail:final] [Review] r\n[trail:final] [Ship] s\n",
    ),
  });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  await workedRunId(effects);

  assert.deepEqual(lastTrail(items), [
    ["Setup", "done"],
    ["Fetch", "done"],
    ["Analyze", "done"],
  ]);
  assert.deepEqual(
    trails(items).map((stages) => stages.length),
    [1, 2, 3, 3],
  );
});

test("a second Verify after Review appends a third entry instead of reusing the first", async () => {
  const items = fakeItems();
  const fake = fakeSandbox({
    read: trailReads("[trail] [Verify] one\n", "[trail] [Review] two\n", "[trail] [Verify] three\n"),
  });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  await workedRunId(effects);

  assert.deepEqual(lastTrail(items), [
    ["Verify", "done"],
    ["Review", "done"],
    ["Verify", "done"],
  ]);
  const first = trails(items)[0]?.[0];
  assert.equal(typeof first?.ts, "number");
  assert.equal(trails(items).at(-1)?.[0]?.ts, first?.ts);
});

test("a run with more stage changes than the cap keeps the newest 40, dropping the oldest", async () => {
  const changes = Array.from({ length: 45 }, (_, i) => `[trail] [${FACTORY_STAGES[i % 10]}] step ${i}\n`);
  const items = fakeItems();
  const fake = fakeSandbox({ read: trailReads(changes.join("")) });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  await workedRunId(effects);

  assert.deepEqual(
    lastTrail(items),
    Array.from({ length: 40 }, (_, i) => [FACTORY_STAGES[(i + 5) % 10], "done"]),
  );
  assert.equal(
    trails(items).every((stages) => stages.length <= 40),
    true,
  );
});

test("an over-long unterminated line keeps its head, so the stage it opens still matches", async () => {
  const items = fakeItems();
  const fake = fakeSandbox({
    read: trailReads(`[trail] [Ship] ${"x".repeat(20_000)}`, `${"y".repeat(20_000)}\n`),
  });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  await workedRunId(effects);

  assert.deepEqual(lastTrail(items), [["Ship", "done"]]);
});

test("a trail line the wrapper never terminated with a newline is still recorded at exit", async () => {
  const items = fakeItems();
  const fake = fakeSandbox({ read: trailReads("[trail] [Plan] a\n[trail] [Ship] cut off mid-line") });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  await workedRunId(effects);

  assert.deepEqual(lastTrail(items), [
    ["Plan", "done"],
    ["Ship", "done"],
  ]);
});

test("a run whose stdout carries no trail line writes no stages at all", async () => {
  const items = fakeItems();
  const effects = createFactoryLoopEffects(deps({ items: items.items }));

  await workedRunId(effects);

  assert.deepEqual(items.writes, []);
});

test("a ledger that rejects every annotate cannot kill the run", async () => {
  const items = fakeItems({ reject: true });
  const fake = fakeSandbox({ stdout: `[trail] [Setup] a\n${WORK_STDOUT}` });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  const runId = await workedRunId(effects);

  assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId }), [OPEN_PR_ARTIFACT]);
  assert.deepEqual(items.writes, []);
});

test("a slow first annotate cannot land after, and overwrite, the longer trail that follows it", async () => {
  const items = fakeItems({ delayMs: (call) => (call === 1 ? 20 : 0) });
  const fake = fakeSandbox({ read: trailReads("[trail] [Fetch] a\n", "[trail] [Analyze] b\n") });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  await workedRunId(effects);

  assert.deepEqual(
    trails(items).map((stages) => stages.length),
    [1, 2, 2],
  );
  assert.deepEqual(lastTrail(items), [
    ["Fetch", "done"],
    ["Analyze", "done"],
  ]);
});

test("an aborted run still persists its trail with the last stage closed", async () => {
  const items = fakeItems();
  const fake = fakeSandbox({
    read: async (n, calls) => {
      if (n === 1) return { chunks: "[trail] [Implement] a\n", cursor: n, status: { state: "running" } };
      if (calls.some((call) => call.op === "signalProcess"))
        return { chunks: "", cursor: n, status: { state: "exited", code: 143 } };
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { chunks: "", cursor: n, status: { state: "running" } };
    },
  });
  const loops = fakeLoops(["enabled", "paused"]);
  const effects = createFactoryLoopEffects(
    deps({ sandbox: fake.sandbox, items: items.items, loops: loops.loops, pausePollMs: 5 }),
  );

  const error = await rejection(effects.work({ loop: LOOP, item: ITEM }));

  assert.equal(error.message, "factory_run_aborted");
  assert.deepEqual(lastTrail(items), [["Implement", "done"]]);
});

test("a wrapper that vanishes mid-run still closes the stage it was on", async () => {
  const items = fakeItems();
  const fake = fakeSandbox({
    read: async (n) => {
      if (n > 1) throw new Error("no such process p2");
      return { chunks: "[trail] [Implement] a\n", cursor: n, status: { state: "running" } };
    },
  });
  const effects = createFactoryLoopEffects(deps({ sandbox: fake.sandbox, items: items.items }));

  const error = await rejection(effects.work({ loop: LOOP, item: ITEM }));

  assert.match(error.message, /no such process/);
  assert.deepEqual(lastTrail(items), [["Implement", "done"]]);
});

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const SLACK_CHANNEL = "#factory-runs";
const SLACK_RESOLVED_CHANNEL = "C0RESOLVED";
const SLACK_TS = "1730000000.000100";
const SLACK_CONFIG: FactoryConfig = { ...CONFIG, slackChannel: SLACK_CHANNEL };

interface SlackPost {
  url: string;
  init: RequestInit | undefined;
  bootstraps: number;
  wrapperStarted: boolean;
}

function slackFetch(
  sandboxCalls: Call[],
  responses: (() => Promise<Response> | Response)[],
): { fetch: typeof globalThis.fetch; posts: SlackPost[] } {
  const posts: SlackPost[] = [];
  return {
    posts,
    fetch: (url, init) => {
      posts.push({
        url: String(url),
        init,
        bootstraps: bootstrapStarts(sandboxCalls).length,
        wrapperStarted: sandboxCalls.some(
          (call) => call.op === "startProcess" && call.command.includes(FACTORY_WRAPPER),
        ),
      });
      const respond = responses[posts.length - 1];
      if (!respond) return Promise.reject(new Error(`unscripted fetch #${posts.length}`));
      return Promise.resolve(respond());
    },
  };
}

async function capturingWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

const slackRoot =
  (body: Record<string, unknown>): (() => Response) =>
  () =>
    Response.json(body);

test("work posts the thread root as the org's Slack installation and threads the returned ts into the wrapper env", async () => {
  const fake = fakeSandbox();
  const posted = slackFetch(fake.calls, [slackRoot({ ok: true, ts: SLACK_TS, channel: SLACK_RESOLVED_CHANNEL })]);
  const store = fakeSlackInstallation(orgInstallation(INSTALLATION_TOKEN));
  const effects = createFactoryLoopEffects(
    deps({
      sandbox: fake.sandbox,
      config: fakeConfig(SLACK_CONFIG).config,
      slackInstallation: store.slackInstallation,
      fetch: posted.fetch,
    }),
  );

  const { result: runId, warnings } = await capturingWarnings(() => workedRunId(effects));

  assert.equal(posted.posts.length, 1);
  const post = posted.posts[0]!;
  assert.equal(post.url, SLACK_POST_URL);
  assert.equal(post.init?.method, "POST");
  assert.equal(new Headers(post.init?.headers).get("Authorization"), `Bearer ${INSTALLATION_TOKEN}`);
  assert.equal(new Headers(post.init?.headers).get("Content-Type"), "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(String(post.init?.body)), { channel: SLACK_CHANNEL, text: `Working on ${TICKET}` });
  assert.ok(post.init?.signal instanceof AbortSignal, "the post was unbounded: it carried no abort signal");
  assert.equal(post.bootstraps, 1, "the root was posted before the source bootstrap");
  assert.equal(post.wrapperStarted, false, "the root was posted after the wrapper started");
  assert.equal(store.calls, 1);

  const env = wrapperStart(fake.calls).opts?.env;
  assert.equal(env?.SLACK_BOT_TOKEN, INSTALLATION_TOKEN);
  assert.equal(env?.SLACK_CHANNEL_ID, SLACK_RESOLVED_CHANNEL);
  assert.equal(env?.SLACK_THREAD_TS, SLACK_TS);
  assert.equal(runId, "factory:loop-1:item-1:1");

  assert.deepEqual(warnings, []);
});

test("the no-PR diagnostic tail redacts the org installation bot token the run was handed", async () => {
  const fake = fakeSandbox({
    stdout: `[claude-stderr] chat.postMessage with ${INSTALLATION_TOKEN} rejected\n`,
  });
  const posted = slackFetch(fake.calls, [slackRoot({ ok: true, ts: SLACK_TS, channel: SLACK_RESOLVED_CHANNEL })]);
  const effects = createFactoryLoopEffects(
    deps({
      sandbox: fake.sandbox,
      config: fakeConfig(SLACK_CONFIG).config,
      slackInstallation: fakeSlackInstallation(orgInstallation(INSTALLATION_TOKEN)).slackInstallation,
      fetch: posted.fetch,
    }),
  );

  const runId = await workedRunId(effects);
  const verdict = await effects.evaluate({ loop: LOOP, item: ITEM, attempt: 1, runId });

  assert.match(verdict.reason, /\[claude-stderr\] chat\.postMessage with \*\*\* rejected/);
  assert.equal(verdict.reason.includes(INSTALLATION_TOKEN), false);
});

test("a thread root whose response names no channel keeps the configured one", async () => {
  const fake = fakeSandbox();
  const posted = slackFetch(fake.calls, [slackRoot({ ok: true, ts: SLACK_TS })]);
  const effects = createFactoryLoopEffects(
    deps({
      sandbox: fake.sandbox,
      config: fakeConfig(SLACK_CONFIG).config,
      slackInstallation: fakeSlackInstallation(orgInstallation(INSTALLATION_TOKEN)).slackInstallation,
      fetch: posted.fetch,
    }),
  );

  await workedRunId(effects);

  assert.equal(wrapperStart(fake.calls).opts?.env?.SLACK_CHANNEL_ID, SLACK_CHANNEL);
});

const slackFailures: [string, () => Promise<Response> | Response, string][] = [
  ["a rejected fetch", () => Promise.reject(new Error("socket hang up")), "socket hang up"],
  ["a non-OK status", () => new Response("nope", { status: 500 }), "HTTP 500"],
  ["a body that is not JSON", () => new Response("<html>", { status: 200 }), "HTTP 200"],
  ["a Slack-level error", () => Response.json({ ok: false, error: "not_in_channel" }), "not_in_channel"],
  ["a response with no ts", () => Response.json({ ok: true }), "response carried no ts"],
];

for (const [label, respond, named] of slackFailures) {
  test(`${label} is swallowed: the run continues with no SLACK_ key and the failure is named`, async () => {
    const fake = fakeSandbox();
    const posted = slackFetch(fake.calls, [respond]);
    const effects = createFactoryLoopEffects(
      deps({
        sandbox: fake.sandbox,
        config: fakeConfig(SLACK_CONFIG).config,
        slackInstallation: fakeSlackInstallation(orgInstallation(INSTALLATION_TOKEN)).slackInstallation,
        fetch: posted.fetch,
      }),
    );

    const { result: runId, warnings } = await capturingWarnings(() => workedRunId(effects));

    assert.equal(runId, "factory:loop-1:item-1:1");
    const env = wrapperStart(fake.calls).opts?.env ?? {};
    for (const key of Object.keys(env)) assert.equal(key.startsWith("SLACK_"), false, `${key} survived a failure`);
    assert.equal(warnings.length, 1, warnings.join(" | "));
    assert.ok(warnings[0]?.startsWith("[swallowed] factory slack thread root: slack_post_failed: "), warnings[0]);
    assert.ok(warnings[0]?.includes(named), warnings[0]);
    assert.equal(warnings[0]?.includes(INSTALLATION_TOKEN), false, "the swallow log leaked the bot token");

    assert.deepEqual(await effects.captureOutputs({ loop: LOOP, item: ITEM, runId }), [OPEN_PR_ARTIFACT]);
  });
}

test("a blank or unset slack channel never reads the installation store, warns about nothing, and renders today's env", async () => {
  for (const slackChannel of [undefined, "", "   "]) {
    const fake = fakeSandbox();
    const posted = slackFetch(fake.calls, []);
    const store = fakeSlackInstallation(orgInstallation(INSTALLATION_TOKEN));
    const config: FactoryConfig = slackChannel === undefined ? CONFIG : { ...CONFIG, slackChannel };
    const effects = createFactoryLoopEffects(
      deps({
        sandbox: fake.sandbox,
        config: fakeConfig(config).config,
        slackInstallation: store.slackInstallation,
        fetch: posted.fetch,
      }),
    );

    const { result: runId, warnings } = await capturingWarnings(() => workedRunId(effects));

    const label = `channel ${JSON.stringify(slackChannel)}`;
    assert.equal(posted.posts.length, 0, `${label} posted`);
    assert.equal(store.calls, 0, `${label} read the installation store`);
    assert.deepEqual(warnings, [], label);
    assert.deepEqual(
      wrapperStart(fake.calls).opts?.env,
      renderFactoryEnv({
        config,
        linearApiKey: LINEAR_KEY,
        githubToken: GITHUB_TOKEN,
        modelAuth: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
        factorySessionId: factorySessionIdFor(runId.replace(/:\d+$/, "")),
        repoDir: REPO_DIR,
        factorySourceDir: FACTORY_SOURCE_DIR,
      }),
    );
  }
});

const NO_INSTALLATION_NOTE = "slack: no installation for this org, pings skipped";

const unusableInstallations: [string, StoredInstallation | Error][] = [
  ["no installation at all", null],
  ["an installation the store cannot decrypt", new Error("unable to decrypt secret")],
  ["an installation whose bot token is blank", orgInstallation("   ")],
];

for (const [label, outcome] of unusableInstallations) {
  test(`a configured channel with ${label} notes it and finishes the run instead of failing the fire`, async () => {
    const fake = fakeSandbox();
    const posted = slackFetch(fake.calls, []);
    const store = fakeSlackInstallation(outcome);
    const base = deps({
      sandbox: fake.sandbox,
      config: fakeConfig(SLACK_CONFIG).config,
      slackInstallation: store.slackInstallation,
      fetch: posted.fetch,
    });
    const effects = createFactoryLoopEffects(base);

    const { result, warnings } = await capturingWarnings(async () => ({
      context: await loadFactoryContext(base, LOOP.owner),
      runId: await workedRunId(effects),
    }));

    assert.equal(Object.hasOwn(result.context, "slackBotToken"), false);
    assert.equal(result.runId, "factory:loop-1:item-1:1");
    assert.equal(posted.posts.length, 0);
    const env = wrapperStart(fake.calls).opts?.env ?? {};
    for (const key of Object.keys(env)) assert.equal(key.startsWith("SLACK_"), false, `${key} survived`);
    const noted = warnings.filter((warning) => warning.includes(NO_INSTALLATION_NOTE));
    assert.equal(noted.length, 2, `one note per loadFactoryContext: ${warnings.join(" | ")}`);
    assert.equal(warnings.join(" | ").includes("factory-slack"), false, "the note named the deleted credential");
  });
}

test("each fire re-reads the installation, so a rotated bot token reaches the next run without a restart", async () => {
  const rotated = "xoxb-FAKE_ROTATED_INSTALLATION_TOKEN";
  const fake = fakeSandbox();
  const posted = slackFetch(fake.calls, [slackRoot({ ok: true, ts: SLACK_TS }), slackRoot({ ok: true, ts: SLACK_TS })]);
  const store = fakeSlackInstallation(orgInstallation(INSTALLATION_TOKEN), orgInstallation(rotated));
  const effects = createFactoryLoopEffects(
    deps({
      sandbox: fake.sandbox,
      config: fakeConfig(SLACK_CONFIG).config,
      slackInstallation: store.slackInstallation,
      fetch: posted.fetch,
    }),
  );

  await workedRunId(effects);
  await workedRunId(effects, { ...ITEM, attempts: 1 });

  assert.deepEqual(
    posted.posts.map((post) => new Headers(post.init?.headers).get("Authorization")),
    [`Bearer ${INSTALLATION_TOKEN}`, `Bearer ${rotated}`],
  );
  assert.deepEqual(
    wrapperEnvs(fake.calls).map((env) => env.SLACK_BOT_TOKEN),
    [INSTALLATION_TOKEN, rotated],
  );
  assert.equal(store.calls, 2);
});

test("a preflight or bootstrap failure leaves no orphan thread root", async () => {
  for (const over of [{ probeMissing: ["gh"] }, { bootstrapExit: 128 }]) {
    const fake = fakeSandbox(over);
    const posted = slackFetch(fake.calls, [slackRoot({ ok: true, ts: SLACK_TS })]);
    const effects = createFactoryLoopEffects(
      deps({
        sandbox: fake.sandbox,
        config: fakeConfig(SLACK_CONFIG).config,
        slackInstallation: fakeSlackInstallation(orgInstallation(INSTALLATION_TOKEN)).slackInstallation,
        fetch: posted.fetch,
      }),
    );

    const error = await rejection(effects.work({ loop: LOOP, item: ITEM }));

    assert.ok(error.message.startsWith("factory_"), error.message);
    assert.equal(posted.posts.length, 0, `${JSON.stringify(over)} posted a root`);
  }
});

test("an item whose source key is not a ticket id posts no root and touches no sandbox", async () => {
  for (const sourceKey of ["<!channel> ship it", "QM-12; rm -rf /", "qm-12", ""]) {
    const fake = fakeSandbox();
    const posted = slackFetch(fake.calls, [slackRoot({ ok: true, ts: SLACK_TS })]);
    const effects = createFactoryLoopEffects(
      deps({
        sandbox: fake.sandbox,
        config: fakeConfig(SLACK_CONFIG).config,
        slackInstallation: fakeSlackInstallation(orgInstallation(INSTALLATION_TOKEN)).slackInstallation,
        fetch: posted.fetch,
      }),
    );

    const error = await rejection(effects.work({ loop: LOOP, item: { ...ITEM, sourceKey } }));

    assert.equal(error.message, "factory_ticket_invalid");
    assert.equal(posted.posts.length, 0, `${JSON.stringify(sourceKey)} reached Slack`);
    assert.equal(fake.calls.length, 0, `${JSON.stringify(sourceKey)} reached the sandbox`);
  }
});
