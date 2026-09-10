import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACTORY_DRAIN_EMPTY_READS,
  FACTORY_READ_WAIT_MS,
  FACTORY_STDOUT_CAP_BYTES,
  FACTORY_TERM_GRACE_MS,
  FACTORY_WRAPPER,
  renderFactoryEnv,
  runFactoryProcess,
  type FactoryEnvInput,
  type FactoryProcessInput,
} from "../src/loops/factory/process-work.ts";
import { parseFactoryContract } from "../src/loops/factory/contract.ts";
import { CapabilityUnsupportedError } from "../src/sandbox/sandbox.ts";
import type {
  ProcessState,
  ReadProcessOptions,
  Sandbox,
  SandboxHandle,
  StartProcessOptions,
  TeardownOptions,
} from "../src/sandbox/sandbox.ts";
import type { FactoryConfig } from "../src/resolution/config-store.ts";
import type { WorkspaceLayer } from "../src/types.ts";

const HANDLE: SandboxHandle = { id: "sbx-1", rootDir: "/workspace" };
const SCOPE_ID = "org:acme";
const REPO_DIR = "/workspace/repo";
const SOURCE_DIR = "/workspace/qm-yc/layer/factory";
const TICKET = "QM-12";

type ProcessMethod = "startProcess" | "readProcess" | "writeStdin" | "signalProcess" | "listProcesses";

const FULL_CONFIG: FactoryConfig = {
  forge: "github",
  publishProject: "acme/widgets",
  targetBranch: "main",
  repoCloneUrl: "https://github.com/acme/widgets.git",
  repoSetupCmd: "npm ci",
  linearTeamId: "team_123",
  sourceAppDirs: "src app",
  sourceTestRe: "\\.test\\.ts$",
  verifyTestsCmd: "npm test",
  verifyTestFileCmd: "npm test --",
  verifyLintCmd: "npm run lint",
  proofStartCmd: "npm run dev",
  proofBaseUrlCmd: "echo http://localhost:3000",
  slackChannel: "C123",
  bugbotRequired: true,
  followupsEnabled: false,
};

const MINIMAL_CONFIG: FactoryConfig = {
  forge: "gitlab",
  publishProject: "acme%2Fwidgets",
  targetBranch: "release/2",
  repoCloneUrl: "https://gitlab.com/acme/widgets.git",
  linearTeamId: "team_456",
  sourceAppDirs: "lib",
  sourceTestRe: "_spec\\.rb$",
  verifyTestsCmd: "bundle exec rspec",
  verifyTestFileCmd: "bundle exec rspec --",
  verifyLintCmd: "bundle exec rubocop",
  bugbotRequired: false,
  followupsEnabled: true,
};

const ENV_INPUT: FactoryEnvInput = {
  config: FULL_CONFIG,
  guidance: "reviewer asked for a smaller diff",
  linearApiKey: "lin_api_secret",
  githubToken: "ghp_secret",
  repoDir: REPO_DIR,
  factorySourceDir: SOURCE_DIR,
};

const OPTIONAL_KEYS = ["IO_FEEDBACK", "IO_REPO_SETUP_CMD", "IO_PROOF_START_CMD", "IO_PROOF_BASE_URL_CMD"];

const FORBIDDEN_KEYS = ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID", "SLACK_THREAD_TS", "CODING_AGENT_SESSION_URL"];

type ReadStep =
  { chunks?: string; cursor: number; status?: ProcessState; delayMs?: number; onServe?: () => void } | { error: Error };

interface Calls {
  provision: WorkspaceLayer[][];
  startProcess: Array<{ handle: SandboxHandle; command: string; opts: StartProcessOptions | undefined }>;
  readProcess: Array<{ handle: SandboxHandle; processId: string; opts: ReadProcessOptions | undefined }>;
  signalProcess: Array<{ handle: SandboxHandle; processId: string; signal: string }>;
  teardown: Array<{ handle: SandboxHandle; opts: TeardownOptions | undefined }>;
  order: string[];
  total: number;
}

interface Fake {
  sandbox: Sandbox;
  calls: Calls;
}

