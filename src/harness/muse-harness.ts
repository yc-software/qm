import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import type { Config } from "../config.ts";
import {
  DEFAULT_MUSE_MODEL_ID,
  contextTokenBudgetForModel,
  modelSupportedByHarness,
  modelUnavailableReason,
  thinkingLevelsForHarness,
} from "../model/pi-models.ts";
import type { ScopeId } from "../types.ts";
import { countTokens } from "../util/tokens.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";
import { oneShotModelUtilities, oneShotRunner, type HarnessToolPlumbing } from "./harness-shared.ts";
import { redactSecrets } from "./redact-secrets.ts";

export const MUSE_CLI_MISSING = "muse CLI unavailable: install muse and set MUSE_BIN or PATH";
export const MUSE_KEY_MISSING =
  "muse provider key unavailable: register a keychain credential via MUSE_AUTH_CREDENTIAL";
export const MUSE_MODEL_MISSING = "muse model unavailable: set MUSE_MODEL to an allowed muse model";

export const MUSE_API_ENV_KEY = "META_API_KEY";
const MUSE_MAX_OUTPUT_BYTES = 512 * 1024;
const MUSE_DENIED_ENV_PREFIXES = ["GITHUB_", "AWS_", "BASEROW_", "REPL_"];
const MUSE_DENIED_ENV_EXACT = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "BASEROW_TOKEN",
  "BASEROW_API_KEY",
  "REPL_IDENTITY",
  "REPL_TOKEN",
  "DATABASE_URL",
  "CORE_SIGNING_SECRET",
  "DEPLOYMENT_CONTROL_SECRET",
  "META_API_KEY",
  "MUSE_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_ACCESS_TOKEN",
]);
const MUSE_ENV_ALLOW = new Set([
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

export function museChildEnv(source: NodeJS.ProcessEnv, jail: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: jail };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (MUSE_DENIED_ENV_EXACT.has(key)) continue;
    if (MUSE_DENIED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (!MUSE_ENV_ALLOW.has(key)) continue;
    env[key] = value;
  }
  return env;
}

export interface MuseExecRequest {
  promptFile: string;
  model: string;
  reasoningEffort: string;
  maxModelSteps: number;
  workspace?: string;
  permissionProfile?: string;
  provider?: string;
  apiKeyStdin: boolean;
  noSessionLog: boolean;
}

export function buildMuseExecArgs(request: MuseExecRequest): string[] {
  const args = ["exec", "--json", "--prompt-file", request.promptFile, "--model", request.model];
  if (request.provider) args.push("--provider", request.provider);
  args.push("--reasoning-effort", request.reasoningEffort);
  args.push("--max-model-steps", String(request.maxModelSteps));
  if (request.workspace) args.push("--workspace", request.workspace);
  args.push("--no-foreign-personal-context", "--disable-web-tools", "--disable-write", "--disable-shell");
  args.push("--approval-mode", "on-request", "--approval-judge", "off", "--sandbox-network", "proxy-only");
  if (request.permissionProfile) args.push("--permission-profile", request.permissionProfile);
  if (request.apiKeyStdin) args.push("--api-key-stdin");
  if (request.noSessionLog) args.push("--no-session-log");
  return args;
}

export type MuseTerminal = { status: "completed"; text: string } | { status: "failed"; reason: string };

export interface MuseParseResult {
  deltas: string[];
  terminal: MuseTerminal | null;
  malformed: number;
  terminals: number;
  conflicting: boolean;
  text: string;
}

function terminalFromPayload(payload: Record<string, unknown>): MuseTerminal | null {
  const kind = payload.kind;
  if (kind === "run_terminal") {
    const terminal = payload.terminal;
    if (terminal === "completed")
      return { status: "completed", text: typeof payload.text === "string" ? payload.text : "" };
    if (terminal === "failed")
      return { status: "failed", reason: typeof payload.reason === "string" ? payload.reason : "muse run failed" };
    return null;
  }
  return null;
}

export function parseMuseJsonl(stdout: string): MuseParseResult {
  const deltas: string[] = [];
  let terminal: MuseTerminal | null = null;
  let malformed = 0;
  let terminals = 0;
  let conflicting = false;
  const noteTerminal = (next: MuseTerminal) => {
    terminals += 1;
    if (terminal && (terminal.status !== next.status || terminalText(terminal) !== terminalText(next)))
      conflicting = true;
    terminal = next;
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      malformed += 1;
      continue;
    }
    const payloadType = row.payload_type;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    if (typeof payloadType !== "string") {
      malformed += 1;
      continue;
    }
    if (payloadType === "run.output.delta") {
      const text = payload.text;
      if (typeof text === "string" && text) deltas.push(text);
      else malformed += 1;
      continue;
    }
    if (payloadType === "run.terminal.completed" || payloadType === "run.lifecycle.completed") {
      const parsed = terminalFromPayload(payload);
      if (parsed) noteTerminal(parsed);
      else if (typeof payload.text === "string") noteTerminal({ status: "completed", text: payload.text });
      else malformed += 1;
      continue;
    }
    if (payloadType === "run.terminal.failed" || payloadType === "run.lifecycle.failed") {
      const parsed = terminalFromPayload(payload);
      if (parsed) noteTerminal(parsed);
      else if (typeof payload.reason === "string") noteTerminal({ status: "failed", reason: payload.reason });
      else malformed += 1;
      continue;
    }
    malformed += 1;
  }
  return { deltas, terminal, malformed, terminals, conflicting, text: deltas.join("") };
}

