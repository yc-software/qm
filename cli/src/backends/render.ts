import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appPrefixOf, isDigestPinned, renderPlanId, updateConfigUrls, type QmConfig } from "../config.ts";
import {
  deploymentLayerRequest,
  httpDeploymentLayerTransport,
  syncDeploymentLayer,
  type DeploymentLayerTransport,
} from "../deployment-layer.ts";
import { CliError, errMessage, note, ok, step } from "../log.ts";
import { isPlaceholderRef } from "../manifest.ts";
import type { ResolvedPlugin } from "../plugins.ts";
import {
  list,
  RenderApiError,
  renderClient,
  requestArray,
  streamRenderLogs,
  type RenderLog,
  type RenderRequest,
  type RenderService,
  type ServiceType,
} from "../render-api.ts";
import { bindUrl, customDomains, httpsOrigin, publicUrl, renderInternalUrl, verifiedUrl } from "../render-domains.ts";
import {
  renderMinioEnv,
  renderMinioInitCommand,
  renderMinioSecretNames,
  renderMinioWorkload,
} from "../render-minio.ts";
import {
  renderManagedCoreEnv,
  renderServiceEnv,
  renderStorageEnv,
  renderWorkloads,
  type RenderWorkload,
} from "../render-services.ts";
import {
  coordinates,
  createResource,
  describeRelease,
  locked,
  readState,
  recordRelease,
  recoverPendingCreate,
  resolveRollbackTarget,
  saveState,
  statePath,
  type State,
} from "../render-state.ts";
import {
  computedSecrets,
  FIRST_PARTY_SECRET_SPECS,
  managedByFor,
  missingRequiredSecrets,
  runtimeSecretNames,
} from "../secrets.ts";
import { githubRepoUrl } from "../render-source.ts";
import { runnableServices, serviceDef, serviceHost } from "../services.ts";
import { capture, deploymentSecretValue, isInvalidSecret, sleep } from "../util.ts";
import { doctorCommon, localDoctorSecrets } from "./doctor.ts";
import type { DeployContext } from "./registry.ts";
import type { Backend } from "./types.ts";

function layerTransport(originOf: (config: QmConfig) => string): DeploymentLayerTransport {
  return httpDeploymentLayerTransport({
    timeoutMs: 60_000,
    urlOf: (config) => new URL("/v1/deployment-layer", originOf(config)),
  });
}
export const renderDeploymentLayerTransport = layerTransport((config) => {
  if (!config.apiUrl) throw new CliError("Render requires apiUrl; qm init --target render sets it");
  const origin = httpsOrigin(config.apiUrl);
  if (!origin) throw new CliError("Render deployment-layer URL must be an HTTPS origin");
  return origin;
});