function fakeSandbox(opts: {
  reads?: ReadStep[];
  processSessions?: boolean;
  omit?: ProcessMethod;
  startError?: Error;
  signalError?: Error;
  teardownError?: Error;
}): Fake {
  const calls: Calls = {
    provision: [],
    startProcess: [],
    readProcess: [],
    signalProcess: [],
    teardown: [],
    order: [],
    total: 0,
  };
  const reads = opts.reads ?? [];
  const unused = (name: string) => () => Promise.reject(new Error(`runFactoryProcess must not call ${name}`));
  const sandbox: Record<string, unknown> = {
    profile: {
      backend: "fake",
      writablePersistence: "resident_disk",
      processSessions: opts.processSessions ?? true,
    },
    provision: (layers: WorkspaceLayer[]) => {
      calls.total += 1;
      calls.provision.push(layers);
      calls.order.push("provision");
      return Promise.resolve(HANDLE);
    },
    run: unused("run"),
    readFile: unused("readFile"),
    writeFile: unused("writeFile"),
    writeFileBytes: unused("writeFileBytes"),
    readFileBytes: unused("readFileBytes"),
    listDir: unused("listDir"),
    removeDir: unused("removeDir"),
    startProcess: (handle: SandboxHandle, command: string, startOpts?: StartProcessOptions) => {
      calls.total += 1;
      calls.startProcess.push({ handle, command, opts: startOpts });
      calls.order.push("startProcess");
      if (opts.startError) return Promise.reject(opts.startError);
      return Promise.resolve({ processId: "p-7" });
    },
    readProcess: async (handle: SandboxHandle, processId: string, readOpts?: ReadProcessOptions) => {
      calls.total += 1;
      calls.readProcess.push({ handle, processId, opts: readOpts });
      calls.order.push("readProcess");
      const step = reads[calls.readProcess.length - 1];
      if (step === undefined) throw new Error(`unscripted readProcess #${calls.readProcess.length}`);
      if ("error" in step) throw step.error;
      if (step.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      step.onServe?.();
      return { chunks: step.chunks ?? "", cursor: step.cursor, status: step.status ?? { state: "running" } };
    },
    writeStdin: unused("writeStdin"),
    signalProcess: (handle: SandboxHandle, processId: string, signal: string) => {
      calls.total += 1;
      calls.signalProcess.push({ handle, processId, signal });
      calls.order.push("signalProcess");
      if (opts.signalError) return Promise.reject(opts.signalError);
      return Promise.resolve();
    },
    listProcesses: unused("listProcesses"),
    teardown: (handle: SandboxHandle, teardownOpts?: TeardownOptions) => {
      calls.total += 1;
      calls.teardown.push({ handle, opts: teardownOpts });
      calls.order.push("teardown");
      if (opts.teardownError) return Promise.reject(opts.teardownError);
      return Promise.resolve();
    },
  };
  if (opts.omit) delete sandbox[opts.omit];
  return { sandbox: sandbox as unknown as Sandbox, calls };
}

const baseInput = (fake: Fake, extra: Partial<FactoryProcessInput> = {}): FactoryProcessInput => ({
  sandbox: fake.sandbox,
  scopeId: SCOPE_ID,
  repoDir: REPO_DIR,
  factorySourceDir: SOURCE_DIR,
  ticketId: TICKET,
  env: { IO_LINEAR_API_KEY: "lin_api_secret" },
  ...extra,
});

const SUCCESS_READS: ReadStep[] = [
  { chunks: "line one\n", cursor: 9 },
  { chunks: "", cursor: 9 },
  { chunks: "BRANCH:qm-12-s99\nMR:41\n", cursor: 32, status: { state: "exited", code: 3 } },
  { chunks: "", cursor: 32, status: { state: "exited", code: 3 } },
  { chunks: "", cursor: 32, status: { state: "exited", code: 3 } },
];

const SUCCESS_STDOUT = "line one\nBRANCH:qm-12-s99\nMR:41\n";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the promise to reject");
}