function terminalText(terminal: MuseTerminal): string {
  return terminal.status === "completed" ? terminal.text : terminal.reason;
}

export function resolveMuseModel(requested: string | undefined, configured: string | undefined): string {
  const candidate = requested?.trim() || configured?.trim() || DEFAULT_MUSE_MODEL_ID;
  const unavailable = modelUnavailableReason(candidate);
  if (unavailable) throw new NonRetryableTurnError(`${candidate}: ${unavailable}`);
  if (!modelSupportedByHarness(candidate, "muse"))
    throw new NonRetryableTurnError(`${candidate} is not served by the muse harness`);
  return candidate;
}

export function resolveMuseEffort(requested: string | undefined, model: string): string {
  const candidate = requested?.trim() || "high";
  if (!thinkingLevelsForHarness("muse", model).includes(candidate))
    throw new NonRetryableTurnError(`${candidate} reasoning is not supported by muse/${model}`);
  return candidate === "auto" ? "high" : candidate;
}

export function redactMuseOutput(value: string, apiKey?: string): string {
  const key = apiKey?.trim();
  const exact = key ? value.split(key).join("[redacted]") : value;
  return redactSecrets(exact);
}

export interface MuseSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type MuseSpawnImpl = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdinData?: string; signal?: AbortSignal; timeoutMs?: number; cwd?: string },
) => Promise<MuseSpawnResult>;

