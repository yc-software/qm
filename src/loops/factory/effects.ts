import {
  CapabilityUnsupportedError,
  supportsProcessSessions,
  type Sandbox,
  type SandboxHandle,
} from "../../sandbox/sandbox.ts";
import type { FactoryConfig, ScopedConfigStore } from "../../resolution/config-store.ts";
import type { ServiceCredentialReader } from "../../credentials/keychain.ts";
import type { Loop, LoopItem, ScopeId } from "../../types.ts";
import { isRunnable, type LoopStore } from "../loop-store.ts";
import type { CapturedArtifact, LoopRunnerEffects } from "../runner.ts";
import type { SuccessVerdict } from "../success-evaluation.ts";
import { createSweeper } from "../../util/sweeper.ts";
import { errMessage, swallow } from "../../util/errors.ts";
import { shq } from "../../util/shell.ts";
import { pollProcess } from "../../sandbox/process-poll.ts";
import { enumerateFactoryCandidates } from "./linear-intake.ts";
import { readFactoryCredentials } from "./credentials.ts";
import { preflightFactorySandbox, type PreflightResult } from "./preflight.ts";
import {
  isFactoryTicketId,
  renderFactoryEnv,
  runFactoryProcess,
  type FactoryProcessResult,
  type FactorySlackTarget,
} from "./process-work.ts";
import { parseFactoryContract } from "./contract.ts";
import { evaluateFactoryForge } from "./forge-evaluate.ts";
import type { ForgeRef } from "./ship.ts";

const DEFAULT_FACTORY_REPO_DIR = "/workspace/repo";
const DEFAULT_PAUSE_POLL_MS = 30_000;

const FACTORY_SOURCE_CLONE_DIR = "/workspace/qm-yc";
const FACTORY_SOURCE_CLONE_URL = "https://github.com/yc-software/qm-yc.git";
const FACTORY_SOURCE_BOOTSTRAP_TIMEOUT_MS = 300_000;

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_POST_TIMEOUT_MS = 10_000;

export const FACTORY_SOURCE_DIR = `${FACTORY_SOURCE_CLONE_DIR}/layer/factory`;
export const FACTORY_SOURCE_BRANCH = "qm-30-s18477";

const FACTORY_SOURCE_BOOTSTRAP_SCRIPT = [
  "set -e;",
  `if [ -d ${shq(`${FACTORY_SOURCE_CLONE_DIR}/.git`)} ]; then`,
  `git -C ${shq(FACTORY_SOURCE_CLONE_DIR)} fetch --depth 1 origin ${shq(FACTORY_SOURCE_BRANCH)};`,
  `git -C ${shq(FACTORY_SOURCE_CLONE_DIR)} checkout -f FETCH_HEAD;`,
  "else",
  `git clone --depth 1 --single-branch --branch ${shq(FACTORY_SOURCE_BRANCH)} ${shq(FACTORY_SOURCE_CLONE_URL)} ${shq(FACTORY_SOURCE_CLONE_DIR)};`,
  "fi",
].join(" ");

export const FACTORY_LOOP_SURFACE = "factory";

// The wrapper's ownership marker and session branch need a positive integer that is stable across an
// item's attempts, so a re-run revises the same branch and PR, and distinct across items; a loop has no
// ECS session, so the item key is hashed into one.
export function factorySessionIdFor(itemKey: string): number {
  let hash = 0x811c9dc5;
  for (const ch of itemKey) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 2_000_000_000) + 1;
}

export const isFactoryLoop = (loop: Loop): boolean => loop.surface === FACTORY_LOOP_SURFACE;

export const factoryForgeRef = (config: FactoryConfig, externalRef: string | undefined): ForgeRef | null => {
  const digits = /(\d+)$/.exec(externalRef ?? "")?.[1];
  return digits === undefined
    ? null
    : { forge: config.forge, publishProject: config.publishProject, number: Number(digits) };
};

export interface FactoryEffectsDeps {
  sandbox: Sandbox;
  config: Pick<ScopedConfigStore, "getFactoryConfig">;
  credentials: ServiceCredentialReader;
  orgScopeId: ScopeId;
  loops: Pick<LoopStore, "get">;
  repoDir?: string;
  fetch?: typeof globalThis.fetch;
  pausePollMs?: number;
}

export interface FactoryContext {
  config: FactoryConfig;
  linearApiKey: string;
  githubToken: string;
  anthropicApiKey: string;
  slackBotToken?: string;
}

export type FactoryWorkEffects = Pick<LoopRunnerEffects, "enumerate" | "work" | "captureOutputs" | "evaluate">;

interface FactoryRun {
  result: FactoryProcessResult;
  config: FactoryConfig;
  redact: (text: string) => string;
}

