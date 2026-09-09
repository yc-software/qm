import { CapabilityUnsupportedError, supportsProcessSessions, type Sandbox } from "../../sandbox/sandbox.ts";
import type { FactoryConfig } from "../../resolution/config-store.ts";
import type { ScopeId } from "../../types.ts";

export const FACTORY_WRAPPER = ".claude/io-coding-agent-js.sh";
export const FACTORY_READ_WAIT_MS = 5_000;
export const FACTORY_STDOUT_CAP_BYTES = 4 * 1024 * 1024;
export const FACTORY_TERM_GRACE_MS = 30_000;
export const FACTORY_DRAIN_EMPTY_READS = 2;
const FACTORY_READ_MAX_BYTES = 65_536;
const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export interface FactoryEnvInput {
  config: FactoryConfig;
  guidance?: string;
  linearApiKey: string;
  githubToken: string;
  repoDir: string;
}

export function renderFactoryEnv(input: FactoryEnvInput): Record<string, string> {
  const { config, guidance, linearApiKey, githubToken, repoDir } = input;
  return {
    ...(guidance !== undefined ? { IO_FEEDBACK: guidance } : {}),
    IO_LINEAR_API_KEY: linearApiKey,
    IO_GITHUB_TOKEN: githubToken,
    IO_PUBLISH_FORGE: config.forge,
    IO_PUBLISH_PROJECT: config.publishProject,
    IO_PUBLISH_TARGET: config.targetBranch,
    IO_PUBLISH_REMOTE: "origin",
    IO_SOURCE_REMOTE: "origin",
    IO_SOURCE_BASE_REF: `origin/${config.targetBranch}`,
    IO_SOURCE_APP_DIRS: config.sourceAppDirs,
    IO_SOURCE_TEST_RE: config.sourceTestRe,
    IO_VERIFY_TESTS_CMD: config.verifyTestsCmd,
    IO_VERIFY_TEST_FILE_CMD: config.verifyTestFileCmd,
    IO_VERIFY_LINT_CMD: config.verifyLintCmd,
    IO_REPO_DIR: repoDir,
    IO_FACTORY_SOURCE_DIR: repoDir,
    IO_REPO_CLONE_URL: config.repoCloneUrl,
    ...(config.repoSetupCmd !== undefined ? { IO_REPO_SETUP_CMD: config.repoSetupCmd } : {}),
    ...(config.proofStartCmd !== undefined ? { IO_PROOF_START_CMD: config.proofStartCmd } : {}),
    ...(config.proofBaseUrlCmd !== undefined ? { IO_PROOF_BASE_URL_CMD: config.proofBaseUrlCmd } : {}),
    IO_BUGBOT_REQUIRED: String(config.bugbotRequired),
    IO_FOLLOWUPS_ENABLED: String(config.followupsEnabled),
    IO_FOLLOWUP_TEAM_ID: config.linearTeamId,
  };
}

export interface FactoryProcessInput {
  sandbox: Sandbox;
  scopeId: ScopeId;
  repoDir: string;
  ticketId: string;
  env: Record<string, string>;
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  readWaitMs?: number;
  termGraceMs?: number;
}

export interface FactoryProcessResult {
  processId: string;
  exitCode: number;
  stdout: string;
  truncated: boolean;
  aborted: boolean;
}

export async function runFactoryProcess(input: FactoryProcessInput): Promise<FactoryProcessResult> {
  const { scopeId, repoDir, ticketId, env, onChunk, signal } = input;
  if (!TICKET_RE.test(ticketId)) throw new Error("factory_ticket_invalid");
  const sandbox = input.sandbox;
  if (!supportsProcessSessions(sandbox)) {
    throw new CapabilityUnsupportedError(sandbox.profile.backend, "process sessions");
  }

  const waitMs = input.readWaitMs ?? FACTORY_READ_WAIT_MS;
  const grace = input.termGraceMs ?? FACTORY_TERM_GRACE_MS;
  const handle = await sandbox.provision([{ scopeId, mode: "rw", mountPath: "" }]);
  try {
    const { processId } = await sandbox.startProcess(handle, `bash ${FACTORY_WRAPPER} ${ticketId}`, {
      cwd: repoDir,
      env,
    });
    try {
      let cursor = 0;
      let stdout = "";
      let truncated = false;
      let exited = false;
      let exitCode = 0;
      let termSent = false;
      let killSent = false;
      let killAt = 0;
      let emptyExitedReads = 0;
      for (;;) {
        const read = await sandbox.readProcess(handle, processId, {
          sinceCursor: cursor,
          maxBytes: FACTORY_READ_MAX_BYTES,
          waitMs,
        });
        cursor = read.cursor;
        if (read.chunks !== "") {
          stdout += read.chunks;
          if (stdout.length > FACTORY_STDOUT_CAP_BYTES) {
            stdout = stdout.slice(-FACTORY_STDOUT_CAP_BYTES);
            truncated = true;
          }
          onChunk?.(read.chunks);
        }
        if (read.status.state === "exited") {
          exited = true;
          exitCode = read.status.code;
        }
        emptyExitedReads = exited && read.chunks === "" ? emptyExitedReads + 1 : 0;
        if (emptyExitedReads >= FACTORY_DRAIN_EMPTY_READS) break;
        if (signal?.aborted && !termSent) {
          await sandbox.signalProcess(handle, processId, "TERM");
          termSent = true;
          killAt = Date.now() + grace;
        } else if (termSent && !killSent && read.status.state === "running" && Date.now() >= killAt) {
          await sandbox.signalProcess(handle, processId, "KILL");
          killSent = true;
        }
      }
      return { processId, exitCode, stdout, truncated, aborted: termSent };
    } catch (e) {
      await sandbox.signalProcess(handle, processId, "TERM").catch(() => {});
      throw e;
    }
  } finally {
    await sandbox.teardown(handle, { keepWarm: true }).catch(() => {});
  }
}
