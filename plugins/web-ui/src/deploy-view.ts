interface AppVersionView {
  version: number;
  createdAt: number;
  commit?: string;
  parentCommit?: string;
}

export interface AppView {
  id: string;
  status?: "running" | "stopped" | "archived" | string;
  ownerScopeId?: string;
  createdBy?: string;
  ownerName?: string;
  createdByName?: string;
  createdInScope?: string;
  currentVersion?: number;
  appliedVersion?: number;
  webUrl?: string;
  gitUrl?: string;
  name?: string;
  displayName?: string;
  permission?: "read" | "write";
  embedAncestors?: string[];
  public?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastAccessAt?: number;
  versions?: AppVersionView[];
}

export type AppTab = "yours" | "shared" | "archived";
export type AppSort = "newest" | "name" | "status";
export type AppActionView = "target" | "other" | "list" | "away";
export type AppRefreshResult = "updated" | "failed" | "superseded";

export function appActionView(targetId: string, currentView: string, activeId?: string): AppActionView {
  if (currentView !== "deploys") return "away";
  if (!activeId) return "list";
  return activeId === targetId ? "target" : "other";
}

export function appListRefreshCanRedraw(activeId?: string): boolean {
  return !activeId;
}

export function appCanManage(d: AppView): boolean {
  return d.permission === "write";
}

export function appContextScope(d: AppView): string | undefined {
  return d.createdInScope ?? d.ownerScopeId;
}

export function appInScope(d: AppView, scope: string | null): boolean {
  return !scope || d.createdInScope === scope || d.ownerScopeId === scope;
}

export function appArchiveUndoAvailable(toastApp: AppView): boolean {
  return toastApp.status === "archived";
}

export function appAfterRestore(requested: AppView, response?: AppView, refreshed?: AppView): AppView {
  return refreshed ?? { ...(response ?? requested), status: "running" };
}

export function appListAfterRestoreRefresh(list: AppView[], restored: AppView, result: AppRefreshResult): AppView[] {
  return result === "failed" ? [restored, ...list.filter((item) => item.id !== restored.id)] : list;
}

export function appTitle(d: AppView): string {
  return d.displayName?.trim() || d.name?.trim() || d.id;
}

export function appSlug(d: AppView): string {
  return d.name?.trim() || d.id;
}

export function appLatestAt(d: AppView): number {
  const applied = d.versions?.find((version) => version.version === (d.appliedVersion ?? d.currentVersion));
  return applied?.createdAt ?? d.versions?.at(-1)?.createdAt ?? 0;
}

export function appTab(d: AppView, viewer: string | undefined): AppTab {
  if (d.status === "archived") return "archived";
  if (!viewer) return "shared";
  if (d.ownerScopeId === `personal:${viewer}`) return "yours";
  return !d.ownerScopeId?.startsWith("personal:") && d.createdBy === viewer ? "yours" : "shared";
}

export function appTabEmptyMessage(tab: AppTab): string {
  if (tab === "shared") return "No apps shared with you.";
  if (tab === "archived") return "Nothing archived.";
  return "No apps of your own yet.";
}

export function filterApps(
  publishedApps: AppView[],
  options: { tab: AppTab; scope: string | null; query: string; viewer?: string; sort?: AppSort },
): AppView[] {
  const query = options.query.trim().toLocaleLowerCase();
  return publishedApps
    .filter((d) => appTab(d, options.viewer) === options.tab)
    .filter((d) => appInScope(d, options.scope))
    .filter((d) => {
      if (!query) return true;
      return [appTitle(d), appSlug(d), d.createdBy, d.createdInScope, d.ownerScopeId, d.status].some((value) =>
        value?.toLocaleLowerCase().includes(query),
      );
    })
    .sort((a, b) => {
      if (options.sort === "name") return appTitle(a).localeCompare(appTitle(b));
      if (options.sort === "status")
        return (a.status ?? "unknown").localeCompare(b.status ?? "unknown") || appTitle(a).localeCompare(appTitle(b));
      return appLatestAt(b) - appLatestAt(a) || appTitle(a).localeCompare(appTitle(b));
    });
}

export function friendlyPrincipal(principal: string | undefined): string {
  const local = (principal ?? "").split("@")[0]!.trim();
  if (!local) return "Unknown owner";
  if (local.includes(":")) return "Unknown person";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");
}