// Only the wrapper's own diagnostics are worth surfacing; build noise and agent chatter are not.
const DIAGNOSTIC_LINE = /^\[(?:io-coding-agent(?:-js)?|claude-stderr|claude-exit|converge)\]|^error=|FAIL/;
const NO_PR_TAIL_LINES = 3;
const NO_PR_LINE_CHARS = 200;

const redactor =
  (secrets: string[]) =>
  (text: string): string =>
    secrets.filter((secret) => secret !== "").reduce((acc, secret) => acc.split(secret).join("***"), text);

const preflightDetail = (result: Extract<PreflightResult, { ok: false }>): string =>
  result.reason === "missing_tools" ? `missing_tools: ${result.missing.join(", ")}` : result.reason;

// A run that ends without a pull request leaves its only explanation in the wrapper's stdout, which
// otherwise stays inside the sandbox; the redacted diagnostic tail rides on the item's reason.
const noPrVerdict = (run?: FactoryRun): SuccessVerdict => {
  const tail = run
    ? run
        .redact(run.result.stdout)
        .split(/\r?\n/)
        .filter((line) => DIAGNOSTIC_LINE.test(line))
        .slice(-NO_PR_TAIL_LINES)
        .map((line) => line.slice(0, NO_PR_LINE_CHARS))
        .join(" | ")
    : "";
  return {
    outcome: "continue",
    reason: tail === "" ? "no pull request" : `no pull request — ${tail}`,
    checks: [],
    judged: false,
  };
};

const prTarget = (artifacts: CapturedArtifact[], config: FactoryConfig): { ref: ForgeRef; branch: string } | null => {
  const pr = artifacts.find((artifact) => artifact.shipAction === "open_pr");
  const ref = factoryForgeRef(config, pr?.externalRef);
  return pr?.label && ref ? { ref, branch: pr.label } : null;
};

const factorySourceGitEnv = (githubToken: string): Record<string, string> => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `url.https://x-access-token:${githubToken}@github.com/.insteadOf`,
  GIT_CONFIG_VALUE_0: "https://github.com/",
});

async function bootstrapFactorySource(sandbox: Sandbox, handle: SandboxHandle, githubToken: string): Promise<void> {
  if (!supportsProcessSessions(sandbox)) {
    throw new CapabilityUnsupportedError(sandbox.profile.backend, "process sessions");
  }
  const { processId } = await sandbox.startProcess(handle, FACTORY_SOURCE_BOOTSTRAP_SCRIPT, {
    env: factorySourceGitEnv(githubToken),
  });
  const { output, status } = await pollProcess(sandbox, handle, processId, {
    deadlineMs: FACTORY_SOURCE_BOOTSTRAP_TIMEOUT_MS,
    collect: true,
  });
  // Auth failures, a missing branch, and a missing repository all exit 128; only git's own words tell them apart.
  const tail = output.replaceAll(githubToken, "***").trim().split("\n").slice(-5).join(" | ");
  const detail = (reason: string): string => `factory_source_bootstrap_failed: ${reason}${tail ? ` — ${tail}` : ""}`;
  if (status.state !== "exited") {
    await sandbox.signalProcess(handle, processId, "TERM").catch((e: unknown) => swallow("factory bootstrap term", e));
    throw new Error(detail("timeout"));
  }
  if (status.code !== 0) throw new Error(detail(`exit ${status.code}`));
}

const factorySlackChannel = (config: FactoryConfig): string | undefined => {
  const channel = config.slackChannel?.trim();
  return channel ? channel : undefined;
};

async function openFactorySlackThread(input: {
  fetch?: typeof globalThis.fetch;
  botToken: string;
  channel: string;
  ticket: string;
}): Promise<FactorySlackTarget | undefined> {
  const doFetch = input.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: input.channel, text: `Working on ${input.ticket}` }),
      signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      ts?: string;
      channel?: string;
    } | null;
    if (body?.ok !== true) throw new Error(body?.error ?? `HTTP ${res.status}`);
    const threadTs = body.ts?.trim();
    if (!threadTs) throw new Error("response carried no ts");
    return { botToken: input.botToken, channelId: body.channel?.trim() || input.channel, threadTs };
  } catch (e: unknown) {
    swallow("factory slack thread root", new Error(`slack_post_failed: ${errMessage(e)}`));
    return undefined;
  }
}

export async function loadFactoryContext(deps: FactoryEffectsDeps): Promise<FactoryContext> {
  const config = deps.config.getFactoryConfig();
  if (!config) throw new Error("factory_config_missing");
  const credentials = await readFactoryCredentials(deps.credentials, deps.orgScopeId, {
    slack: factorySlackChannel(config) !== undefined,
  });
  if (!credentials.ok) throw new Error(`factory_credentials_missing: ${credentials.missing.join(", ")}`);
  return {
    config,
    linearApiKey: credentials.linearApiKey,
    githubToken: credentials.githubToken,
    anthropicApiKey: credentials.anthropicApiKey,
    ...(credentials.slackBotToken !== undefined ? { slackBotToken: credentials.slackBotToken } : {}),
  };
}

