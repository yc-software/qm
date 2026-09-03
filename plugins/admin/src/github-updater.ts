import { errMessage } from "../../chassis/src/errors.ts";

export interface GitHubUpdaterConfig {
  repository: string;
  workflow: string;
  ref: string;
  token: string;
  apiBaseUrl?: string;
}

export interface GitHubUpdateRun {
  state: "queued" | "running" | "succeeded" | "failed";
  detail: string;
  runUrl: string;
}

export class GitHubResponseError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface WorkflowRun {
  display_title?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
}

const RUN_ID = /\/actions\/runs\/(\d+)(?:[/?#]|$)/;

export function githubUpdaterConfig(env: NodeJS.ProcessEnv): GitHubUpdaterConfig | null {
  const repository = env.QM_UPDATE_GITHUB_REPOSITORY?.trim() ?? "";
  const workflow = env.QM_UPDATE_GITHUB_WORKFLOW?.trim() || "qm-update.yml";
  const ref = env.QM_UPDATE_GITHUB_REF?.trim() || "main";
  const token = env.QM_UPDATE_GITHUB_TOKEN?.trim() ?? "";
  if (!repository || !token) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("QM_UPDATE_GITHUB_REPOSITORY must be owner/repository");
  }
  if (!/^[A-Za-z0-9_./-]+\.ya?ml$/.test(workflow) || workflow.includes("..")) {
    throw new Error("QM_UPDATE_GITHUB_WORKFLOW must name a YAML workflow file");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    throw new Error("QM_UPDATE_GITHUB_REF is invalid");
  }
  return {
    repository,
    workflow,
    ref,
    token,
    ...(env.NODE_ENV === "test" && env.QM_UPDATE_GITHUB_API_URL
      ? { apiBaseUrl: env.QM_UPDATE_GITHUB_API_URL.replace(/\/$/, "") }
      : {}),
  };
}

function apiHeaders(config: GitHubUpdaterConfig): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

async function failure(response: Response): Promise<GitHubResponseError> {
  const body = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
  return new GitHubResponseError(response.status, `GitHub returned ${response.status}${body ? `: ${body}` : ""}`);
}

function runState(run: WorkflowRun, runUrl: string): GitHubUpdateRun {
  if (run.status === "completed") {
    const succeeded = run.conclusion === "success";
    return {
      state: succeeded ? "succeeded" : "failed",
      detail: succeeded ? "Update deployed successfully" : `Workflow ${String(run.conclusion ?? "failed")}`,
      runUrl,
    };
  }
  if (run.status === "in_progress") {
    return { state: "running", detail: "Installing and deploying the update", runUrl };
  }
  return { state: "queued", detail: "Waiting for the deployment runner", runUrl };
}

export function createGitHubUpdater(
  config: GitHubUpdaterConfig,
  fetcher: typeof fetch = fetch,
): {
  actionsUrl: string;
  dispatch(input: { id: string; version: string; requestedBy: string }): Promise<GitHubUpdateRun | null>;
  findRun(id: string, runUrl?: string): Promise<GitHubUpdateRun | null>;
} {
  const api = config.apiBaseUrl ?? "https://api.github.com";
  const workflowPath = `/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}`;
  const read = (path: string) =>
    fetcher(`${api}${path}`, { headers: apiHeaders(config), signal: AbortSignal.timeout(5_000) });
  return {
    actionsUrl: `https://github.com/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}`,
    async dispatch(input) {
      const response = await fetcher(`${api}${workflowPath}/dispatches`, {
        method: "POST",
        headers: apiHeaders(config),
        body: JSON.stringify({
          ref: config.ref,
          inputs: { version: input.version, request_id: input.id, requested_by: input.requestedBy },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw await failure(response);
      const responseBody = await response.text();
      if (!responseBody) return null;
      try {
        const body = JSON.parse(responseBody) as { html_url?: unknown };
        const expectedPrefix = `https://github.com/${config.repository}/actions/runs/`;
        if (typeof body.html_url !== "string" || !body.html_url.startsWith(expectedPrefix)) return null;
        return {
          state: "queued",
          detail: "Waiting for the deployment runner",
          runUrl: body.html_url,
        };
      } catch {
        return null;
      }
    },
    async findRun(id, runUrl) {
      try {
        const runId = runUrl ? RUN_ID.exec(runUrl)?.[1] : undefined;
        if (runUrl && runId) {
          const response = await read(`/repos/${config.repository}/actions/runs/${runId}`);
          if (response.status === 404) {
            return { state: "failed", detail: "The deployment workflow run is no longer available", runUrl };
          }
          if (!response.ok) throw await failure(response);
          const run = (await response.json()) as WorkflowRun;
          return runState(run, typeof run.html_url === "string" ? run.html_url : runUrl);
        }
        const response = await read(`${workflowPath}/runs?event=workflow_dispatch&per_page=30`);
        if (!response.ok) throw await failure(response);
        const body = (await response.json()) as { workflow_runs?: WorkflowRun[] };
        const run = body.workflow_runs?.find((candidate) => String(candidate.display_title).includes(`[${id}]`));
        if (!run || typeof run.html_url !== "string") return null;
        return runState(run, run.html_url);
      } catch (error) {
        throw new Error(`could not read the update workflow: ${errMessage(error)}`, { cause: error });
      }
    },
  };
}