interface RenderPostgres {
  id: string;
  name: string;
  owner: { id: string };
  environmentId: string;
  region: string;
  status: string;
  suspended: string;
  plan: string;
  diskSizeGB: number;
}
interface RenderJob {
  id: string;
  serviceId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
}
interface RenderDeploy {
  id: string;
  status: string;
  commit?: { id: string };
}
const bootstrapCommand = "/bin/sh -c exit 0";
const failedDeployStatuses = ["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"];
interface Project {
  id: string;
  name: string;
  owner: { id: string };
  environmentIds: string[];
}
interface Environment {
  id: string;
  name: string;
  projectId: string;
}
function credentialValues(ctx: DeployContext, envFile = ctx.envFile): Map<string, string> {
  const values = localDoctorSecrets(ctx.configDir, envFile);
  for (const secret of computedSecrets(ctx.config)) {
    if (!secret.required && values.get(secret.name)?.trim() === "") {
      values.set(secret.name, "");
      continue;
    }
    const value = deploymentSecretValue(secret.name, values.get(secret.name));
    if (value !== undefined) values.set(secret.name, value);
  }
  return values;
}
function apiKey(ctx: DeployContext, envFile?: string): string {
  const key = credentialValues(ctx, envFile ?? ctx.envFile).get("RENDER_API_KEY");
  if (!key || isInvalidSecret("RENDER_API_KEY", key)) throw new CliError("RENDER_API_KEY is required; run qm setup");
  return key;
}
function api(ctx: DeployContext, envFile?: string): RenderRequest {
  return renderClient(apiKey(ctx, envFile));
}
function requireSecrets(ctx: DeployContext, values: ReadonlyMap<string, string>): void {
  const missing = missingRequiredSecrets(
    computedSecrets(ctx.config).filter((secret) => secret.managedBy === "operator"),
    (name) => values.get(name),
  );
  if (missing.length) throw new CliError(`Required secrets are missing: ${missing.join(", ")}; run qm setup`);
  step("required operator secret values: ok");
}
async function envVars(request: RenderRequest, id: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await list<{ key: string; value: string }>(request, `/services/${id}/env-vars`, "envVar")).map((item) => [
      item.key,
      item.value,
    ]),
  );
}
function pairs(values: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
}
function same(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(pairs(a)) === JSON.stringify(pairs(b));
}
function workloads(ctx: DeployContext): RenderWorkload[] {
  const render = coordinates(ctx.config);
  const out: RenderWorkload[] = [renderMinioWorkload(render)];
  for (const item of renderWorkloads(ctx.config, ctx.configDir)) {
    const privateService = !!item.plugin || (item.name === "web-ui" && ctx.config.services.includes("portal"));
    const type: ServiceType = privateService ? "private_service" : "web_service";
    out.push({
      ...item,
      type,
      plan: item.name === "core" ? render.corePlan : render.servicePlan,
      ...(item.name === "core" ? { command: "node src/render/start.ts" } : {}),
      ...(type === "web_service" ? { health: "/healthz" } : {}),
    });
  }
  return out;
}
async function inventory(ctx: DeployContext, request: RenderRequest, state: State, missing = false) {
  const desired = workloads(ctx);
  let project: Project | undefined;
  if (state.projectId) {
    project = await request<Project>(`/projects/${state.projectId}`);
    if (
      project.owner.id !== state.workspaceId ||
      project.name !== `${state.appPrefix}-qm` ||
      project.id !== state.projectId
    )
      throw new CliError("The saved Render project does not match this deployment");
    if (state.environmentId && !project.environmentIds.includes(state.environmentId))
      throw new CliError("The saved Render environment is no longer in the project");
  } else if (state.environmentId || state.postgresId || Object.keys(state.services).length)
    throw new CliError("The Render resource record has no project binding");
  if (state.environmentId) {
    const environment = await request<Environment>(`/environments/${state.environmentId}`);
    if (environment.projectId !== state.projectId || environment.name !== "production")
      throw new CliError("The saved Render environment does not match this deployment");
  } else if (state.postgresId || Object.keys(state.services).length)
    throw new CliError("The Render resource record has no environment binding");
  const services = new Map<string, RenderService>();
  for (const [component, saved] of Object.entries(state.services)) {
    let service: RenderService;
    try {
      service = await request<RenderService>(`/services/${saved.id}`);
    } catch (error) {
      if (
        (missing || !desired.some((item) => item.name === component)) &&
        error instanceof RenderApiError &&
        error.status === 404
      )
        continue;
      throw error;
    }
    if (
      service.id !== saved.id ||
      service.name !== `${state.appPrefix}-${component}` ||
      saved.name !== service.name ||
      service.type !== saved.type ||
      service.ownerId !== state.workspaceId ||
      service.environmentId !== state.environmentId ||
      service.serviceDetails.region !== state.region
    )
      throw new CliError(
        `Saved Render service ${component} does not match its workspace, environment, name, type, or region`,
      );
    services.set(component, service);
  }
  let postgres: RenderPostgres | undefined;
  if (state.postgresId) {
    try {
      postgres = await request<RenderPostgres>(`/postgres/${state.postgresId}`);
    } catch (error) {
      if (!(missing && error instanceof RenderApiError && error.status === 404)) throw error;
    }
    if (
      postgres &&
      (postgres.id !== state.postgresId ||
        postgres.owner.id !== state.workspaceId ||
        postgres.name !== `${state.appPrefix}-pg` ||
        postgres.environmentId !== state.environmentId ||
        postgres.region !== state.region)
    )
      throw new CliError("The saved Render Postgres does not match this deployment");
  }
  return { services, postgres, environmentIds: project?.environmentIds ?? [] };
}
async function assertAvailable(
  request: RenderRequest,
  path: string,
  key: string,
  name: string,
  ownerId: string,
): Promise<void> {
  const found = await list<{ name: string }>(request, `${path}?${new URLSearchParams({ ownerId, name })}`, key);
  if (found.some((item) => item.name === name))
    throw new CliError(
      `Render ${name} already exists without a saved resource ID. Refusing to adopt it; inspect the resource and restore this deployment's render.resources.json`,
    );
}
async function poll(
  label: string,
  check: () => Promise<boolean>,
  lastResult?: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + 20 * 60_000;
  let nextUpdate = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new CliError(
        `${label} did not become ready in 20 minutes${lastResult?.() ? ` (last result: ${lastResult()})` : ""}; use qm status and qm logs`,
      );
    if (Date.now() >= nextUpdate) {
      step(`waiting for ${label}`);
      nextUpdate = Date.now() + 30_000;
    }
    await sleep(3_000);
  }
}
async function latestDeploy(request: RenderRequest, service: RenderService): Promise<RenderDeploy | undefined> {
  return (await requestArray<{ deploy: RenderDeploy }>(request, `/services/${service.id}/deploys?limit=1`))[0]?.deploy;
}
async function waitDeploy(
  request: RenderRequest,
  service: RenderService,
  id?: string,
  previousId?: string,
  expectedCommit?: string,
): Promise<void> {
  let lastStatus: string | undefined;
  await poll(
    service.name,
    async () => {
      const deploy = id
        ? await request<RenderDeploy>(`/services/${service.id}/deploys/${id}`)
        : await latestDeploy(request, service);
      if (!deploy || deploy.id === previousId) return false;
      id = deploy.id;
      lastStatus = deploy.status;
      if (failedDeployStatuses.includes(deploy.status))
        throw new CliError(
          `${service.name} deploy ${deploy.id} ended with ${deploy.status}; fix the error and run qm up again`,
        );
      if (deploy.status === "live" && expectedCommit && deploy.commit?.id !== expectedCommit)
        throw new CliError(
          `${service.name} deployed commit ${deploy.commit?.id ?? "unknown"}, expected ${expectedCommit}`,
        );
      return deploy.status === "live";
    },
    () => lastStatus,
  );
  ok(`${service.name}: live`);
}
async function prepareBootstrap(
  request: RenderRequest,
  workload: RenderWorkload,
  service: RenderService,
): Promise<RenderService> {
  if (service.suspended !== "suspended") return service;
  const before = (await latestDeploy(request, service))?.id;
  await request(`/services/${service.id}`, "PATCH", serviceSpec(workload, bootstrapCommand));
  await request(`/services/${service.id}/resume`, "POST");
  await poll(`${service.name} resume`, async () => (await latestDeploy(request, service))?.id !== before);
  return request<RenderService>(`/services/${service.id}`);
}
async function deploy(request: RenderRequest, service: RenderService, commit: string): Promise<void> {
  if (service.suspended === "suspended") throw new CliError(`${service.name} must be resumed before deployment`);
  const history = await list<RenderDeploy>(request, `/services/${service.id}/deploys`, "deploy");
  let pending = history.filter((item) => item.status !== "live" && !failedDeployStatuses.includes(item.status));
  for (const active of pending) await request(`/services/${service.id}/deploys/${active.id}/cancel`, "POST");
  await poll(`${service.name} previous deploys`, async () => {
    pending = await Promise.all(
      pending.map((item) => request<RenderDeploy>(`/services/${service.id}/deploys/${item.id}`)),
    );
    pending = pending.filter((item) => item.status !== "live" && !failedDeployStatuses.includes(item.status));
    return pending.length === 0;
  });
  const previousId = (await latestDeploy(request, service))?.id;
  const result = await request<{ id: string } | undefined>(`/services/${service.id}/deploys`, "POST", {
    clearCache: "do_not_clear",
    commitId: commit,
  });
  await waitDeploy(request, service, result?.id, previousId, commit);
}