async function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdinData?: string; signal?: AbortSignal; timeoutMs?: number; cwd?: string },
): Promise<MuseSpawnResult> {
  options.signal?.throwIfAborted();
  return new Promise<MuseSpawnResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: options.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          swallow("muse process cleanup", error);
        }
      }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.removeAllListeners("error");
      child.removeAllListeners("close");
    };
    const finish = (result: MuseSpawnResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        killGroup();
        fail(new Error(`muse run timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
      timer.unref?.();
    }
    const abortHandler =
      options.signal === undefined
        ? undefined
        : () => {
            killGroup();
            fail(new Error("muse run was cancelled"));
          };
    if (options.signal && abortHandler) options.signal.addEventListener("abort", abortHandler, { once: true });
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") {
        if (stdout.length < MUSE_MAX_OUTPUT_BYTES) stdout += text.slice(0, MUSE_MAX_OUTPUT_BYTES - stdout.length);
      } else if (stderr.length < MUSE_MAX_OUTPUT_BYTES) {
        stderr += text.slice(0, MUSE_MAX_OUTPUT_BYTES - stderr.length);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") fail(new NonRetryableTurnError(MUSE_CLI_MISSING));
      else fail(error);
    });
    child.on("close", (code) => {
      finish({ exitCode: code, stdout, stderr: redactSecrets(stderr) });
    });
    child.stdin?.on("error", (error: Error) => {
      killGroup();
      fail(error);
    });
    if (options.stdinData !== undefined) {
      try {
        child.stdin?.write(options.stdinData);
      } catch (error) {
        killGroup();
        fail(error instanceof Error ? error : new Error(errMessage(error)));
        return;
      }
    }
    try {
      child.stdin?.end();
    } catch (error) {
      killGroup();
      fail(error instanceof Error ? error : new Error(errMessage(error)));
    }
  });
}

export interface MuseHarnessOptions extends HarnessToolPlumbing {
  modelId?: string | ((scope?: ScopeId) => string | undefined);
  defaultModelId?: string;
  judgeModelId?: string;
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  turnWallClockMs?: number;
  maxModelSteps?: number;
  permissionProfile?: string;
  provider?: string;
  apiKey?: string;
  apiKeyResolver?: () => Promise<string | undefined>;
  signals?: import("../runs/run-signal-store.ts").RunSignalStore;
  tasks?: import("../tasks/task-store.ts").TaskStore;
  spawnImpl?: MuseSpawnImpl;
}

export function museHarnessConfigOptions(config: Config): MuseHarnessOptions {
  return {
    ...(config.museModel ? { defaultModelId: config.museModel } : {}),
    ...(config.museBinPath ? { binaryPath: config.museBinPath } : {}),
    ...(config.musePermissionProfile ? { permissionProfile: config.musePermissionProfile } : {}),
    ...(config.museMaxModelSteps !== undefined ? { maxModelSteps: config.museMaxModelSteps } : {}),
    ...coreMuseToolOptions(config),
  };
}

function coreMuseToolOptions(config: Config): HarnessToolPlumbing {
  return {
    ...(config.execTimeoutDefaultMs !== undefined ? { execTimeoutMs: config.execTimeoutDefaultMs } : {}),
    ...(config.execTimeoutMaxMs !== undefined ? { execTimeoutCeilingMs: config.execTimeoutMaxMs } : {}),
    ...(config.backgroundJobTtlMs !== undefined ? { backgroundJobTtlMs: config.backgroundJobTtlMs } : {}),
    ...(config.backgroundJobTtlMaxMs !== undefined ? { backgroundJobTtlMaxMs: config.backgroundJobTtlMaxMs } : {}),
  };
}

function configuredModel(options: MuseHarnessOptions, scope?: ScopeId): string | undefined {
  if (typeof options.modelId === "function") return options.modelId(scope);
  return options.modelId ?? options.defaultModelId;
}

function promptText(turn: HarnessTurnInput): string {
  const history = turn.history
    .filter((entry) => entry.type === "user" || entry.type === "assistant")
    .map((entry) => {
      const text = (entry.payload as { text?: unknown }).text;
      return typeof text === "string" && text.trim() ? `${entry.type}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return [
    `System: ${turn.systemPrompt}`,
    history ? `History:\n${history}` : "",
    `Task: ${turn.input}`,
    turn.environment ? `Environment:\n${turn.environment}` : "",
    "Respond with substantive work only. Do not claim to have applied, published, or delivered anything outside this response. Return a code proposal when changes are needed.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createMuseHarness(options: MuseHarnessOptions = {}): Harness {
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const runPrompt = async (turn: HarnessTurnInput): Promise<HarnessTurnResult> => {
    const requestedModel = turn.runtime?.modelId;
    const model = resolveMuseModel(requestedModel, configuredModel(options, turn.scopeLabel));
    const effort = resolveMuseEffort(turn.runtime?.effortLevel, model);
    const provider = options.provider ?? "meta";
    let apiKey: string | undefined;
    if (provider !== "echo") {
      apiKey = options.apiKey ?? (await options.apiKeyResolver?.());
      if (!apiKey?.trim()) throw new NonRetryableTurnError(MUSE_KEY_MISSING);
    }
    const binary = options.binaryPath?.trim() || "muse";
    const timeoutMs = turn.turnWallClockMs ?? options.turnWallClockMs;
    const maxModelSteps = options.maxModelSteps ?? 20;
    const scrub = (value: string): string => redactMuseOutput(value, apiKey);
    const jail = mkdtempSync(join(tmpdir(), "muse-child-"));
    chmodSync(jail, 0o700);
    try {
      const promptFile = join(jail, "prompt.txt");
      writeFileSync(promptFile, promptText(turn), "utf8");
      chmodSync(promptFile, 0o600);
      const args = buildMuseExecArgs({
        promptFile,
        model,
        reasoningEffort: effort,
        maxModelSteps,
        workspace: jail,
        ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
        provider,
        apiKeyStdin: provider !== "echo",
        noSessionLog: true,
      });
      const env = museChildEnv(options.env ?? {}, jail);
      const startedAt = Date.now();
      const userEntry = await turn.emit({
        type: "user",
        payload: {
          text: turn.input,
          ...((turn.triggerTs ?? turn.entryTs) ? { ts: turn.triggerTs ?? turn.entryTs } : {}),
        },
        scopeLabel: turn.scopeLabel,
      });
      let result: MuseSpawnResult;
      try {
        result = await spawnImpl(binary, args, {
          env,
          cwd: jail,
          ...(apiKey ? { stdinData: `${apiKey}\n` } : {}),
          ...(turn.cancel ? { signal: turn.cancel } : {}),
          timeoutMs,
        });
      } catch (error) {
        if (error instanceof NonRetryableTurnError) throw new NonRetryableTurnError(scrub(error.message));
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new NonRetryableTurnError(MUSE_CLI_MISSING);
        throw error instanceof Error ? new Error(scrub(error.message)) : error;
      }
      const parsed = parseMuseJsonl(result.stdout);
      const stderrNote = result.stderr.trim() ? ` stderr: ${scrub(result.stderr.trim().slice(-500))}` : "";
      if (parsed.conflicting) throw new Error("muse run produced conflicting terminal events");
      if (result.exitCode !== 0)
        throw new Error(`muse run exited ${result.exitCode ?? "unknown"} without success${stderrNote}`);
      if (!parsed.terminal) {
        throw new Error(`muse run produced no terminal event (${parsed.malformed} malformed)${stderrNote}`);
      }
      if (parsed.terminal.status === "failed") throw new Error(`muse run failed: ${scrub(parsed.terminal.reason)}`);
      const reply = scrub(parsed.terminal.text.trim() ? parsed.terminal.text : parsed.text);
      if (!reply.trim()) throw new Error("muse run produced an empty result");
      turn.recordModelCall({
        model: `muse/${model}`,
        inputTokens: countTokens(turn.systemPrompt) + countTokens(turn.input),
        entryCount: turn.history.length,
      });
      if (parsed.text) turn.onDelta?.(scrub(parsed.text));
      await turn.recordLlmRequest?.({
        turnSeq: userEntry.seq,
        step: 0,
        model: `muse/${model}`,
        promptEnvelope: { model, system: turn.systemPrompt, messages: [{ role: "user", content: turn.input }] },
        truncated: false,
        durationMs: Date.now() - startedAt,
      });
      const assistantEntry = await turn.emit({
        type: "assistant",
        payload: { text: reply },
        scopeLabel: turn.scopeLabel,
      });
      void assistantEntry;
      return { reply, modelCalls: 1 };
    } finally {
      try {
        rmSync(jail, { recursive: true, force: true });
      } catch (error) {
        swallow("muse workspace cleanup", error);
      }
    }
  };
  const single = oneShotRunner(runPrompt);
  return defineHarness(
    {
      id: "muse",
      controlTransport: "in-process",
      toolTransport: "in-process",
      transcriptFormat: "qm",
      capabilities: new Set(),
    },
    {
      runTurn: runPrompt,
      ...oneShotModelUtilities(single, options.judgeModelId),
      contextTokenBudget: (_scopeLabel?: string, model?: string) => {
        const budget = contextTokenBudgetForModel(model ?? DEFAULT_MUSE_MODEL_ID);
        return budget ?? 150_000;
      },
    },
  );
}
