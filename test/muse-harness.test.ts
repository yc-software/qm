import test from "node:test";
import assert from "node:assert/strict";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import {
  MUSE_KEY_MISSING,
  buildMuseExecArgs,
  createMuseHarness,
  museChildEnv,
  parseMuseJsonl,
  resolveMuseEffort,
  resolveMuseModel,
} from "../src/harness/muse-harness.ts";
import {
  DEFAULT_MUSE_MODEL_ID,
  defaultModelForHarness,
  harnessSupportsFastMode,
  modelSupportedByHarness,
  thinkingLevelsForHarness,
} from "../src/model/pi-models.ts";
import { resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { SessionEntry } from "../src/types.ts";

function turn(overrides: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  const emitted: SessionEntry[] = [];
  return {
    session: { id: "s1" } as HarnessTurnInput["session"],
    input: "do substantive work",
    systemPrompt: "coordinator frames",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "org:default-org" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:default-org" as HarnessTurnInput["orgScopeId"],
    emit: async (entry) => {
      const saved = { ...entry, sessionId: "s1", seq: emitted.length + 1, createdAt: 1 } as SessionEntry;
      emitted.push(saved);
      return saved;
    },
    recordModelCall: () => {},
    ...overrides,
  };
}

function echoStdout(text: string): string {
  const base = (seq: number, payloadType: string, payload: unknown) =>
    JSON.stringify({ payload_type: payloadType, payload, sequence: seq });
  return [
    base(1, "run.output.delta", { kind: "run_output_delta", text }),
    base(2, "run.terminal.completed", { kind: "run_terminal", terminal: "completed", text, reason: null }),
  ].join("\n");
}

test("muse exec args use only verified flags with read-only posture", () => {
  const args = buildMuseExecArgs({
    promptFile: "/tmp/p.txt",
    model: "muse-spark-1.3",
    reasoningEffort: "high",
    maxModelSteps: 20,
    provider: "meta",
    apiKeyStdin: true,
    noSessionLog: true,
  });
  assert.ok(args.includes("exec"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--prompt-file"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("--reasoning-effort"));
  assert.ok(args.includes("--max-model-steps"));
  assert.ok(args.includes("--no-foreign-personal-context"));
  assert.ok(args.includes("--disable-write"));
  assert.ok(args.includes("--disable-shell"));
  assert.ok(args.includes("--approval-mode"));
  assert.ok(args.includes("on-request"));
  assert.ok(args.includes("--sandbox-network"));
  assert.ok(args.includes("--api-key-stdin"));
  assert.ok(args.includes("--no-session-log"));
  const joined = args.join(" ");
  assert.equal(joined.includes("--yolo"), false);
  assert.equal(joined.includes("--disable-approval"), false);
  assert.equal(joined.includes("--disable-sandbox"), false);
  assert.equal(joined.includes("--trust-workspace"), false);
  assert.equal(joined.includes("mcp"), false);
});

test("muse child env strips credentials and allowlists safe keys", () => {
  const env = museChildEnv(
    {
      PATH: "/bin",
      GITHUB_TOKEN: "gh",
      GH_TOKEN: "gh",
      AWS_ACCESS_KEY_ID: "ak",
      AWS_SECRET_ACCESS_KEY: "sk",
      BASEROW_TOKEN: "b",
      BASEROW_API_KEY: "b",
      REPL_TOKEN: "r",
      DATABASE_URL: "db",
      CORE_SIGNING_SECRET: "s",
      MUSE_API_KEY: "must-not-leak-via-env",
      OPENAI_API_KEY: "o",
      HOME: "/host",
    },
    "/jail",
  );
  assert.equal(env.HOME, "/jail");
  assert.equal(env.PATH, "/bin");
  for (const key of Object.keys(env)) {
    assert.equal(key.startsWith("GITHUB_"), false);
    assert.equal(key.startsWith("AWS_"), false);
    assert.equal(key.startsWith("BASEROW_"), false);
    assert.equal(key.startsWith("REPL_"), false);
  }
  assert.equal("GITHUB_TOKEN" in env, false);
  assert.equal("DATABASE_URL" in env, false);
  assert.equal("CORE_SIGNING_SECRET" in env, false);
  assert.equal("MUSE_API_KEY" in env, false);
  assert.equal("OPENAI_API_KEY" in env, false);
});

test("muse JSONL parse follows observed echo shapes and counts malformed", () => {
  const parsed = parseMuseJsonl(`${echoStdout("echo: hi\n")}\nnot-json\n{"payload_type":"x"}`);
  assert.equal(parsed.terminal?.status, "completed");
  assert.equal(parsed.text, "echo: hi\n");
  assert.equal(parsed.malformed, 2);
  const failed = parseMuseJsonl(
    JSON.stringify({
      payload_type: "run.terminal.failed",
      payload: { kind: "run_terminal", terminal: "failed", reason: "bad model" },
    }),
  );
  assert.equal(failed.terminal?.status, "failed");
  const empty = parseMuseJsonl("oops\n");
  assert.equal(empty.terminal, null);
  assert.equal(empty.malformed, 1);
});

test("muse registry uses configured model without tier switching", () => {
  assert.equal(DEFAULT_MUSE_MODEL_ID, "muse-spark-1.3");
  assert.equal(modelSupportedByHarness("muse-spark-1.3", "muse"), true);
  assert.equal(modelSupportedByHarness("claude-opus-5", "muse"), false);
  assert.equal(modelSupportedByHarness("muse-spark-1.3", "claude"), false);
  assert.equal(defaultModelForHarness("muse", undefined), "muse-spark-1.3");
  assert.equal(defaultModelForHarness("muse", "muse-spark-1.3"), "muse-spark-1.3");
  assert.ok(thinkingLevelsForHarness("muse", "muse-spark-1.3").includes("high"));
  assert.ok(thinkingLevelsForHarness("muse", "muse-spark-1.3").includes("xhigh"));
  assert.equal(harnessSupportsFastMode("muse"), false);
  assert.equal(resolveMuseModel(undefined, undefined), "muse-spark-1.3");
  assert.equal(resolveMuseModel("muse-spark-1.3", undefined), "muse-spark-1.3");
  assert.throws(() => resolveMuseModel("claude-opus-5", undefined), /not served by the muse harness/);
  assert.equal(resolveMuseEffort("high", "muse-spark-1.3"), "high");
  assert.throws(() => resolveMuseEffort("bogus", "muse-spark-1.3"), /not supported/);
});

test("muse child purpose runtime resolves through the real router", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["claude", "muse"]);
  const fallback = { harnessId: "claude" as const, modelId: "claude-opus-5" };
  await config.setPurposeRuntime("subagent", { harnessId: "muse", modelId: "muse-spark-1.3" });
  const choice = await resolveRuntimeChoiceDurable(
    config,
    "org:default-org",
    "personal:t",
    fallback,
    undefined,
    undefined,
    "subagent",
  );
  assert.equal(choice.harnessId, "muse");
  assert.equal(choice.modelId, "muse-spark-1.3");
});

test("muse run succeeds on terminal event and redacts keys", async () => {
  const seen: { args: readonly string[]; stdin?: string }[] = [];
  const harness = createMuseHarness({
    provider: "meta",
    apiKey: "muse-key-xyz-789",
    spawnImpl: async (_cmd, args, options) => {
      seen.push({ args, ...(options.stdinData ? { stdin: options.stdinData } : {}) });
      return { exitCode: 0, stdout: echoStdout("proposal with key muse-key-xyz-789 inside\n"), stderr: "" };
    },
  });
  const emitted: SessionEntry[] = [];
  const result = await harness.turns.runTurn(
    turn({
      emit: async (entry) => {
        const saved = { ...entry, sessionId: "s1", seq: emitted.length + 1, createdAt: 1 } as SessionEntry;
        emitted.push(saved);
        return saved;
      },
    }),
  );
  assert.equal(result.modelCalls, 1);
  assert.equal(result.reply.includes("muse-key-xyz-789"), false);
  assert.equal(emitted.filter((e) => e.type === "user").length, 1);
  assert.equal(emitted.filter((e) => e.type === "assistant").length, 1);
  assert.equal(seen[0]!.args.join(" ").includes("muse-key-xyz-789"), false);
});

test("muse run fails closed on missing key with no fallback", async () => {
  const harness = createMuseHarness({
    provider: "meta",
    spawnImpl: async () => ({ exitCode: 0, stdout: echoStdout("x"), stderr: "" }),
  });
  await assert.rejects(() => harness.turns.runTurn(turn()), new RegExp(MUSE_KEY_MISSING.slice(0, 20)));
});

test("muse run fails closed on missing CLI with no fallback", async () => {
  const harness = createMuseHarness({
    provider: "echo",
    spawnImpl: async () => {
      const error = Object.assign(new Error("spawn muse ENOENT"), { code: "ENOENT" });
      throw error;
    },
  });
  await assert.rejects(() => harness.turns.runTurn(turn()), /muse CLI unavailable/);
});

test("muse run fails closed on unsupported model with no fallback", async () => {
  const harness = createMuseHarness({
    provider: "echo",
    spawnImpl: async () => ({ exitCode: 0, stdout: echoStdout("x"), stderr: "" }),
  });
  await assert.rejects(
    () => harness.turns.runTurn(turn({ runtime: { harnessId: "muse", modelId: "claude-opus-5" } })),
    /not served by the muse harness/,
  );
});

test("muse run rejects missing terminal and failed terminal", async () => {
  const missing = createMuseHarness({
    provider: "echo",
    spawnImpl: async () => ({ exitCode: 0, stdout: "garbage\n", stderr: "" }),
  });
  await assert.rejects(() => missing.turns.runTurn(turn()), /no terminal event/);
  const failed = createMuseHarness({
    provider: "echo",
    spawnImpl: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        payload_type: "run.terminal.failed",
        payload: { kind: "run_terminal", terminal: "failed", reason: "bad model" },
      }),
      stderr: "",
    }),
  });
  await assert.rejects(() => failed.turns.runTurn(turn()), /muse run failed/);
});