async function runJob(
  request: RenderRequest,
  service: RenderService,
  workspaceId: string,
  startCommand: string,
  label: string,
  report: boolean,
): Promise<void> {
  const job = await request<RenderJob>(`/services/${service.id}/jobs`, "POST", { startCommand });
  if (!/^job-[a-z0-9]+$/.test(job.id) || job.serviceId !== service.id)
    throw new CliError(`Render returned an invalid ${label} job for ${service.id}; inspect its jobs before retrying`);
  if (report) step(`${service.name}: ${label} job ${job.id}`);
  const path = `/services/${service.id}/jobs/${job.id}`;
  const deadline = Date.now() + 20 * 60_000;
  let current = job;
  try {
    for (;;) {
      if (Date.now() >= deadline) throw new CliError("did not finish within 20 minutes");
      const received = await request<RenderJob>(path);
      if (received.id !== job.id || received.serviceId !== service.id)
        throw new CliError("Render returned a job from another service");
      current = received;
      if (current.status === "succeeded") {
        if (report) ok(`${service.name}: ${label} passed`);
        return;
      }
      if (current.status !== "pending" && current.status !== "running")
        throw new CliError(`ended with ${current.status}`);
      await sleep(Math.min(3_000, deadline - Date.now()));
    }
  } catch (error) {
    let message = errMessage(error);
    if (current.status !== "succeeded" && current.status !== "failed" && current.status !== "canceled") {
      try {
        await request(`${path}/cancel`, "POST");
      } catch (cancelError) {
        message += `; cancellation failed: ${errMessage(cancelError)}`;
      }
    }
    const logs = new URLSearchParams({ ownerId: workspaceId, resource: job.id, direction: "backward", limit: "100" });
    throw new CliError(`Render ${label} job ${job.id} ${message}. Read its logs: GET /v1/logs?${logs}`);
  }
}
async function liveSession(
  request: RenderRequest,
  core: RenderService,
  workspaceId: string,
  report: boolean,
): Promise<void> {
  await runJob(
    request,
    core,
    workspaceId,
    `timeout -s TERM -k 30 1200 node src/deployment/postdeploy-smoke.ts session ${renderInternalUrl(core)}`,
    "live session",
    report,
  );
}
async function provision(
  ctx: DeployContext,
  request: RenderRequest,
  state: State,
  existing: RenderPostgres | undefined,
): Promise<RenderPostgres> {
  const render = coordinates(ctx.config);
  if (!state.projectId) {
    const name = `${state.appPrefix}-qm`;
    await assertAvailable(request, "/projects", "project", name, state.workspaceId);
    const project = await createResource<Project>(ctx, request, state, "projects", {
      name,
      ownerId: state.workspaceId,
      environments: [{ name: "production" }],
    });
    state.projectId = project.id;
    saveState(ctx, state);
  }
  if (!state.environmentId) {
    const project = await request<Project>(`/projects/${state.projectId}`);
    const environments = await Promise.all(
      project.environmentIds.map((id) => request<Environment>(`/environments/${id}`)),
    );
    const production = environments.filter((item) => item.name === "production" && item.projectId === state.projectId);
    if (production.length !== 1) throw new CliError("The Render project must contain one production environment");
    state.environmentId = production[0]!.id;
    saveState(ctx, state);
  }
  if (!state.postgresId) {
    const name = `${state.appPrefix}-pg`;
    await assertAvailable(request, "/postgres", "postgres", name, state.workspaceId);
    const postgres = await createResource<RenderPostgres>(ctx, request, state, "postgres", {
      name,
      ownerId: state.workspaceId,
      environmentId: state.environmentId,
      region: state.region,
      plan: render.postgresPlan,
      version: "18",
      diskSizeGB: render.postgresDiskSizeGB,
      ipAllowList: [],
    });
    state.postgresId = postgres.id;
    saveState(ctx, state);
  }
  let postgres = existing ?? (await request<RenderPostgres>(`/postgres/${state.postgresId}`));
  if (postgres.diskSizeGB > render.postgresDiskSizeGB)
    throw new CliError("Render Postgres storage cannot shrink; keep postgresDiskSizeGB at its current size or larger");
  if (postgres.suspended === "suspended") await request(`/postgres/${postgres.id}/resume`, "POST");
  if (postgres.plan !== render.postgresPlan || postgres.diskSizeGB !== render.postgresDiskSizeGB)
    await request(`/postgres/${postgres.id}`, "PATCH", {
      plan: render.postgresPlan,
      diskSizeGB: render.postgresDiskSizeGB,
    });
  await poll(
    "Render Postgres",
    async () => {
      postgres = await request<RenderPostgres>(`/postgres/${state.postgresId}`);
      if (postgres.status === "recovery_failed") throw new CliError("Render Postgres recovery failed");
      return postgres.status === "available";
    },
    () => postgres.status,
  );
  return postgres;
}
interface Connections {
  databaseUrl: string;
  commit: string;
  storage?: { endpoint: string; secretKey: string };
}
function serviceEnv(
  ctx: DeployContext,
  workload: RenderWorkload,
  values: ReadonlyMap<string, string>,
  connections: Connections,
  state: State,
  services: Map<string, RenderService>,
  existing: Record<string, string>,
): Record<string, string> {
  if (workload.name === "minio") return renderMinioEnv(ctx.config.publicUrl, existing, !!state.services.minio);
  const resolved = new Map(values);
  for (const secret of computedSecrets(ctx.config)) {
    if (secret.managedBy !== "operator" || resolved.has(secret.name)) continue;
    const names = runtimeSecretNames(
      workload.name,
      secret,
      ctx.config.plugins.filter((item) => item.coreAccess !== false).map((item) => item.name),
    );
    const stored = names.map((name) => existing[name]).find((value) => value !== undefined);
    if (stored !== undefined) resolved.set(secret.name, stored);
  }
  const core = services.get("core");
  const web = services.get("web-ui");
  return renderServiceEnv(
    ctx.config,
    workload.name,
    resolved,
    {
      ...connections,
      coreUrl: core ? renderInternalUrl(core) : "http://127.0.0.1:8080",
      ...(web ? { webUiUrl: web.type === "private_service" ? renderInternalUrl(web) : publicUrl(web) } : {}),
      projectId: state.projectId,
      environmentId: state.environmentId,
      minioServiceId: state.services.minio?.id,
    },
    workload.plugin,
  );
}
function serviceSpec(workload: RenderWorkload, dockerCommand = workload.command ?? "") {
  return {
    autoDeploy: "no",
    repo: workload.source.repo,
    branch: workload.source.branch,
    rootDir: "",
    serviceDetails: {
      runtime: "docker",
      plan: workload.plan,
      envSpecificDetails: { dockerCommand, dockerfilePath: workload.dockerfile, dockerContext: "." },
      ...(workload.health ? { healthCheckPath: workload.health } : {}),
      ...(!workload.diskSizeGB ? { maxShutdownDelaySeconds: 300 } : {}),
    },
  };
}

