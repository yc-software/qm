import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFactoryLoopEffects,
  loadFactoryContext,
  FACTORY_SOURCE_BRANCH,
  FACTORY_SOURCE_DIR,
  type FactoryContext,
  type FactoryEffectsDeps,
  type FactoryWorkEffects,
  factorySessionIdFor,
} from "../src/loops/factory/effects.ts";
import { FACTORY_REQUIRED_TOOLS } from "../src/loops/factory/preflight.ts";
import { FACTORY_ANTHROPIC_SLUG, FACTORY_GITHUB_SLUG, FACTORY_LINEAR_SLUG } from "../src/loops/factory/credentials.ts";
import { FACTORY_WRAPPER, renderFactoryEnv } from "../src/loops/factory/process-work.ts";
import { shq } from "../src/util/shell.ts";
import { LINEAR_GRAPHQL_URL } from "../src/loops/factory/linear-intake.ts";
import { FORGE_CHECKS } from "../src/loops/factory/forge-evaluate.ts";
import type { DecryptedServiceCredential, ServiceCredentialReader } from "../src/credentials/keychain.ts";
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

const ORG_SCOPE = "org:acme";
const LINEAR_KEY = "lin_FAKE_KEY";
const GITHUB_TOKEN = "ghp_FAKE_TOKEN";
const ANTHROPIC_KEY = "sk-ant-FAKE_KEY";
const SECRET_BY_SLUG: Record<string, string> = {
  [FACTORY_LINEAR_SLUG]: LINEAR_KEY,
  [FACTORY_GITHUB_SLUG]: GITHUB_TOKEN,
  [FACTORY_ANTHROPIC_SLUG]: ANTHROPIC_KEY,
};
const REPO_DIR = "/workspace/repo";
const CLONE_DIR = "/workspace/qm-yc";
const CLONE_URL = "https://github.com/yc-software/qm-yc.git";
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

const credentialRecord = (
  slug: string,
  over: Partial<DecryptedServiceCredential> = {},
): DecryptedServiceCredential => ({
  slug,
  name: slug,
  secret: SECRET_BY_SLUG[slug] ?? "",
  delivery: "broker",
  host: "api.example.com",
  deployments: false,
  enabled: true,
  ...over,
});

function fakeCredentials(records: (DecryptedServiceCredential | null)[]): ServiceCredentialReader {
  const bySlug = new Map(records.filter((rec) => rec !== null).map((rec) => [rec.slug, rec]));
  return { getServiceCredentialSecret: async (_org, slug) => bySlug.get(slug) ?? null };
}

const healthyCredentials = (): ServiceCredentialReader =>
  fakeCredentials([
    credentialRecord(FACTORY_LINEAR_SLUG),
    credentialRecord(FACTORY_GITHUB_SLUG),
    credentialRecord(FACTORY_ANTHROPIC_SLUG),
  ]);

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

const intakePage = (identifiers: string[]): Response =>
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
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  });

