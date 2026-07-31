interface DeploymentVersionView {
  version: number;
  createdAt: number;
  commit?: string;
  parentCommit?: string;
}

export interface DeploymentView {
  id: string;
  status?: "running" | "stopped" | "archived" | string;
  ownerScopeId?: string;
  createdBy?: string;
  createdInScope?: string;
  currentVersion?: number;
  appliedVersion?: number;
  webUrl?: string;
  gitUrl?: string;
  name?: string;
  displayName?: string;
  permission?: "read" | "write";
  createdAt?: number;
  updatedAt?: number;
  lastAccessAt?: number;
  versions?: DeploymentVersionView[];
}

export type DeploymentTab = "yours" | "shared" | "archived";
export type DeploymentSort = "newest" | "name" | "status";
export type DeploymentActionView = "target" | "other" | "list" | "away";
export type DeploymentRefreshResult = "updated" | "failed" | "superseded";

export function deploymentActionView(targetId: string, currentView: string, activeId?: string): DeploymentActionView {
  if (currentView !== "deploys") return "away";
  if (!activeId) return "list";
  return activeId === targetId ? "target" : "other";
}

export function deploymentListRefreshCanRedraw(activeId?: string): boolean {
  return !activeId;
}

export function deploymentCanManage(d: DeploymentView): boolean {
  return d.permission === "write";
}

export function deploymentContextScope(d: DeploymentView): string | undefined {
  return d.createdInScope ?? d.ownerScopeId;
}

export function deploymentInScope(d: DeploymentView, scope: string | null): boolean {
  return !scope || d.createdInScope === scope || d.ownerScopeId === scope;
}

export function deploymentArchiveUndoAvailable(toastDeployment: DeploymentView): boolean {
  return toastDeployment.status === "archived";
}

export function deploymentAfterRestore(
  requested: DeploymentView,
  response?: DeploymentView,
  refreshed?: DeploymentView,
): DeploymentView {
  return refreshed ?? { ...(response ?? requested), status: "running" };
}

export function deploymentListAfterRestoreRefresh(
  list: DeploymentView[],
  restored: DeploymentView,
  result: DeploymentRefreshResult,
): DeploymentView[] {
  return result === "failed" ? [restored, ...list.filter((item) => item.id !== restored.id)] : list;
}

export function deploymentTitle(d: DeploymentView): string {
  return d.displayName?.trim() || d.name?.trim() || d.id;
}

export function deploymentSlug(d: DeploymentView): string {
  return d.name?.trim() || d.id;
}

export function deploymentLatestAt(d: DeploymentView): number {
  const applied = d.versions?.find((version) => version.version === (d.appliedVersion ?? d.currentVersion));
  return applied?.createdAt ?? d.versions?.at(-1)?.createdAt ?? 0;
}

export function deploymentTab(d: DeploymentView, viewer: string | undefined): DeploymentTab {
  if (d.status === "archived") return "archived";
  if (!viewer) return "shared";
  if (d.ownerScopeId === `personal:${viewer}`) return "yours";
  return !d.ownerScopeId?.startsWith("personal:") && d.createdBy === viewer ? "yours" : "shared";
}

export function deploymentTabEmptyMessage(tab: DeploymentTab): string {
  if (tab === "shared") return "No apps shared with you.";
  if (tab === "archived") return "Nothing archived.";
  return "No apps of your own yet.";
}

export function filterDeployments(
  deployments: DeploymentView[],
  options: { tab: DeploymentTab; scope: string | null; query: string; viewer?: string; sort?: DeploymentSort },
): DeploymentView[] {
  const query = options.query.trim().toLocaleLowerCase();
  return deployments
    .filter((d) => deploymentTab(d, options.viewer) === options.tab)
    .filter((d) => deploymentInScope(d, options.scope))
    .filter((d) => {
      if (!query) return true;
      return [deploymentTitle(d), deploymentSlug(d), d.createdBy, d.createdInScope, d.ownerScopeId, d.status].some(
        (value) => value?.toLocaleLowerCase().includes(query),
      );
    })
    .sort((a, b) => {
      if (options.sort === "name") return deploymentTitle(a).localeCompare(deploymentTitle(b));
      if (options.sort === "status")
        return (
          (a.status ?? "unknown").localeCompare(b.status ?? "unknown") ||
          deploymentTitle(a).localeCompare(deploymentTitle(b))
        );
      return deploymentLatestAt(b) - deploymentLatestAt(a) || deploymentTitle(a).localeCompare(deploymentTitle(b));
    });
}

export function friendlyPrincipal(principal: string | undefined): string {
  const local = (principal ?? "").split("@")[0]!.trim();
  if (!local) return "Unknown owner";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");
}