async function reconcileService(
  request: RenderRequest,
  state: State,
  workload: RenderWorkload,
  service: RenderService,
  env: Record<string, string>,
  existing: Record<string, string>,
): Promise<boolean> {
  if (service.type !== workload.type)
    throw new CliError(`${workload.name} changes its Render service type; use a new app prefix for this topology`);
  const details = service.serviceDetails;
  if (details.numInstances !== 1 || (workload.diskSizeGB ? details.disk?.mountPath !== "/data" : !!details.disk))
    throw new CliError(
      `${workload.name} must have one instance ${workload.diskSizeGB ? "with its persistent disk at /data" : "without a disk"}`,
    );
  let changed = false;
  if (workload.diskSizeGB && details.disk) {
    if (details.disk.sizeGB > workload.diskSizeGB)
      throw new CliError("MinIO storage cannot shrink; keep diskSizeGB at its current size or larger");
    if (details.disk.sizeGB !== workload.diskSizeGB) {
      await request(`/disks/${details.disk.id}`, "PATCH", { sizeGB: workload.diskSizeGB });
      changed = true;
    }
  }
  const buildChanged =
    githubRepoUrl(service.repo ?? "")?.toLowerCase() !== workload.source.repo.toLowerCase() ||
    service.branch !== workload.source.branch ||
    !!service.rootDir ||
    details.envSpecificDetails.dockerfilePath !== workload.dockerfile ||
    details.envSpecificDetails.dockerContext !== ".";
  if (
    buildChanged ||
    details.runtime !== "docker" ||
    service.autoDeploy !== "no" ||
    renderPlanId(details.plan) !== workload.plan ||
    (details.envSpecificDetails.dockerCommand ?? "") !== (workload.command ?? "") ||
    (workload.health !== undefined && details.healthCheckPath !== workload.health) ||
    (!workload.diskSizeGB && details.maxShutdownDelaySeconds !== 300)
  ) {
    await request(`/services/${service.id}`, "PATCH", serviceSpec(workload));
    changed = true;
  }
  if (!same(env, existing)) {
    await request(`/services/${service.id}/env-vars`, "PUT", pairs(env));
    changed = true;
  }
  return changed;
}
export function renderConfigErrors(
  config: QmConfig,
  plugins: readonly ResolvedPlugin[],
): Array<{ clause: string; message: string }> {
  const errors: Array<{ clause: string; message: string }> = [];
  const add = (message: string): void => {
    errors.push({ clause: "config.v1", message });
  };
  if (!config.apiUrl) add("Render requires apiUrl; qm init --target render sets it");
  const origins = [config.publicUrl, config.apiUrl].map(httpsOrigin);
  for (const [index, url] of [config.publicUrl, config.apiUrl].entries()) {
    if (url && !origins[index]) add("Render publicUrl and apiUrl must be HTTPS origin URLs on port 443");
  }
  const [web, api] = origins.map((origin) => (origin ? new URL(origin).hostname : undefined));
  if (web && api) {
    if (web === api) add("Render publicUrl and apiUrl must use different hostnames");
    else if (web === `www.${api}` || api === `www.${web}`)
      add(
        "Render publicUrl and apiUrl cannot be an apex domain and its www subdomain; Render pairs them as a redirect",
      );
  }
  if (plugins.some((plugin) => plugin.name === "minio"))
    add("Render plugin minio conflicts with the bundled Render minio service");
  if (!config.services.includes("web-ui")) add("Render hosting requires web-ui");
  for (const service of runnableServices(config.services)) {
    if (serviceDef(service).tcpIngress) add(`Render hosting does not support TCP ingress for ${service}`);
  }
  if (config.services.includes("admin") && !config.services.includes("portal"))
    add("Render admin requires the authenticated portal");
  if (plugins.some((plugin) => plugin.kind === "image")) add("Render plugins require Git source Dockerfiles");
  if (Object.keys(config.imageOverrides).length || config.imageFrom)
    add("Render builds from Git; remove imageOverrides and imageFrom");
  for (const plugin of config.plugins) {
    if (plugin.coreAccess === false && plugin.secrets?.some((secret) => secret.name === "DATABASE_URL"))
      add(`Render plugin ${plugin.name} cannot use the core DATABASE_URL when coreAccess is false`);
  }
  if (config.skills.length) add("Place extra Render deployment skills in sandbox/skills instead of skills[]");
  if (config.vms && Object.keys(config.vms).length)
    add("Use render.corePlan and render.servicePlan instead of vms for Render");
  const managed = config.render ? renderManagedCoreEnv(config.render, config.sandbox?.baseImage) : {};
  if (managed.RENDER_SANDBOX_IMAGE && isPlaceholderRef(managed.RENDER_SANDBOX_IMAGE))
    add(
      "This qm build pins no published sandbox base image; set sandbox.baseImage to <repository>:<commit>@sha256:<digest>",
    );
  const sandbox = config.sandbox ?? {};
  const ignored = (["app", "env", "secretEnv"] as const).filter((key) => sandbox[key] !== undefined);
  if (ignored.length) add(`Render sandboxes ignore ${ignored.map((key) => `sandbox.${key}`).join(", ")}; remove them`);
  const base = sandbox.baseImage;
  if (base) {
    const source = base.slice(0, base.lastIndexOf("@"));
    const colon = source.lastIndexOf(":");
    if (colon <= source.lastIndexOf("/") || colon === source.length - 1 || !isDigestPinned(base))
      add("Render sandbox.baseImage must be <repository>:<tag>@sha256:<64 hex digits>");
  }
  for (const [key, value] of Object.entries(managed)) {
    if (config.env.core?.[key] !== undefined && config.env.core[key] !== value)
      add(`Render requires env.core.${key}=${value}`);
  }
  const derived = FIRST_PARTY_SECRET_SPECS.filter((spec) => managedByFor(spec, "render") === "render").map(
    (spec) => spec.name,
  );
  for (const key of [...Object.keys(managed), ...derived]) {
    if (config.secretEnv?.core?.[key]) add(`Render derives core ${key}; remove its secretEnv entry`);
  }
  for (const key of [
    "RENDER_DEPLOY_REPO",
    "RENDER_DEPLOY_BRANCH",
    "GIT_SHA",
    "RENDER_PROJECT_ID",
    "RENDER_ENVIRONMENT_ID",
    "RENDER_MINIO_SERVICE_ID",
  ]) {
    if (config.env.core?.[key] !== undefined || config.secretEnv?.core?.[key] !== undefined)
      add(`Render derives core ${key}; remove its env or secretEnv entry`);
  }
  for (const key of [...Object.keys(renderStorageEnv()), ...renderMinioSecretNames]) {
    if (config.env.core?.[key] !== undefined || config.secretEnv?.core?.[key] !== undefined)
      add(`Render manages core ${key}; remove its env or secretEnv entry`);
  }

  return errors;
}

