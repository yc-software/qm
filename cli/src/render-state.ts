import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployContext } from "./backends/registry.ts";
import { appPrefixOf, type QmConfig, type RenderConfig } from "./config.ts";
import { CliError } from "./log.ts";
import { list, RenderApiError, type RenderRequest, type ServiceType } from "./render-api.ts";
import { withDeploymentLock } from "./state.ts";

type Collection = "projects" | "postgres" | "services";
export interface State {
  version: 1;
  orgId: string;
  workspaceId: string;
  region: string;
  appPrefix: string;
  projectId?: string;
  environmentId?: string;
  postgresId?: string;
  minioSource?: { repo: string; branch: string; commit: string };
  services: Record<string, { id: string; name: string; type: ServiceType }>;
  pendingPurge?: boolean;
  pendingCreate?: { collection: Collection; name: string };
  releases?: Release[];
  releaseCount?: number;
  updateInProgress?: boolean;
  rollbackProgress?: RollbackProgress;
}
interface Release {
  label: string;
  commit: string;
  createdAt: string;
  services: Record<string, string>;
}
interface RollbackProgress {
  mode: "restore" | "rebuild";
  label?: string;
  commit: string;
  services: Record<string, string>;
  restored: Record<string, string>;
}
export function recordRelease(state: State, commit: string, services: Record<string, string>): Release {
  state.releaseCount = (state.releaseCount ?? 0) + 1;
  const release: Release = { label: `r${state.releaseCount}`, commit, createdAt: new Date().toISOString(), services };
  state.releases = [release, ...(state.releases ?? [])];
  return release;
}
export function describeRelease(release: Release): string {
  return `${release.label} (${release.commit.slice(0, 7)}, ${release.createdAt})`;
}
type RollbackTarget = { mode: "restore"; release: Release } | { mode: "rebuild"; commit: string };
export function resolveRollbackTarget(state: State, to: string | undefined): RollbackTarget {
  const releases = state.releases ?? [];
  const retained = releases.length
    ? `Retained releases: ${releases.map(describeRelease).join(", ")}`
    : "No release is retained";
  if (to === undefined) {
    const release = releases[state.updateInProgress === true ? 0 : 1];
    if (!release || !Object.keys(release.services).length)
      throw new CliError(`No previous Render release is recorded for rollback. ${retained}`);
    return { mode: "restore", release };
  }
  const value = to.trim();
  const byLabel = releases.find((release) => release.label === value);
  if (byLabel) return { mode: "restore", release: byLabel };
  if (/^dep-[a-z0-9]+$/.test(value)) {
    const byDeploy = releases.find((release) => Object.values(release.services).includes(value));
    if (byDeploy) return { mode: "restore", release: byDeploy };
    throw new CliError(`No retained Render release contains deploy ${value}. ${retained}`);
  }
  if (/^[0-9a-f]{7,40}$/i.test(value)) {
    const commit = value.toLowerCase();
    const matches = releases.filter((release) => release.commit.startsWith(commit));
    if (matches.length === 1) return { mode: "restore", release: matches[0]! };
    if (matches.length > 1)
      throw new CliError(`Commit ${value} matches several retained releases; use a release label. ${retained}`);
    if (commit.length === 40) return { mode: "rebuild", commit };
    throw new CliError(
      `No retained Render release was built from ${value}; give the full 40-character commit to build it. ${retained}`,
    );
  }
  throw new CliError(`Rollback target ${JSON.stringify(to)} is not a release label, commit, or deploy ID. ${retained}`);
}
export function coordinates(config: QmConfig): RenderConfig {
  if (!config.render || config.render.workspaceId === "tea-replaceme")
    throw new CliError("Set render.workspaceId to your Render workspace ID before deployment");
  return config.render;
}
export function statePath(ctx: DeployContext): string {
  return join(ctx.configDir, "render.resources.json");
}
export function readState(ctx: DeployContext, optional = false): State {
  const render = coordinates(ctx.config);
  if (!existsSync(statePath(ctx))) {
    if (!optional) throw new CliError("No Render resource record exists; run qm up");
    return {
      version: 1,
      orgId: ctx.config.orgId,
      workspaceId: render.workspaceId,
      region: render.region,
      appPrefix: appPrefixOf(ctx.config),
      services: {},
    };
  }
  const state = JSON.parse(readFileSync(statePath(ctx), "utf8")) as State;
  if (state.version !== 1 || !state.services || Array.isArray(state.services))
    throw new CliError("The Render resource record has an unsupported format");
  if (
    state.orgId !== ctx.config.orgId ||
    state.workspaceId !== render.workspaceId ||
    state.region !== render.region ||
    state.appPrefix !== appPrefixOf(ctx.config)
  )
    throw new CliError("render.resources.json belongs to another organization, workspace, region, or app prefix");
  return state;
}
export function saveState(ctx: DeployContext, state: State): void {
  const path = statePath(ctx);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export const locked = <T>(ctx: DeployContext, operation: () => Promise<T>): Promise<T> =>
  withDeploymentLock(join(ctx.configDir, ".render.lock"), operation);
export async function createResource<T>(
  ctx: DeployContext,
  request: RenderRequest,
  state: State,
  collection: Collection,
  body: Record<string, unknown> & { name: string },
): Promise<T> {
  state.pendingCreate = { collection, name: body.name };
  saveState(ctx, state);
  try {
    const created = await request<T>(`/${collection}`, "POST", body);
    delete state.pendingCreate;
    return created;
  } catch (error) {
    if (error instanceof RenderApiError && (error.rejected || error.status === 429)) {
      delete state.pendingCreate;
      saveState(ctx, state);
    }
    throw error;
  }
}
export async function recoverPendingCreate(
  ctx: DeployContext,
  request: RenderRequest,
  state: State,
  desired: ReadonlyArray<{ name: string; type: ServiceType }>,
): Promise<void> {
  if (!state.pendingCreate) return;
  const { collection, name } = state.pendingCreate;
  const component = name.slice(state.appPrefix.length + 1);
  const desiredType = collection === "services" ? desired.find((item) => item.name === component)?.type : undefined;
  const scoped = collection === "postgres" || collection === "services";
  const query = new URLSearchParams({ ownerId: state.workspaceId, name });
  const found = (
    await list<{ id: string; name: string; type: ServiceType; environmentId?: string }>(
      request,
      `/${collection}?${query}`,
      collection === "postgres" ? collection : collection.slice(0, -1),
    )
  ).filter(
    (item) =>
      item.name === name &&
      (!scoped || item.environmentId === state.environmentId) &&
      (desiredType === undefined || item.type === desiredType),
  );
  if (found.length > 1)
    throw new CliError(
      `Render has several resources named ${name}; remove the duplicates and restore render.resources.json`,
    );
  const created = found[0];
  if (!created) throw new CliError(`Render creation of ${name} is unresolved; retry after its outcome is known`);
  if (collection === "projects") state.projectId ??= created.id;
  else if (collection === "postgres") state.postgresId ??= created.id;
  else state.services[component] ??= { id: created.id, name, type: created.type };
  delete state.pendingCreate;
  saveState(ctx, state);
}
