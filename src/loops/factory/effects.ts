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
import { swallow } from "../../util/errors.ts";
import { shq } from "../../util/shell.ts";
import { awaitProcessExit } from "../../sandbox/await-process-exit.ts";
import { enumerateFactoryCandidates } from "./linear-intake.ts";
import { readFactoryCredentials } from "./credentials.ts";
import { preflightFactorySandbox, type PreflightResult } from "./preflight.ts";
import { renderFactoryEnv, runFactoryProcess, type FactoryProcessResult } from "./process-work.ts";
import { parseFactoryContract } from "./contract.ts";
import { evaluateFactoryForge } from "./forge-evaluate.ts";
import type { ForgeRef } from "./ship.ts";

const DEFAULT_FACTORY_REPO_DIR = "/workspace/repo";
const DEFAULT_PAUSE_POLL_MS = 30_000;

const FACTORY_SOURCE_CLONE_DIR = "/workspace/qm-yc";
const FACTORY_SOURCE_CLONE_URL = "https://github.com/yc-software/qm-yc.git";
const FACTORY_SOURCE_BOOTSTRAP_TIMEOUT_MS = 300_000;

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
}

export type FactoryWorkEffects = Pick<LoopRunnerEffects, "enumerate" | "work" | "captureOutputs" | "evaluate">;

interface FactoryRun {
  result: FactoryProcessResult;
  config: FactoryConfig;
}

const preflightDetail = (result: Extract<PreflightResult, { ok: false }>): string =>
  result.reason === "missing_tools" ? `missing_tools: ${result.missing.join(", ")}` : result.reason;

const noPrVerdict = (): SuccessVerdict => ({
  outcome: "continue",
  reason: "no pull request",
  checks: [],
  judged: false,
});

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
  const status = await awaitProcessExit(sandbox, handle, processId, FACTORY_SOURCE_BOOTSTRAP_TIMEOUT_MS);
  if (status.state !== "exited") {
    await sandbox.signalProcess(handle, processId, "TERM").catch((e: unknown) => swallow("factory bootstrap term", e));
    throw new Error("factory_source_bootstrap_failed: timeout");
  }
  if (status.code !== 0) throw new Error(`factory_source_bootstrap_failed: exit ${status.code}`);
}

export async function loadFactoryContext(deps: FactoryEffectsDeps): Promise<FactoryContext> {
  const config = deps.config.getFactoryConfig();
  if (!config) throw new Error("factory_config_missing");
  const credentials = await readFactoryCredentials(deps.credentials, deps.orgScopeId);
  if (!credentials.ok) throw new Error(`factory_credentials_missing: ${credentials.missing.join(", ")}`);
  return { config, linearApiKey: credentials.linearApiKey, githubToken: credentials.githubToken };
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
      const { config, linearApiKey, githubToken } = await loadFactoryContext(deps);

      const preflightHandle = await provisionWorkspace(loop.ownerScopeId);
      let preflight: PreflightResult;
      try {
        preflight = await preflightFactorySandbox(deps.sandbox, preflightHandle);
        if (preflight.ok) await bootstrapFactorySource(deps.sandbox, preflightHandle, githubToken);
      } finally {
        await teardownWarm(preflightHandle);
      }
      if (!preflight.ok) throw new Error(`factory_preflight_failed: ${preflightDetail(preflight)}`);

      const env = renderFactoryEnv({
        config,
        guidance,
        linearApiKey,
        githubToken,
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

      const itemPrefix = `factory:${loop.id}:${item.id}:`;
      for (const key of runs.keys()) if (key.startsWith(itemPrefix)) runs.delete(key);
      const runId = `${itemPrefix}${item.attempts + 1}`;
      runs.set(runId, { result, config });
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
        if (!target) return noPrVerdict();
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