export function createFactoryLoopEffects(deps: FactoryEffectsDeps): FactoryWorkEffects {
  const repoDir = deps.repoDir ?? DEFAULT_FACTORY_REPO_DIR;
  const runs = new Map<string, FactoryRun>();

  const provisionWorkspace = (scopeId: ScopeId): Promise<SandboxHandle> =>
    deps.sandbox.provision([{ scopeId, mode: "rw", mountPath: "" }]);

  const teardownWarm = async (handle: SandboxHandle): Promise<void> => {
    await deps.sandbox.teardown(handle, { keepWarm: true }).catch((e: unknown) => swallow("factory teardown", e));
  };

  const artifactsFor = (item: LoopItem, runId: string): CapturedArtifact[] => {
    const run = runs.get(runId);
    if (!run) return [];
    return parseFactoryContract({
      stdout: run.result.stdout,
      sourceKey: item.sourceKey,
      forge: run.config.forge,
      publishProject: run.config.publishProject,
    });
  };

  return {
    async enumerate() {
      const { config, linearApiKey } = await loadFactoryContext(deps);
      return enumerateFactoryCandidates({ teamId: config.linearTeamId, apiKey: linearApiKey, fetch: deps.fetch });
    },

    async work({ loop, item, guidance }) {
      if (!isFactoryTicketId(item.sourceKey)) throw new Error("factory_ticket_invalid");
      const { config, linearApiKey, githubToken, anthropicApiKey, slackBotToken } = await loadFactoryContext(deps);

      const preflightHandle = await provisionWorkspace(loop.ownerScopeId);
      let preflight: PreflightResult;
      try {
        preflight = await preflightFactorySandbox(deps.sandbox, preflightHandle);
        if (preflight.ok) await bootstrapFactorySource(deps.sandbox, preflightHandle, githubToken);
      } finally {
        await teardownWarm(preflightHandle);
      }
      if (!preflight.ok) throw new Error(`factory_preflight_failed: ${preflightDetail(preflight)}`);

      const channel = factorySlackChannel(config);
      const slack =
        channel && slackBotToken
          ? await openFactorySlackThread({
              fetch: deps.fetch,
              botToken: slackBotToken,
              channel,
              ticket: item.sourceKey,
            })
          : undefined;

      const itemKey = `factory:${loop.id}:${item.id}`;
      const itemPrefix = `${itemKey}:`;
      const runId = `${itemPrefix}${item.attempts + 1}`;
      const env = renderFactoryEnv({
        config,
        guidance,
        linearApiKey,
        githubToken,
        anthropicApiKey,
        ...(slack ? { slack } : {}),
        factorySessionId: factorySessionIdFor(itemKey),
        repoDir,
        factorySourceDir: FACTORY_SOURCE_DIR,
      });

      const controller = new AbortController();
      const pausePoll = createSweeper(
        async () => {
          const current = await deps.loops.get(loop.id);
          if (!current || !isRunnable(current)) controller.abort();
        },
        deps.pausePollMs ?? DEFAULT_PAUSE_POLL_MS,
        { label: "factory pause poll" },
      );
      pausePoll.start();

      let result: FactoryProcessResult;
      try {
        result = await runFactoryProcess({
          sandbox: deps.sandbox,
          scopeId: loop.ownerScopeId,
          repoDir,
          factorySourceDir: FACTORY_SOURCE_DIR,
          ticketId: item.sourceKey,
          env,
          signal: controller.signal,
          onChunk: () => {},
        });
      } finally {
        pausePoll.stop();
      }
      if (result.aborted) throw new Error("factory_run_aborted");

      for (const key of runs.keys()) if (key.startsWith(itemPrefix)) runs.delete(key);
      runs.set(runId, { result, config, redact: redactor([linearApiKey, githubToken, anthropicApiKey]) });
      return { runId };
    },

    async captureOutputs({ item, runId }) {
      return artifactsFor(item, runId);
    },

    async evaluate({ item, runId }) {
      try {
        const artifacts = artifactsFor(item, runId);
        if (artifacts.some((artifact) => artifact.shipAction === "close_already_fixed"))
          return { outcome: "met", reason: "already fixed", checks: [], judged: false };
        const run = runs.get(runId);
        if (!run) return noPrVerdict();
        const target = prTarget(artifacts, run.config);
        if (!target) return noPrVerdict(run);
        const { githubToken } = await loadFactoryContext(deps);
        return await evaluateFactoryForge({
          fetch: deps.fetch,
          forge: run.config.forge,
          publishProject: run.config.publishProject,
          bugbotRequired: run.config.bugbotRequired,
          forgeToken: githubToken,
          number: target.ref.number,
          branch: target.branch,
        });
      } finally {
        runs.delete(runId);
      }
    },
  };
}
