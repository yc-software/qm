import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  FACTORY_PREFLIGHT_TIMEOUT_MS,
  FACTORY_PROOF_TOOLS,
  FACTORY_REQUIRED_TOOLS,
  factoryToolProbeScript,
  parseFactoryToolProbe,
  preflightFactorySandbox,
} from "../src/loops/factory/preflight.ts";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const handle: SandboxHandle = { id: "sbx-1", rootDir: "/workspace" };

const PROCESS_METHODS = ["startProcess", "readProcess", "writeStdin", "signalProcess", "listProcesses"] as const;

type ProcessMethod = (typeof PROCESS_METHODS)[number];
type RunOutcome = ExecResult | Error;
type RunCall = { command: string; opts: ExecOptions | undefined };

interface Fake {
  sandbox: Sandbox;
  runCalls: RunCall[];
}

const exec = (stdout: string, code = 0): ExecResult => ({ stdout, stderr: "", code, timedOut: false });

function fakeSandbox(opts: { outcomes?: RunOutcome[]; processSessions?: boolean; omit?: ProcessMethod }): Fake {
  const runCalls: RunCall[] = [];
  const outcomes = opts.outcomes ?? [];
  const unused = () => Promise.reject(new Error("preflight must not call this method"));
  const sandbox: Record<string, unknown> = {
    profile: {
      backend: "fake",
      writablePersistence: "resident_disk",
      processSessions: opts.processSessions ?? true,
    },
    provision: unused,
    run: (_handle: SandboxHandle, command: string, runOpts?: ExecOptions) => {
      runCalls.push({ command, opts: runOpts });
      const outcome = outcomes[runCalls.length - 1];
      if (outcome === undefined) return Promise.reject(new Error(`unscripted run #${runCalls.length}: ${command}`));
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
    readFile: unused,
    writeFile: unused,
    writeFileBytes: unused,
    readFileBytes: unused,
    listDir: unused,
    removeDir: unused,
    teardown: unused,
  };
  for (const method of PROCESS_METHODS) sandbox[method] = unused;
  if (opts.omit) delete sandbox[opts.omit];
  return { sandbox: sandbox as unknown as Sandbox, runCalls };
}

function runCall(fake: Fake, index: number): RunCall {
  const call = fake.runCalls[index];
  if (!call) throw new Error(`expected a run call at index ${index}, saw ${fake.runCalls.length}`);
  return call;
}

const WRAPPER_TOOLCHAIN = ["bash", "git", "gh", "jq", "curl", "node", "npm", "claude"];

const PROBE_VERSIONS: Record<string, string> = {
  bash: "GNU bash, version 5.2.15(1)-release",
  git: "",
  gh: "gh version 2.40.1 (2023-12-13)",
  jq: "jq-1.7",
  curl: "curl 8.5.0 (x86_64-pc-linux-gnu)",
  node: "v20.0.0 opt=1",
  npm: "10.2.3",
  claude: "1.0.60 (Claude Code)",
  npx: "10.2.3",
};

function versionOf(tool: string): string {
  const version = PROBE_VERSIONS[tool];
  if (version === undefined) throw new Error(`no scripted version for ${tool}`);
  return version;
}

const okStdout = (tools: readonly string[]): string =>
  `${tools.map((t) => (versionOf(t) === "" ? `${t}=ok` : `${t}=ok ${versionOf(t)}`)).join("\n")}\n`;
const versionsFor = (tools: readonly string[]): Record<string, string> =>
  Object.fromEntries(tools.map((t) => [t, versionOf(t)]));

const REQUIRED = [...FACTORY_REQUIRED_TOOLS];
const PROOFED = [...FACTORY_REQUIRED_TOOLS, ...FACTORY_PROOF_TOOLS];

const BOUND = { timeoutMs: FACTORY_PREFLIGHT_TIMEOUT_MS };

test("a sandbox that cannot host process sessions is refused before any exec", async () => {
  const variants = [fakeSandbox({ processSessions: false }), ...PROCESS_METHODS.map((omit) => fakeSandbox({ omit }))];
  for (const variant of variants) {
    assert.deepEqual(await preflightFactorySandbox(variant.sandbox, handle), {
      ok: false,
      reason: "no_process_sessions",
    });
    assert.equal(variant.runCalls.length, 0);
  }
});

test("a fully equipped sandbox passes in one bounded round trip that probes the whole toolchain", async () => {
  for (const opts of [undefined, {}, { requireProof: false }]) {
    const fake = fakeSandbox({ outcomes: [exec(okStdout(REQUIRED))] });
    assert.deepEqual(await preflightFactorySandbox(fake.sandbox, handle, opts), {
      ok: true,
      versions: versionsFor(REQUIRED),
    });
    assert.equal(fake.runCalls.length, 1);
    const call = runCall(fake, 0);
    for (const tool of WRAPPER_TOOLCHAIN) assert.ok(call.command.includes(`'${tool}'`), `probe omits ${tool}`);
    assert.deepEqual(call.opts, BOUND);
  }
});

test("tools reported missing, unreported, or reported with a malformed status are all missing", async () => {
  const stdout = `${[
    "bash=ok GNU bash, version 5.2.15(1)-release",
    "claude=missing",
    "git=ok 2.43.0",
    "jq=/bin/sh: 1: jq: not found",
    "",
    "curl=ok curl 8.5.0",
    "hello=ok 1.0",
    "node=ok v20.0.0",
    "npm=ok 10.2.3",
  ].join("\n")}\n`;
  const fake = fakeSandbox({ outcomes: [exec(stdout)] });
  assert.deepEqual(await preflightFactorySandbox(fake.sandbox, handle), {
    ok: false,
    reason: "missing_tools",
    missing: ["gh", "jq", "claude"],
    versions: {
      bash: "GNU bash, version 5.2.15(1)-release",
      git: "2.43.0",
      curl: "curl 8.5.0",
      node: "v20.0.0",
      npm: "10.2.3",
    },
  });
});

test("a transport failure on the toolchain probe propagates unchanged", async () => {
  const boom = new Error("sprites exec probe: bad envelope");
  const fake = fakeSandbox({ outcomes: [boom] });
  await assert.rejects(preflightFactorySandbox(fake.sandbox, handle, { requireProof: true }), (err: unknown) => {
    assert.equal(err, boom);
    return true;
  });
  assert.equal(fake.runCalls.length, 1);
});

test("requireProof adds one bounded playwright probe that must already be runnable", async () => {
  const fake = fakeSandbox({ outcomes: [exec(okStdout(PROOFED)), exec("Version 1.47.2\n")] });
  assert.deepEqual(await preflightFactorySandbox(fake.sandbox, handle, { requireProof: true }), {
    ok: true,
    versions: { ...versionsFor(PROOFED), playwright: "Version 1.47.2" },
  });
  assert.equal(fake.runCalls.length, 2);
  assert.ok(runCall(fake, 0).command.includes("'npx'"));
  const proofCall = runCall(fake, 1);
  assert.match(proofCall.command, /(^|\s)--no(\s|$)/);
  assert.ok(proofCall.command.includes("playwright --version"));
  assert.deepEqual(proofCall.opts, BOUND);
});

test("a playwright probe that fails or prints nothing reports playwright missing", async () => {
  for (const proof of [exec("", 1), exec("\n \n", 0)]) {
    const fake = fakeSandbox({ outcomes: [exec(okStdout(PROOFED)), proof] });
    assert.deepEqual(await preflightFactorySandbox(fake.sandbox, handle, { requireProof: true }), {
      ok: false,
      reason: "missing_tools",
      missing: ["playwright"],
      versions: versionsFor(PROOFED),
    });
  }
});

test("a missing npx and a failing playwright probe are both reported", async () => {
  const stdout = `${okStdout(REQUIRED)}npx=missing\n`;
  const fake = fakeSandbox({ outcomes: [exec(stdout), exec("", 127)] });
  assert.deepEqual(await preflightFactorySandbox(fake.sandbox, handle, { requireProof: true }), {
    ok: false,
    reason: "missing_tools",
    missing: ["npx", "playwright"],
    versions: versionsFor(REQUIRED),
  });
});

test("a transport failure on the playwright probe propagates unchanged", async () => {
  const boom = new Error("sprites exec probe: connection reset");
  const fake = fakeSandbox({ outcomes: [exec(okStdout(PROOFED)), boom] });
  await assert.rejects(preflightFactorySandbox(fake.sandbox, handle, { requireProof: true }), (err: unknown) => {
    assert.equal(err, boom);
    return true;
  });
  assert.equal(fake.runCalls.length, 2);
});

test("the generated probe round-trips through the parser under a real /bin/sh", () => {
  const tools = ["node", "npm", "definitely-not-a-tool"];
  const stdout = execFileSync("/bin/sh", ["-c", factoryToolProbeScript(tools)], { encoding: "utf8" });
  const { versions, missing } = parseFactoryToolProbe(stdout, tools);
  assert.deepEqual(missing, ["definitely-not-a-tool"]);
  assert.ok((versions.node ?? "").length > 0);
  assert.ok((versions.npm ?? "").length > 0);
});