test("renderFactoryEnv renders exactly the wrapper's tabled keys and no Slack or session key", () => {
  const env = renderFactoryEnv(ENV_INPUT);
  assert.deepEqual(env, {
    IO_FEEDBACK: "reviewer asked for a smaller diff",
    IO_LINEAR_API_KEY: "lin_api_secret",
    IO_GITHUB_TOKEN: "ghp_secret",
    IO_PUBLISH_FORGE: "github",
    IO_PUBLISH_PROJECT: "acme/widgets",
    IO_PUBLISH_TARGET: "main",
    IO_PUBLISH_REMOTE: "origin",
    IO_SOURCE_REMOTE: "origin",
    IO_SOURCE_BASE_REF: "origin/main",
    IO_SOURCE_APP_DIRS: "src app",
    IO_SOURCE_TEST_RE: "\\.test\\.ts$",
    IO_VERIFY_TESTS_CMD: "npm test",
    IO_VERIFY_TEST_FILE_CMD: "npm test --",
    IO_VERIFY_LINT_CMD: "npm run lint",
    IO_REPO_DIR: REPO_DIR,
    IO_FACTORY_SOURCE_DIR: SOURCE_DIR,
    IO_REPO_CLONE_URL: "https://github.com/acme/widgets.git",
    IO_REPO_SETUP_CMD: "npm ci",
    IO_PROOF_START_CMD: "npm run dev",
    IO_PROOF_BASE_URL_CMD: "echo http://localhost:3000",
    IO_BUGBOT_REQUIRED: "true",
    IO_FOLLOWUPS_ENABLED: "false",
    IO_FOLLOWUP_TEAM_ID: "team_123",
  });
  assert.notEqual(env.IO_FACTORY_SOURCE_DIR, env.IO_REPO_DIR);
  assert.equal(FULL_CONFIG.slackChannel, "C123");
  for (const key of Object.keys(env)) assert.equal(key.startsWith("SLACK_"), false, `${key} is a SLACK_ key`);
  for (const key of FORBIDDEN_KEYS) assert.equal(Object.hasOwn(env, key), false, `${key} should never be set`);
  for (const [key, value] of Object.entries(env)) assert.notEqual(value, "C123", `${key} leaks the slack channel`);
  const frozen = Object.freeze({ ...ENV_INPUT, config: Object.freeze({ ...FULL_CONFIG }) });
  assert.deepEqual(renderFactoryEnv(frozen), env);
});

test("renderFactoryEnv omits every optional key whose source is absent", () => {
  const full = Object.keys(renderFactoryEnv(ENV_INPUT)).sort();
  const env = renderFactoryEnv({
    config: MINIMAL_CONFIG,
    linearApiKey: "lin_min",
    githubToken: "ghp_min",
    repoDir: "/srv/repo",
    factorySourceDir: SOURCE_DIR,
  });
  assert.deepEqual(
    Object.keys(env).sort(),
    full.filter((key) => !OPTIONAL_KEYS.includes(key)),
  );
  for (const key of OPTIONAL_KEYS) assert.equal(Object.hasOwn(env, key), false, `${key} should be absent`);
  assert.equal(env.IO_BUGBOT_REQUIRED, "false");
  assert.equal(env.IO_FOLLOWUPS_ENABLED, "true");
  assert.equal(env.IO_PUBLISH_TARGET, "release/2");
  assert.equal(env.IO_SOURCE_BASE_REF, "origin/release/2");
});

test("renderFactoryEnv keeps an empty optional source as an empty value rather than omitting it", () => {
  const env = renderFactoryEnv({
    ...ENV_INPUT,
    guidance: "",
    config: { ...FULL_CONFIG, repoSetupCmd: "", proofStartCmd: "", proofBaseUrlCmd: "" },
  });
  for (const key of OPTIONAL_KEYS) assert.equal(env[key], "", `${key} should render as an empty value`);
});