test("muse run honors cancellation and timeout without claiming acceptance", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = createMuseHarness({
    provider: "echo",
    spawnImpl: async (_cmd, _args, options) => {
      options.signal?.throwIfAborted();
      return { exitCode: null, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(() => cancelled.turns.runTurn(turn({ cancel: controller.signal })), /abort|cancel/i);
  const timedOut = createMuseHarness({
    provider: "echo",
    spawnImpl: async () => {
      throw new Error("muse run timed out after 5ms");
    },
  });
  await assert.rejects(() => timedOut.turns.runTurn(turn({ turnWallClockMs: 5 })), /timed out/);
});

test("muse key travels via stdin only and never lands in args", async () => {
  let captured = "";
  const harness = createMuseHarness({
    provider: "meta",
    apiKey: "secret-key",
    spawnImpl: async (_cmd, args, options) => {
      captured = args.join(" ");
      assert.equal(captured.includes("secret-key"), false);
      assert.equal(options.stdinData, "secret-key\n");
      return { exitCode: 0, stdout: echoStdout("done\n"), stderr: "" };
    },
  });
  const result = await harness.turns.runTurn(turn());
  assert.equal(result.reply, "done\n");
});

test("split key deltas are redacted before durable streaming", async () => {
  const key = "split-key-value-789";
  const streamed: string[] = [];
  const harness = createMuseHarness({
    apiKey: key,
    spawnImpl: async (_cmd, args, options) => {
      assert.equal(args[args.indexOf("--workspace") + 1], options.cwd);
      assert.equal(options.cwd, options.env.HOME);
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ payload_type: "run.output.delta", payload: { text: "split-key-" } }),
          JSON.stringify({ payload_type: "run.output.delta", payload: { text: "value-789" } }),
          JSON.stringify({
            payload_type: "run.terminal.completed",
            payload: { kind: "run_terminal", terminal: "completed", text: key },
          }),
        ].join("\n"),
        stderr: "",
      };
    },
  });
  const result = await harness.turns.runTurn(
    turn({
      onDelta: (text) => {
        streamed.push(text);
      },
    }),
  );
  assert.equal(streamed.join("").includes(key), false);
  assert.equal(result.reply.includes(key), false);
});

test("real missing CLI remains non-retryable without charging a model call", async () => {
  let calls = 0;
  const harness = createMuseHarness({ binaryPath: "/nonexistent-muse-cli-for-test", apiKey: "test-only-key" });
  await assert.rejects(
    () =>
      harness.turns.runTurn(
        turn({
          recordModelCall: () => {
            calls += 1;
          },
        }),
      ),
    NonRetryableTurnError,
  );
  assert.equal(calls, 0);
});

test("a child closing stdin fails without an unhandled EPIPE", async () => {
  const harness = createMuseHarness({
    binaryPath: "/usr/bin/false",
    apiKey: "fake".repeat(65536),
    turnWallClockMs: 3000,
  });
  await assert.rejects(() => harness.turns.runTurn(turn()));
});