export function createRenderBackend(ctx: DeployContext): Backend {
  return {
    up: async (opts) => {
      const desired = workloads(ctx);
      if (opts.dryRun) {
        step(`create or reconcile Render project ${appPrefixOf(ctx.config)}-qm and its production environment`);
        step(`create or reconcile Postgres (${coordinates(ctx.config).postgresPlan})`);
        for (const workload of desired)
          step(
            `${workload.name}: ${workload.type}, ${workload.plan}, ${workload.source.repo} branch ${workload.source.branch}, ${workload.dockerfile}${workload.diskSizeGB ? `, ${workload.diskSizeGB} GB persistent disk` : ""}`,
          );
        step(
          opts.upgradeMinio
            ? "upgrade MinIO to the selected source commit"
            : "retain the selected MinIO source commit; use --upgrade-minio to upgrade it",
        );
        step("set service connections and secrets, deploy changes, and upload the deployment layer");
        return;
      }
      await locked(ctx, async () => {
        const state = readState(ctx, true);
        const source = coordinates(ctx.config).source;
        let remote: string;
        try {
          remote = capture("git", ["ls-remote", "--exit-code", source.repo, `refs/heads/${source.branch}`], {
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          }).trim();
        } catch (error) {
          throw new CliError(`Cannot resolve Render Git branch ${source.branch}: ${errMessage(error)}`);
        }
        const [commit, ref] = remote.split("\t");
        if (!commit || !/^[a-f0-9]{40}$/.test(commit) || ref !== `refs/heads/${source.branch}`)
          throw new CliError("Render Git source did not resolve to one branch commit");
        if (state.pendingPurge)
          throw new CliError("Render cleanup is incomplete; run qm down --purge before deployment");
        if (state.rollbackProgress)
          throw new CliError("Render rollback is incomplete; run qm rollback before deployment");
        const values = credentialValues(ctx);
        requireSecrets(ctx, values);
        await doctorCommon(ctx.config, values, { configDir: ctx.configDir });
        const request = api(ctx);
        await request(`/owners/${state.workspaceId}`);
        await recoverPendingCreate(ctx, request, state, desired);
        const bound = await inventory(ctx, request, state);
        for (const name of Object.keys(state.services))
          if (!desired.some((item) => item.name === name) && !bound.services.has(name)) delete state.services[name];
        saveState(ctx, state);
        const postgres = await provision(ctx, request, state, bound.postgres);
        const info = await request<{ internalConnectionString: string }>(`/postgres/${postgres.id}/connection-info`);
        if (!info.internalConnectionString)
          throw new CliError("Render returned no internal Postgres connection string");
        const connections: Connections = {
          databaseUrl: info.internalConnectionString,
          commit,
        };
        const { services } = bound;
        const envs = new Map<string, Record<string, string>>();
        for (const workload of desired) {
          let service = services.get(workload.name);
          let env = service ? await envVars(request, service.id) : {};
          if (!service) {
            const name = `${state.appPrefix}-${workload.name}`;
            await assertAvailable(request, "/services", "service", name, state.workspaceId);
            env = serviceEnv(ctx, workload, values, connections, state, services, env);
            const spec = serviceSpec(workload, bootstrapCommand);
            const result = await createResource<{ service: RenderService }>(ctx, request, state, "services", {
              ...spec,
              type: workload.type,
              name,
              ownerId: state.workspaceId,
              environmentId: state.environmentId,
              envVars: pairs(env),
              secretFiles: [],
              serviceDetails: {
                ...spec.serviceDetails,
                region: state.region,
                numInstances: 1,
                ...(workload.diskSizeGB
                  ? { disk: { name: "data", mountPath: "/data", sizeGB: workload.diskSizeGB } }
                  : {}),
              },
            });
            service = result.service;
            state.services[workload.name] = { id: service.id, name, type: workload.type };
            if (workload.name === "minio") state.minioSource = { ...workload.source, commit };
            saveState(ctx, state);
            services.set(workload.name, service);
          }
          envs.set(workload.name, env);
          if (workload.name === "minio") {
            if (!env.QM_STORAGE_SECRET_KEY)
              throw new CliError("Saved MinIO has no QM_STORAGE_SECRET_KEY; restore it before deployment");
            connections.storage = { endpoint: publicUrl(service), secretKey: env.QM_STORAGE_SECRET_KEY };
          }
        }
        const coreOrigin = publicUrl(services.get("core")!);
        const urls = {
          apiUrl: await bindUrl(request, services.get("core")!, ctx.config.apiUrl),
          publicUrl: await bindUrl(
            request,
            services.get(ctx.config.services.includes("portal") ? "portal" : "web-ui")!,
            ctx.config.publicUrl,
          ),
        };
        const current = readFileSync(ctx.configPath, "utf8");
        const updated = updateConfigUrls(current, urls);
        if (updated !== current) writeFileSync(ctx.configPath, updated);
        Object.assign(ctx.config, urls);
        state.updateInProgress = true;
        saveState(ctx, state);
        for (const workload of desired) {
          let service = services.get(workload.name)!;
          let serviceCommit = commit;
          if (workload.name === "minio") {
            if (opts.upgradeMinio) {
              state.minioSource = { ...workload.source, commit };
              saveState(ctx, state);
            }
            if (!state.minioSource)
              throw new CliError(
                "MinIO has no saved Git source; restore minioSource in render.resources.json or pass --upgrade-minio",
              );
            serviceCommit = state.minioSource.commit;
            workload.source = { repo: state.minioSource.repo, branch: state.minioSource.branch };
          }
          const existing = envs.get(workload.name)!;
          service = await prepareBootstrap(request, workload, service);
          services.set(workload.name, service);
          const env = serviceEnv(ctx, workload, values, connections, state, services, existing);
          const changed = await reconcileService(
            request,
            state,
            workload,
            service,
            env,
            await envVars(request, service.id),
          );
          const latest = await latestDeploy(request, service);
          if (
            changed ||
            !workload.diskSizeGB ||
            service.suspended === "suspended" ||
            !latest ||
            latest.status !== "live" ||
            latest.commit?.id !== serviceCommit
          )
            await deploy(request, service, serviceCommit);
          else ok(`${service.name}: live`);
          if (workload.name === "minio")
            await runJob(
              request,
              service,
              state.workspaceId,
              renderMinioInitCommand(service.slug),
              "MinIO initialization",
              true,
            );
        }
        let lastProbe: string | undefined;
        await poll(
          "core readiness",
          async () => {
            try {
              const response = await fetch(`${coreOrigin}/healthz`, {
                signal: AbortSignal.timeout(30_000),
                redirect: "error",
              });
              lastProbe = response.ok ? undefined : `HTTP ${response.status}`;
              return response.ok;
            } catch (error) {
              lastProbe = errMessage(error);
              return false;
            }
          },
          () => lastProbe,
        );
        await syncDeploymentLayer({
          config: ctx.config,
          configDir: ctx.configDir,
          sandboxDir: ctx.sandboxDir,
          transport: layerTransport(() => coreOrigin),
          ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
        });
        const release: Record<string, string> = {};
        for (const workload of desired.filter((item) => !item.diskSizeGB)) {
          const service = services.get(workload.name)!;
          const current = await latestDeploy(request, service);
          if (!current || current.status !== "live") throw new CliError(`${workload.name} has no live deployment`);
          release[workload.name] = current.id;
        }
        recordRelease(state, commit, release);
        delete state.updateInProgress;
        saveState(ctx, state);
        const retained = Object.keys(state.services).filter((name) => !desired.some((item) => item.name === name));
        if (retained.length)
          note(
            `Retained services outside the current config: ${retained.join(", ")}. Remove them in Render when their data is no longer needed`,
          );
        note(`QM: ${urls.publicUrl}`);
        note(`Core API: ${urls.apiUrl}`);
      });
    },
    status: async () => {
      const request = api(ctx);
      const state = readState(ctx);
      const bound = await inventory(ctx, request, state, state.pendingPurge);
      note(
        `project: ${state.projectId}, production: ${state.environmentId}${state.pendingPurge ? " (cleanup pending)" : ""}`,
      );
      if (bound.postgres) note(`postgres: ${bound.postgres.status} (${bound.postgres.id})`);
      for (const [name, service] of bound.services) {
        const recent = await latestDeploy(request, service);
        note(
          `${name}: ${service.suspended}, ${recent?.status ?? "no deploy"} (${service.id})${service.serviceDetails.url ? ` ${service.serviceDetails.url}` : ""}`,
        );
      }
      for (const service of bound.services.values()) {
        if (service.type !== "web_service" || service.serviceDetails.disk) continue;
        for (const domain of await customDomains(request, service))
          note(`${service.name}: custom domain ${domain.name} ${domain.verificationStatus}`);
      }
      for (const [index, release] of (state.releases ?? []).entries())
        note(`release ${describeRelease(release)}${index === 0 ? " latest" : ""}`);
    },
    logs: async (service, opts) => {
      const request = api(ctx);
      const state = readState(ctx);
      const bound = await inventory(ctx, request, state);
      const host = service ? serviceHost(service) : undefined;
      const ids = host
        ? [bound.services.get(host)?.id].filter((id): id is string => Boolean(id))
        : [...bound.services.values()].map((item) => item.id);
      if (!ids.length) throw new CliError(`No Render service exists${host ? ` for ${host}` : ""}`);
      const startTime = new Date().toISOString();
      const entries: RenderLog[] = [];
      const count = opts.tail ?? 100;
      const query = new URLSearchParams({
        ownerId: state.workspaceId,
        direction: "backward",
        endTime: startTime,
      });
      for (const id of ids) query.append("resource", id);
      while (entries.length < count) {
        query.set("limit", String(Math.min(count - entries.length, 100)));
        const result = await request<{
          logs: RenderLog[];
          hasMore: boolean;
          nextStartTime: string;
          nextEndTime: string;
        }>(`/logs?${query}`);
        entries.push(...result.logs);
        if (!result.hasMore || entries.length >= count) break;
        if (
          !result.nextStartTime ||
          !result.nextEndTime ||
          (result.nextStartTime === query.get("startTime") && result.nextEndTime === query.get("endTime"))
        )
          throw new CliError("Render log pagination did not advance");
        query.set("startTime", result.nextStartTime);
        query.set("endTime", result.nextEndTime);
      }
      entries.sort(
        (a, b) =>
          Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
          a.timestamp.slice(20, -1).padEnd(9, "0").localeCompare(b.timestamp.slice(20, -1).padEnd(9, "0")),
      );
      const printLog = (log: RenderLog): void => note(`${log.timestamp} ${log.message}`);
      for (const log of entries) printLog(log);
      if (opts.follow) {
        query.delete("limit");
        query.delete("endTime");
        query.set("direction", "forward");
        query.set("startTime", startTime);
        await streamRenderLogs(apiKey(ctx), query, printLog);
      }
    },
    down: async (opts) =>
      locked(ctx, async () => {
        const request = api(ctx);
        const state = readState(ctx);
        await recoverPendingCreate(ctx, request, state, workloads(ctx));
        if (state.pendingPurge && !opts.purge) throw new CliError("Render cleanup is incomplete; run qm down --purge");
        const bound = await inventory(ctx, request, state, !!opts.purge);
        const hosted = await list<RenderService>(
          request,
          `/services?${new URLSearchParams({ ownerId: state.workspaceId })}`,
          "service",
        );
        const owned = new Set(Object.values(state.services).map((service) => service.id));
        const environments = new Set(bound.environmentIds);
        for (const service of hosted) {
          if (
            owned.has(service.id) ||
            service.ownerId !== state.workspaceId ||
            !environments.has(service.environmentId) ||
            !["web_service", "private_service"].includes(service.type) ||
            (!opts.purge && service.suspended === "suspended")
          )
            continue;
          const env = await envVars(request, service.id);
          if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(env.QM_DEPLOYMENT_ID ?? ""))
            throw new CliError(
              opts.purge
                ? "Published apps still use this deployment's object storage and SQLite backups. Back up app data and delete their Render services before qm down --purge"
                : "Published apps still use this deployment. Archive or stop them before qm down",
            );
        }
        if (opts.purge) {
          state.pendingPurge = true;
          saveState(ctx, state);
        }
        const order = Object.entries(state.services).sort(([a], [b]) => Number(a === "minio") - Number(b === "minio"));
        for (const [name, saved] of order) {
          const service = bound.services.get(name);
          if (opts.purge) {
            if (service) await request(`/services/${saved.id}`, "DELETE");
            delete state.services[name];
            saveState(ctx, state);
            ok(`${name}: deleted`);
          } else if (service && service.suspended !== "suspended") {
            await request(`/services/${saved.id}/suspend`, "POST");
            ok(`${name}: suspended`);
          }
        }
        if (opts.purge) {
          if (bound.postgres) await request(`/postgres/${bound.postgres.id}`, "DELETE");
          saveState(ctx, {
            version: 1,
            orgId: state.orgId,
            workspaceId: state.workspaceId,
            region: state.region,
            appPrefix: state.appPrefix,
            projectId: state.projectId,
            environmentId: state.environmentId,
            services: {},
          });
          note(
            "QM services, Postgres, and the MinIO disk are deleted. The project and production environment are retained for future deployment",
          );
        } else note("Postgres, persistent disks, and stored objects are retained. Storage charges continue");
      }),
    rollback: async (to) =>
      locked(ctx, async () => {
        const request = api(ctx);
        const state = readState(ctx);
        if (!state.rollbackProgress || to !== undefined) {
          const target = resolveRollbackTarget(state, to);
          state.rollbackProgress =
            target.mode === "restore"
              ? {
                  mode: "restore",
                  label: target.release.label,
                  commit: target.release.commit,
                  services: target.release.services,
                  restored: {},
                }
              : { mode: "rebuild", commit: target.commit, services: {}, restored: {} };
        }
        const progress = state.rollbackProgress;
        const bound = await inventory(ctx, request, state);
        if (!bound.services.has("core")) throw new CliError("The core service is missing");
        const targets =
          progress.mode === "restore"
            ? Object.keys(progress.services)
            : workloads(ctx)
                .filter((workload) => !workload.diskSizeGB)
                .map((workload) => workload.name);
        for (const name of targets) {
          const service = bound.services.get(name);
          if (!service || service.serviceDetails.disk)
            throw new CliError(`The rollback service ${name} is missing or has a disk`);
        }
        saveState(ctx, state);
        const core = bound.services.get("core")!;
        await request(`/services/${core.id}/env-vars/GIT_SHA`, "PUT", { value: progress.commit });
        for (const name of targets) {
          if (progress.restored[name]) continue;
          const service = bound.services.get(name)!;
          await deploy(request, service, progress.commit);
          const current = await latestDeploy(request, service);
          if (!current || current.status !== "live") throw new CliError(`${name} has no live deployment`);
          progress.restored[name] = current.id;
          saveState(ctx, state);
        }
        const release = recordRelease(state, progress.commit, progress.restored);
        delete state.updateInProgress;
        delete state.rollbackProgress;
        saveState(ctx, state);
        note(
          `${progress.mode === "restore" ? `Release ${progress.label} restored` : `Commit ${progress.commit.slice(0, 7)} built and deployed`} as ${release.label}. Postgres and object data are retained; migrations are not reversed`,
        );
      }),
    doctor: async () => {
      const values = credentialValues(ctx);
      requireSecrets(ctx, values);
      await doctorCommon(ctx.config, values, { configDir: ctx.configDir });
      const render = coordinates(ctx.config);
      const request = api(ctx);
      await request(`/owners/${render.workspaceId}`);
      workloads(ctx);
      if (existsSync(statePath(ctx))) await inventory(ctx, request, readState(ctx));
      ok(`Render workspace: ${render.workspaceId}`);
    },
    secretsPush: async (envFile) =>
      locked(ctx, async () => {
        const request = api(ctx, envFile);
        const state = readState(ctx);
        if (state.pendingPurge) throw new CliError("Render cleanup is incomplete; run qm down --purge");
        const bound = await inventory(ctx, request, state);
        const values = credentialValues(ctx, envFile);
        requireSecrets(ctx, values);
        const plugins = ctx.config.plugins.filter((item) => item.coreAccess !== false).map((item) => item.name);
        for (const workload of renderWorkloads(ctx.config, ctx.configDir)) {
          const service = bound.services.get(workload.name);
          if (!service) throw new CliError(`No Render service exists for ${workload.name}; run qm up`);
          const entries = computedSecrets(ctx.config).flatMap((secret) => {
            const value = values.get(secret.name);
            if (secret.managedBy !== "operator" || value === undefined) return [];
            return runtimeSecretNames(workload.name, secret, plugins).map((key) => [key, value] as const);
          });
          if (!entries.length) continue;
          for (const [key, value] of entries)
            await request(`/services/${service.id}/env-vars/${encodeURIComponent(key)}`, "PUT", { value });
          ok(`${workload.name}: secrets saved`);
        }
        note("Run qm up to deploy the saved secrets");
      }),
    checkLive: async (opts) => {
      const report = opts?.report ?? true;
      const request = api(ctx);
      const state = readState(ctx);
      const bound = await inventory(ctx, request, state);
      const core = bound.services.get("core");
      const web = bound.services.get(ctx.config.services.includes("portal") ? "portal" : "web-ui");
      if (!core || !web) throw new CliError("The Render deployment has no core or web service; run qm up");
      for (const [name, service, configured] of [
        ["core", core, ctx.config.apiUrl],
        ["web", web, ctx.config.publicUrl],
      ] as const) {
        const url = await verifiedUrl(request, service, configured);
        const response = await fetch(`${url}/healthz`, {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
        if (!response.ok) throw new CliError(`${name} health check failed (HTTP ${response.status})`);
        if (report) ok(`${name}: healthy`);
      }
      const layer = await deploymentLayerRequest({
        config: ctx.config,
        configDir: ctx.configDir,
        method: "GET",
        transport: renderDeploymentLayerTransport,
        ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
      });
      if (layer.status !== 200) throw new CliError(`Core deployment layer check failed (HTTP ${layer.status})`);
      if (report) ok("core: signed deployment layer access works");
      await liveSession(request, core, state.workspaceId, report);
    },
  };
}