test("runFactoryProcess starts the wrapper, streams every chunk to exit and hands stdout to the parser", async () => {
  const fake = fakeSandbox({ reads: SUCCESS_READS });
  const chunks: string[] = [];
  const env = renderFactoryEnv(ENV_INPUT);
  const result = await runFactoryProcess(baseInput(fake, { env, onChunk: (c) => void chunks.push(c) }));

  assert.deepEqual(fake.calls.provision, [[{ scopeId: SCOPE_ID, mode: "rw", mountPath: "" }]]);
  assert.equal(fake.calls.startProcess.length, 1);
  assert.equal(fake.calls.startProcess[0]?.command, `bash ${SOURCE_DIR}/${FACTORY_WRAPPER} ${TICKET}`);
  assert.equal(fake.calls.startProcess[0]?.opts?.cwd, REPO_DIR);
  assert.equal(fake.calls.startProcess[0]?.opts?.env, env);

  assert.equal(fake.calls.readProcess.length, SUCCESS_READS.length);
  let expectedCursor = 0;
  fake.calls.readProcess.forEach((call, index) => {
    assert.equal(call.processId, "p-7");
    assert.equal(call.opts?.maxBytes, 65_536);
    assert.equal(call.opts?.waitMs, FACTORY_READ_WAIT_MS);
    assert.equal(call.opts?.sinceCursor, expectedCursor, `read #${index + 1} chained the wrong cursor`);
    const step = SUCCESS_READS[index];
    if (step && !("error" in step)) expectedCursor = step.cursor;
  });

  assert.deepEqual(chunks, ["line one\n", "BRANCH:qm-12-s99\nMR:41\n"]);
  assert.equal(result.processId, "p-7");
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, SUCCESS_STDOUT);
  assert.equal(result.truncated, false);
  assert.equal(result.aborted, false);
  assert.deepEqual(fake.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
  assert.deepEqual(fake.calls.signalProcess, []);

  const artifacts = parseFactoryContract({
    stdout: result.stdout,
    sourceKey: TICKET,
    forge: "github",
    publishProject: "acme/widgets",
  });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.shipAction, "open_pr");
  assert.equal(artifacts[0]?.label, "qm-12-s99");
  assert.equal(artifacts[0]?.externalRef, "https://github.com/acme/widgets/pull/41");
});

test("runFactoryProcess honours a readWaitMs override, needs no onChunk, and lets an onChunk throw escape", async () => {
  const bare = fakeSandbox({ reads: SUCCESS_READS });
  const result = await runFactoryProcess(baseInput(bare, { readWaitMs: 17 }));
  assert.equal(result.stdout, SUCCESS_STDOUT);
  for (const call of bare.calls.readProcess) assert.equal(call.opts?.waitMs, 17);

  const throwing = fakeSandbox({ reads: SUCCESS_READS });
  const boom = new Error("boom-chunk");
  const onChunk = () => {
    throw boom;
  };
  assert.equal(await rejection(runFactoryProcess(baseInput(throwing, { onChunk }))), boom);
  assert.deepEqual(throwing.calls.signalProcess, [{ handle: HANDLE, processId: "p-7", signal: "TERM" }]);
  assert.deepEqual(throwing.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
  assert.deepEqual(throwing.calls.order, ["provision", "startProcess", "readProcess", "signalProcess", "teardown"]);
});

test("runFactoryProcess keeps the contract-bearing tail of an over-cap stream and marks it truncated", async () => {
  const head = `HEAD-MARKER\n${"a".repeat(3 * 1024 * 1024)}`;
  const middle = "b".repeat(3 * 1024 * 1024);
  const tail = "\nBRANCH:qm-12-s99\nMR:41\n";
  const full = head + middle + tail;
  const fake = fakeSandbox({
    reads: [
      { chunks: head, cursor: head.length },
      { chunks: middle, cursor: head.length + middle.length },
      { chunks: tail, cursor: full.length, status: { state: "exited", code: 0 } },
      { chunks: "", cursor: full.length, status: { state: "exited", code: 0 } },
      { chunks: "", cursor: full.length, status: { state: "exited", code: 0 } },
    ],
  });
  let streamed = 0;
  const result = await runFactoryProcess(baseInput(fake, { onChunk: (c) => void (streamed += c.length) }));

  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, FACTORY_STDOUT_CAP_BYTES);
  assert.equal(result.stdout, full.slice(-FACTORY_STDOUT_CAP_BYTES));
  assert.equal(result.stdout.includes("HEAD-MARKER"), false);
  assert.equal(streamed, full.length);

  const artifacts = parseFactoryContract({
    stdout: result.stdout,
    sourceKey: TICKET,
    forge: "github",
    publishProject: "acme/widgets",
  });
  assert.equal(artifacts[0]?.label, "qm-12-s99");
});

for (const ticketId of ["QM-12; rm -rf /", "QM-12\nMR:99", "qm-12", "QM-", "-12", "", "QM-1a"]) {
  test(`runFactoryProcess rejects the ticket id ${JSON.stringify(ticketId)} before touching the sandbox`, async () => {
    const fake = fakeSandbox({ processSessions: false });
    const error = await rejection(runFactoryProcess(baseInput(fake, { ticketId })));
    assert.equal(error.message, "factory_ticket_invalid");
    assert.equal(fake.calls.total, 0);
  });
}