function deps(over: Partial<FactoryEffectsDeps> = {}): FactoryEffectsDeps {
  return {
    sandbox: fakeSandbox().sandbox,
    config: fakeConfig(CONFIG).config,
    credentials: healthyCredentials(),
    orgScopeId: ORG_SCOPE,
    loops: fakeLoops(["enabled"]).loops,
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
  return join(root, "qm-yc");
};

async function recordedBootstrapScript(cloneDir: string): Promise<string> {
  const fake = fakeSandbox();
  await workedRunId(createFactoryLoopEffects(deps({ sandbox: fake.sandbox })));
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
  assert.deepEqual(candidates, [
    { sourceKey: "QM-12", sourceSummary: "QM-12 title" },
    { sourceKey: "QM-13", sourceSummary: "QM-13 title" },
  ]);
  assert.deepEqual(fake.calls, []);

  const call = fetched.calls[0];
  assert.ok(call);
  assert.equal(call.url, LINEAR_GRAPHQL_URL);
  assert.equal(new Headers(call.init?.headers).get("Authorization"), LINEAR_KEY);
  const body = JSON.parse(String(call.init?.body)) as { variables: Record<string, unknown> };
  assert.equal(body.variables.teamId, "TEAM-1");
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

test("loadFactoryContext resolves the org config and both credentials", async () => {
  const context: FactoryContext = await loadFactoryContext(deps());
  assert.deepEqual(context, {
    config: CONFIG,
    linearApiKey: LINEAR_KEY,
    githubToken: GITHUB_TOKEN,
    anthropicApiKey: ANTHROPIC_KEY,
  });
});

test("a missing factory config fails every entry point before any sandbox or network call", async () => {
  const fake = fakeSandbox();
  const fetched = fakeFetch([]);
  const base = deps({ sandbox: fake.sandbox, config: fakeConfig(null).config, fetch: fetched.fetch });
  const effects = createFactoryLoopEffects(base);

  for (const promise of [loadFactoryContext(base), effects.enumerate(LOOP), workedRunId(effects)]) {
    assert.equal((await rejection(promise)).message, "factory_config_missing");
  }
  assert.deepEqual(fake.calls, []);
  assert.equal(fetched.calls.length, 0);
});

test("missing credentials name every absent slug, linear first, without leaking a secret", async () => {
  const fake = fakeSandbox();
  const base = deps({
    sandbox: fake.sandbox,
    credentials: fakeCredentials([credentialRecord(FACTORY_GITHUB_SLUG), credentialRecord(FACTORY_ANTHROPIC_SLUG)]),
  });
  const effects = createFactoryLoopEffects(base);
  for (const promise of [loadFactoryContext(base), effects.enumerate(LOOP), workedRunId(effects)]) {
    const error = await rejection(promise);
    assert.equal(error.message, `factory_credentials_missing: ${FACTORY_LINEAR_SLUG}`);
    assert.equal(error.message.includes(GITHUB_TOKEN), false);
  }

  const both = createFactoryLoopEffects(
    deps({
      sandbox: fake.sandbox,
      credentials: fakeCredentials([
        credentialRecord(FACTORY_LINEAR_SLUG, { secret: "   " }),
        credentialRecord(FACTORY_GITHUB_SLUG, { enabled: false }),
        credentialRecord(FACTORY_ANTHROPIC_SLUG),
      ]),
    }),
  );
  const error = await rejection(both.enumerate(LOOP));
  assert.equal(error.message, `factory_credentials_missing: ${FACTORY_LINEAR_SLUG}, ${FACTORY_GITHUB_SLUG}`);
  assert.deepEqual(fake.calls, []);
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
      anthropicApiKey: ANTHROPIC_KEY,
      factorySessionId: factorySessionIdFor("factory:loop-1:item-1:1"),
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

test("factorySessionIdFor is a stable positive integer that differs across runs", () => {
  const a = factorySessionIdFor("factory:loop-1:item-1:1");
  assert.equal(a, factorySessionIdFor("factory:loop-1:item-1:1"));
  assert.ok(Number.isInteger(a) && a > 0 && a <= 2_000_000_000);
  assert.notEqual(a, factorySessionIdFor("factory:loop-1:item-1:2"));
  assert.notEqual(a, factorySessionIdFor("factory:loop-1:item-2:1"));
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

test("the bootstrap command clones a cold checkout and converges a warm one without re-cloning", async (t) => {
  const cloneDir = tempCloneDir(t);
  const script = await recordedBootstrapScript(cloneDir);

  const cold = runWithFakeGit(script);

  assert.equal(cold.code, 0, cold.output);
  assert.deepEqual(cold.git, [
    `clone --depth 1 --single-branch --branch ${FACTORY_SOURCE_BRANCH} ${CLONE_URL} ${cloneDir}`,
  ]);

  mkdirSync(join(cloneDir, ".git"), { recursive: true });
  const warm = runWithFakeGit(script);

  assert.equal(warm.code, 0, warm.output);
  assert.deepEqual(warm.git, [
    `-C ${cloneDir} fetch --depth 1 origin ${FACTORY_SOURCE_BRANCH}`,
    `-C ${cloneDir} checkout -f FETCH_HEAD`,
  ]);
});

test("a failed fetch fails the bootstrap instead of checking out a stale FETCH_HEAD", async (t) => {
  const cloneDir = tempCloneDir(t);
  const script = await recordedBootstrapScript(cloneDir);
  mkdirSync(join(cloneDir, ".git"), { recursive: true });

  const result = runWithFakeGit(script, "fetch");

  assert.notEqual(result.code, 0);
  assert.deepEqual(result.git, [`-C ${cloneDir} fetch --depth 1 origin ${FACTORY_SOURCE_BRANCH}`]);
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
    bootstrapOutput: `Cloning into '/workspace/qm-yc'...\nfatal: could not read Username for 'https://github.com/': terminal prompts disabled\nremote: ${GITHUB_TOKEN}\n`,
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
