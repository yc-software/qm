export const RENDER_SANDBOX_TTL_SEC = 86400;

export function renderSandboxProblem(workspaceStore: string, defaultTimeoutSec = 600): string | undefined {
  if (workspaceStore !== "postgres") return "render requires WORKSPACE_STORE=postgres";
  if (defaultTimeoutSec + 60 >= RENDER_SANDBOX_TTL_SEC)
    return `SANDBOX_TIMEOUT_SEC must stay more than 60 seconds below the ${RENDER_SANDBOX_TTL_SEC} second Render sandbox lifetime`;
  return undefined;
}