test("runFactoryProcess rejects a sandbox without process sessions before touching it", async () => {
  for (const opts of [{ processSessions: false }, { omit: "signalProcess" as ProcessMethod }]) {
    const fake = fakeSandbox(opts);
    const error = await rejection(runFactoryProcess(baseInput(fake)));
    assert.ok(error instanceof CapabilityUnsupportedError);
    assert.equal(error.capability, "process sessions");
    assert.equal(error.backend, "fake");
    assert.equal(fake.calls.total, 0);
  }
});

test("a sandbox failure propagates after teardown, with no partial result", async () => {
  const startBoom = new Error("boom-start");
  const started = fakeSandbox({ startError: startBoom });
  assert.equal(await rejection(runFactoryProcess(baseInput(started))), startBoom);
  assert.deepEqual(started.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
  assert.deepEqual(started.calls.readProcess, []);
  assert.deepEqual(started.calls.signalProcess, []);

  const readBoom = new Error("boom-read");
  const read = fakeSandbox({ reads: [{ chunks: "line one\n", cursor: 9 }, { error: readBoom }] });
  assert.equal(await rejection(runFactoryProcess(baseInput(read))), readBoom);
  assert.deepEqual(read.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
});

test("a read that throws terminates the wrapper once, before the unchanged teardown", async () => {
  const readBoom = new Error("boom-read");
  const fake = fakeSandbox({ reads: [{ chunks: "line one\n", cursor: 9 }, { error: readBoom }] });
  assert.equal(await rejection(runFactoryProcess(baseInput(fake))), readBoom);
  assert.deepEqual(fake.calls.signalProcess, [{ handle: HANDLE, processId: "p-7", signal: "TERM" }]);
  assert.deepEqual(fake.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
  assert.deepEqual(fake.calls.order, [
    "provision",
    "startProcess",
    "readProcess",
    "readProcess",
    "signalProcess",
    "teardown",
  ]);
});

test("a cleanup signal that itself rejects never masks the error that triggered it", async () => {
  const readBoom = new Error("boom-read");
  const fake = fakeSandbox({ reads: [{ error: readBoom }], signalError: new Error("boom-signal") });
  assert.equal(await rejection(runFactoryProcess(baseInput(fake))), readBoom);
  assert.deepEqual(fake.calls.signalProcess, [{ handle: HANDLE, processId: "p-7", signal: "TERM" }]);
  assert.deepEqual(fake.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
});

test("an abort TERM that rejects propagates and is still followed by the cleanup TERM", async () => {
  const controller = new AbortController();
  const signalBoom = new Error("boom-signal");
  const fake = fakeSandbox({
    reads: [{ chunks: "", cursor: 0, onServe: () => controller.abort() }],
    signalError: signalBoom,
  });
  assert.equal(await rejection(runFactoryProcess(baseInput(fake, { signal: controller.signal }))), signalBoom);
  assert.deepEqual(
    fake.calls.signalProcess.map((c) => c.signal),
    ["TERM", "TERM"],
  );
  assert.deepEqual(fake.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
});

test("a failing teardown is swallowed on both the success and the failure path", async () => {
  const teardownError = new Error("boom-teardown");
  const ok = fakeSandbox({ reads: SUCCESS_READS, teardownError });
  const result = await runFactoryProcess(baseInput(ok));
  assert.equal(result.stdout, SUCCESS_STDOUT);
  assert.equal(ok.calls.teardown.length, 1);

  const boom = new Error("boom-read");
  const bad = fakeSandbox({ reads: [{ error: boom }], teardownError });
  assert.equal(await rejection(runFactoryProcess(baseInput(bad))), boom);
  assert.equal(bad.calls.teardown.length, 1);
});

test("an aborting signal sends one TERM, one KILL after the grace, and still drains the late output", async () => {
  const controller = new AbortController();
  const fake = fakeSandbox({
    reads: [
      { chunks: "line one\n", cursor: 9, onServe: () => controller.abort() },
      { chunks: "", cursor: 9 },
      { chunks: "BRANCH:qm-12-s99\nMR:41\n", cursor: 32, delayMs: 40 },
      { chunks: "", cursor: 32 },
      { chunks: "", cursor: 32, status: { state: "exited", code: 143 } },
      { chunks: "", cursor: 32, status: { state: "exited", code: 143 } },
    ],
  });
  const chunks: string[] = [];
  const result = await runFactoryProcess(
    baseInput(fake, { signal: controller.signal, termGraceMs: 5, onChunk: (c) => void chunks.push(c) }),
  );

  assert.deepEqual(
    fake.calls.signalProcess.map((c) => c.signal),
    ["TERM", "KILL"],
  );
  for (const call of fake.calls.signalProcess) assert.equal(call.processId, "p-7");
  assert.deepEqual(chunks, ["line one\n", "BRANCH:qm-12-s99\nMR:41\n"]);
  assert.equal(result.stdout, SUCCESS_STDOUT);
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, 143);
  assert.deepEqual(fake.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
});

test("a process that exits inside the grace window is terminated but never killed", async () => {
  const controller = new AbortController();
  const fake = fakeSandbox({
    reads: [
      { chunks: "", cursor: 0, onServe: () => controller.abort() },
      { chunks: "", cursor: 0 },
      { chunks: "", cursor: 0, status: { state: "exited", code: 143 } },
      { chunks: "", cursor: 0, status: { state: "exited", code: 143 } },
    ],
  });
  const result = await runFactoryProcess(
    baseInput(fake, { signal: controller.signal, termGraceMs: FACTORY_TERM_GRACE_MS }),
  );
  assert.deepEqual(
    fake.calls.signalProcess.map((c) => c.signal),
    ["TERM"],
  );
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, 143);
});

test("a signal aborted before the call terminates on the first pass and the default grace withholds the kill", async () => {
  const controller = new AbortController();
  controller.abort();
  const fake = fakeSandbox({
    reads: [
      { chunks: "", cursor: 0 },
      { chunks: "", cursor: 0 },
      { chunks: "BRANCH:qm-12-s99\nMR:41\n", cursor: 23 },
      { chunks: "", cursor: 23, status: { state: "exited", code: 143 } },
      { chunks: "", cursor: 23, status: { state: "exited", code: 143 } },
    ],
  });
  const result = await runFactoryProcess(baseInput(fake, { signal: controller.signal }));
  assert.deepEqual(
    fake.calls.signalProcess.map((c) => c.signal),
    ["TERM"],
  );
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, 143);
  assert.equal(result.stdout, "BRANCH:qm-12-s99\nMR:41\n");
  assert.deepEqual(fake.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
});

test("no path logs to the console or puts a credential in an error", async () => {
  const env = renderFactoryEnv({ ...ENV_INPUT, linearApiKey: "LEAK-LINEAR", githubToken: "LEAK-GITHUB" });
  const failures: Array<() => Promise<unknown>> = [
    () => runFactoryProcess(baseInput(fakeSandbox({}), { env, ticketId: "QM-12; rm -rf /" })),
    () => runFactoryProcess(baseInput(fakeSandbox({ processSessions: false }), { env })),
    () => runFactoryProcess(baseInput(fakeSandbox({ startError: new Error("boom-start") }), { env })),
    () => runFactoryProcess(baseInput(fakeSandbox({ reads: [{ error: new Error("boom-read") }] }), { env })),
    () =>
      runFactoryProcess(
        baseInput(fakeSandbox({ reads: [{ error: new Error("boom-read") }], signalError: new Error("boom-signal") }), {
          env,
        }),
      ),
  ];
  const logged: unknown[][] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  Object.assign(console, {
    log: (...args: unknown[]) => void logged.push(args),
    error: (...args: unknown[]) => void logged.push(args),
    warn: (...args: unknown[]) => void logged.push(args),
    info: (...args: unknown[]) => void logged.push(args),
  });
  try {
    await runFactoryProcess(baseInput(fakeSandbox({ reads: SUCCESS_READS }), { env }));
    for (const run of failures) {
      const error = await rejection(run());
      const rendered = [error.message, error.stack ?? "", JSON.stringify(Object.entries(error))].join("\n");
      for (const sentinel of ["LEAK-LINEAR", "LEAK-GITHUB"]) {
        assert.equal(rendered.includes(sentinel), false, `${error.message} leaked ${sentinel}`);
      }
    }
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, []);
});

test("output flushed between the size sample and the exit test still reaches stdout", async () => {
  const drained: ReadStep = { chunks: "", cursor: 32, status: { state: "exited", code: 3 } };
  const script: ReadStep[] = [
    { chunks: "line one\n", cursor: 9 },
    { chunks: "", cursor: 9, status: { state: "exited", code: 3 } },
    { chunks: "BRANCH:qm-12-s99\nMR:41\n", cursor: 32, status: { state: "exited", code: 3 } },
    ...Array.from({ length: FACTORY_DRAIN_EMPTY_READS }, () => drained),
  ];
  const fake = fakeSandbox({ reads: script });
  const chunks: string[] = [];
  const result = await runFactoryProcess(baseInput(fake, { onChunk: (c) => void chunks.push(c) }));

  assert.equal(result.stdout, SUCCESS_STDOUT);
  assert.deepEqual(chunks, ["line one\n", "BRANCH:qm-12-s99\nMR:41\n"]);
  assert.equal(fake.calls.readProcess.length, script.length);
  assert.equal(result.exitCode, 3);
  assert.equal(result.aborted, false);
  assert.deepEqual(fake.calls.signalProcess, []);
  assert.deepEqual(fake.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
});

test("an empty read before the exit never counts toward the drain", async () => {
  const script: ReadStep[] = [
    { chunks: "", cursor: 0 },
    { chunks: "", cursor: 0 },
    { chunks: "BRANCH:qm-12-s99\nMR:41\n", cursor: 23, status: { state: "exited", code: 0 } },
    { chunks: "", cursor: 23, status: { state: "exited", code: 0 } },
    { chunks: "", cursor: 23, status: { state: "exited", code: 0 } },
  ];
  const fake = fakeSandbox({ reads: script });
  const result = await runFactoryProcess(baseInput(fake));
  assert.equal(fake.calls.readProcess.length, script.length);
  assert.equal(result.stdout, "BRANCH:qm-12-s99\nMR:41\n");
});

test("a read that returns bytes resets the drain counter", async () => {
  const script: ReadStep[] = [
    { chunks: "", cursor: 0, status: { state: "exited", code: 0 } },
    { chunks: "x", cursor: 1, status: { state: "exited", code: 0 } },
    { chunks: "", cursor: 1, status: { state: "exited", code: 0 } },
    { chunks: "", cursor: 1, status: { state: "exited", code: 0 } },
  ];
  const fake = fakeSandbox({ reads: script });
  const result = await runFactoryProcess(baseInput(fake));
  assert.equal(fake.calls.readProcess.length, script.length);
  assert.equal(result.stdout, "x");
});

test("an abort that lands during the drain terminates once and never escalates to a kill", async () => {
  const controller = new AbortController();
  const script: ReadStep[] = [
    { chunks: "x", cursor: 1, status: { state: "exited", code: 0 } },
    { chunks: "", cursor: 1, status: { state: "exited", code: 0 }, onServe: () => controller.abort() },
    { chunks: "", cursor: 1, status: { state: "exited", code: 0 } },
  ];
  const fake = fakeSandbox({ reads: script });
  const result = await runFactoryProcess(baseInput(fake, { signal: controller.signal, termGraceMs: 0 }));
  assert.equal(fake.calls.readProcess.length, script.length);
  assert.deepEqual(fake.calls.signalProcess, [{ handle: HANDLE, processId: "p-7", signal: "TERM" }]);
  assert.equal(result.stdout, "x");
  assert.equal(result.exitCode, 0);
  assert.equal(result.aborted, true);
  assert.deepEqual(fake.calls.teardown, [{ handle: HANDLE, opts: { keepWarm: true } }]);
});

test("a latched exit keeps counting empty reads even when a later read reports running", async () => {
  const script: ReadStep[] = [
    { chunks: "", cursor: 0, status: { state: "exited", code: 5 } },
    { chunks: "", cursor: 0 },
  ];
  const fake = fakeSandbox({ reads: script });
  const result = await runFactoryProcess(baseInput(fake));
  assert.equal(FACTORY_DRAIN_EMPTY_READS, 2);
  assert.equal(fake.calls.readProcess.length, FACTORY_DRAIN_EMPTY_READS);
  assert.equal(result.exitCode, 5);
  assert.equal(result.stdout, "");
  assert.deepEqual(fake.calls.signalProcess, []);
});
