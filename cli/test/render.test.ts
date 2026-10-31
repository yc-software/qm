import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { hostingProvider, type DeployContext } from "../src/backends/registry.ts";
import { renderConfigErrors, renderDeploymentLayerTransport } from "../src/backends/render.ts";
import { loadConfigAt, parseConfigJson } from "../src/config.ts";
import { renderScaffold } from "../src/provider-scaffold.ts";
import { computedSecrets } from "../src/secrets.ts";
import { renderInternalUrl } from "../src/render-domains.ts";
import { renderMinioCommand } from "../src/render-minio.ts";
import { renderClient, streamRenderLogs } from "../src/render-api.ts";
import { runChecks } from "../src/commands/check.ts";

function deployment(t: TestContext, portal = false) {
  const dir = mkdtempSync(join(tmpdir(), "qm-render-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncommit=$(cat '${join(dir, "commit")}' 2>/dev/null || printf '%s' '${"a".repeat(40)}')\nprintf '%s\t%s\n' "$commit" "$4"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const raw = parseConfigJson(
    renderScaffold.renderConfig("acme", "anthropic", "resend", { repo: "https://github.com/acme/qm", branch: "main" }),
  ) as Record<string, any>;
  raw.render.workspaceId = "tea-acme";
  raw.services = portal ? ["core", "web-ui", "portal", "auth", "admin"] : ["core", "web-ui"];
  raw.env = {
    ...(portal ? { auth: { ...raw.env.auth, AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" } } : {}),
    core: { ...raw.env.core },
  };
  delete raw.modelProvider;
  delete raw.secretEnv;
  const configPath = join(dir, "qm.config.jsonc");
  writeFileSync(configPath, JSON.stringify(raw));
  const config = loadConfigAt(configPath).config;
  writeFileSync(
    join(dir, ".env"),
    computedSecrets(config)
      .filter((secret) => secret.managedBy === "operator" && secret.required)
      .map((secret) => `${secret.name}=${"e".repeat(64)}`)
      .join("\n"),
  );
  const ctx: DeployContext = { config, configPath, configDir: dir, sandboxDir: join(dir, "sandbox"), target: "render" };
  return {
    ctx,
    backend: hostingProvider("render").createBackend(ctx),
    saved: () => JSON.parse(readFileSync(join(dir, "render.resources.json"), "utf8")),
    setCommit: (commit: string) => writeFileSync(join(dir, "commit"), commit),
  };
}
type Deployment = ReturnType<typeof deployment>;
interface Service {
  id: string;
  name: string;
  type: string;
  ownerId: string;
  environmentId: string;
  slug: string;
  imagePath?: string;
  repo?: string;
  branch?: string;
  rootDir?: string;
  autoDeploy: string;
  suspended: string;
  serviceDetails: {
    url?: string;
    region: string;
    plan: string;
    runtime: string;
    numInstances: number;
    envSpecificDetails: { dockerCommand: string; dockerfilePath?: string; dockerContext?: string };
    healthCheckPath?: string;
    maxShutdownDelaySeconds?: number;
    disk?: { id: string; name: string; mountPath: string; sizeGB: number };
  };
}
interface Database {
  id: string;
  name: string;
  owner: { id: string };
  environmentId: string;
  region: string;
  plan: string;
  diskSizeGB: number;
  status: string;
  suspended: string;
}
interface Project {
  id: string;
  name: string;
  owner: { id: string };
  environmentIds: string[];
}
interface CustomDomainRecord {
  id: string;
  name: string;
  domainType: "apex" | "subdomain";
  publicSuffix: string;
  verificationStatus: "verified" | "unverified";
  redirectForName: string;
  createdAt: string;
  server: { id: string; name: string };
}
interface Call {
  path: string;
  method: string;
  body: unknown;
  url: URL;
}
function cloud(t: TestContext, d: Deployment) {
  const state = {
    calls: [] as Call[],
    services: new Map<string, Service>(),
    envs: new Map<string, Record<string, string>>(),
    runtimeEnvs: new Map<string, Record<string, string>>(),
    deployEnvs: new Map<string, Record<string, string>>(),
    deploys: new Map<string, { id: string; status: string; commit?: { id: string } }>(),
    deploysById: new Map<string, { id: string; serviceId?: string; status: string; commit?: { id: string } }>(),
    projects: new Map<string, Project>(),
    customDomains: new Map<string, CustomDomainRecord[]>(),
    database: undefined as Database | undefined,
    intercept: undefined as ((call: Call) => Response | undefined | Promise<Response | undefined>) | undefined,
    nextDeployStatus: "live",
    automaticDeployStatus: "build_in_progress",
    nextJobStatus: "succeeded",
    next: 0,
  };
  const empty = () => new Response(null, { status: 204 });
  const missing = () => new Response(null, { status: 404 });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.origin === "https://api.render.com" ? url.pathname.slice(3) : url.pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { path, method, body, url };
    state.calls.push(call);
    const intercepted = await state.intercept?.(call);
    if (intercepted) return intercepted;
    if (url.origin !== "https://api.render.com") {
      if (path === "/healthz") return new Response("ok");
      if (path === "/v1/deployment-layer") {
        assert.ok([state.services.get("srv-acme-core")!.serviceDetails.url, d.ctx.config.apiUrl].includes(url.origin));
        return Response.json({ status: "applied", durable: true, version: 1 });
      }
      throw new Error(`Unexpected application request ${path}`);
    }
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${"e".repeat(64)}`);
    if (path === "/owners/tea-acme") return Response.json({ id: "tea-acme" });
    if (path === "/projects") {
      if (method === "GET")
        return Response.json(
          [...state.projects.values()]
            .filter((item) => !url.searchParams.has("name") || item.name === url.searchParams.get("name"))
            .map((project) => ({ project, cursor: project.id })),
        );
      assert.deepEqual(body, { name: "acme-qm", ownerId: "tea-acme", environments: [{ name: "production" }] });
      assert.deepEqual(d.saved().pendingCreate, { collection: "projects", name: "acme-qm" });
      const project = { id: "prj-acme", name: body.name, owner: { id: body.ownerId }, environmentIds: ["evm-acme"] };
      state.projects.set(project.id, project);
      return Response.json(project);
    }
    if (path === "/projects/prj-acme")
      return state.projects.has("prj-acme") ? Response.json(state.projects.get("prj-acme")) : missing();
    if (path === "/environments/evm-acme")
      return Response.json({ id: "evm-acme", name: "production", projectId: "prj-acme" });
    if (path === "/postgres") {
      if (method === "GET") return Response.json(state.database ? [{ postgres: state.database, cursor: "pg" }] : []);
      assert.equal(body.environmentId, "evm-acme");
      assert.equal(body.ownerId, "tea-acme");
      assert.equal(body.version, "18");
      assert.deepEqual(body.ipAllowList, []);
      state.database = {
        id: "dpg-acme",
        name: body.name,
        owner: { id: body.ownerId },
        environmentId: body.environmentId,
        region: body.region,
        plan: body.plan,
        diskSizeGB: body.diskSizeGB,
        status: "available",
        suspended: "not_suspended",
      };
      return Response.json(state.database);
    }
    if (path === "/postgres/dpg-acme/connection-info")
      return Response.json({
        internalConnectionString: "postgresql://qm:private-password@pg/qm",
      });
    if (path === "/postgres/dpg-acme") {
      if (!state.database) return missing();
      if (method === "DELETE") {
        state.database = undefined;
        return empty();
      }
      if (method === "PATCH") Object.assign(state.database, body);
      return Response.json(state.database);
    }
    if (path === "/services") {
      if (method === "GET")
        return Response.json(
          [...state.services.values()]
            .filter((item) => !url.searchParams.has("name") || item.name === url.searchParams.get("name"))
            .map((service) => ({ service, cursor: service.id })),
        );
      assert.equal(body.environmentId, "evm-acme");
      if (body.repo) {
        assert.equal(body.image, undefined);
        assert.equal(body.serviceDetails.runtime, "docker");
        assert.equal(body.rootDir, "");
        assert.equal(body.serviceDetails.envSpecificDetails.dockerContext, ".");
        assert.match(body.serviceDetails.envSpecificDetails.dockerfilePath, /^(deploy|plugins)\/.+\/Dockerfile$/);
      } else {
        assert.equal(body.image.ownerId, "tea-acme");
        assert.equal(body.serviceDetails.runtime, "image");
      }
      if (body.serviceDetails.disk && body.serviceDetails.maxShutdownDelaySeconds !== undefined)
        return Response.json({ message: "Disk services cannot set maxShutdownDelaySeconds" }, { status: 400 });
      assert.equal(body.autoDeploy, "no");
      assert.ok(d.saved().pendingCreate);
      const id = `srv-${body.name}`;
      const service: Service = {
        ...body,
        id,
        slug: `${body.name}-assigned`,
        imagePath: body.image?.imagePath,
        suspended: "not_suspended",
        serviceDetails: {
          ...body.serviceDetails,
          url:
            body.type === "private_service"
              ? `${body.name}-assigned:10000`
              : `https://${body.name}-assigned.onrender.com`,
          ...(body.serviceDetails.disk ? { disk: { ...body.serviceDetails.disk, id: "dsk-minio" } } : {}),
        },
      };
      state.services.set(id, service);
      state.envs.set(
        id,
        Object.fromEntries(body.envVars.map((env: { key: string; value: string }) => [env.key, env.value])),
      );
      const deploy = {
        id: `dep-${++state.next}`,
        serviceId: id,
        status: state.automaticDeployStatus,
        commit: { id: "b".repeat(40) },
      };
      state.deploys.set(id, deploy);
      state.deploysById.set(deploy.id, deploy);
      return Response.json({ service, deployId: deploy.id });
    }
    const id = path.split("/")[2]!;
    if (path.startsWith("/services/")) {
      const service = state.services.get(id);
      if (!service) return missing();
      if (path === `/services/${id}`) {
        if (method === "DELETE") {
          state.services.delete(id);
          return empty();
        }
        if (method === "PATCH") {
          assert.equal(body.environmentId, undefined);
          assert.equal(body.serviceDetails.numInstances, undefined);
          if (service.serviceDetails.disk && body.serviceDetails.maxShutdownDelaySeconds !== undefined)
            return Response.json({ message: "Disk services cannot set maxShutdownDelaySeconds" }, { status: 400 });
          service.autoDeploy = body.autoDeploy;
          if (body.repo) {
            assert.equal(body.image, undefined);
            assert.equal(body.serviceDetails.runtime, "docker");
            service.repo = body.repo;
            service.branch = body.branch;
            service.rootDir = body.rootDir;
            delete service.imagePath;
          } else {
            assert.equal(body.serviceDetails.runtime, "image");
            service.imagePath = body.image.imagePath;
            delete service.repo;
            delete service.branch;
          }
          Object.assign(service.serviceDetails, body.serviceDetails);
        }
        return Response.json(service);
      }
      if (path === `/services/${id}/env-vars`) {
        if (method === "GET")
          return Response.json(
            Object.entries(state.envs.get(id)!).map(([key, value]) => ({ envVar: { key, value }, cursor: key })),
          );
        state.envs.set(
          id,
          Object.fromEntries(body.map((item: { key: string; value: string }) => [item.key, item.value])),
        );
        return empty();
      }
      if (path === `/services/${id}/secret-files`) return empty();
      if (path === `/services/${id}/custom-domains`) {
        const domains = state.customDomains.get(id) ?? [];
        if (method === "GET")
          return Response.json(domains.map((customDomain) => ({ customDomain, cursor: customDomain.id })));
        const record = (name: string, redirectForName: string): CustomDomainRecord => ({
          id: `cd-${++state.next}`,
          name,
          domainType: name.split(".").length > 2 ? "subdomain" : "apex",
          publicSuffix: name.split(".").at(-1)!,
          verificationStatus: "unverified",
          redirectForName,
          createdAt: "2026-09-21T00:00:00Z",
          server: { id, name: service.name },
        });
        const domain = record(body.name, "");
        const created = domain.domainType === "apex" ? [domain, record(`www.${domain.name}`, domain.name)] : [domain];
        state.customDomains.set(id, [...domains, ...created]);
        return Response.json(created, { status: 201 });
      }
      if (path.startsWith(`/services/${id}/custom-domains/`)) {
        const key = decodeURIComponent(path.split("/")[4]!);
        const domain = (state.customDomains.get(id) ?? []).find((item) => item.id === key || item.name === key);
        if (!domain) return missing();
        if (path.endsWith("/verify")) return new Response("Custom domain verification triggered", { status: 202 });
        return Response.json(domain);
      }
      if (path.startsWith(`/services/${id}/env-vars/`)) {
        state.envs.get(id)![decodeURIComponent(path.split("/").at(-1)!)] = body.value;
        return empty();
      }
      if (path === `/services/${id}/rollback`) {
        const source = state.deploysById.get(body.deployId);
        if (!source) return missing();
        const deploy = { id: `dep-${++state.next}`, serviceId: id, status: "live", commit: source.commit };
        state.deploys.set(id, deploy);
        state.deploysById.set(deploy.id, deploy);
        const environment = { ...state.deployEnvs.get(source.id) };
        state.deployEnvs.set(deploy.id, environment);
        state.runtimeEnvs.set(id, environment);
        return Response.json(deploy);
      }
      if (path === `/services/${id}/deploys`) {
        if (method === "GET") {
          const latest = state.deploys.get(id);
          const history = [...state.deploysById.values()]
            .reverse()
            .filter((deploy) => deploy.serviceId === id && deploy.id !== latest?.id);
          return Response.json(
            [...(latest ? [latest] : []), ...history]
              .filter(
                (deploy) =>
                  !url.searchParams.has("status") || url.searchParams.getAll("status").includes(deploy.status),
              )
              .slice(0, Number(url.searchParams.get("limit") ?? 100))
              .map((deploy) => ({ deploy })),
          );
        }
        const deploy = {
          id: `dep-${++state.next}`,
          serviceId: id,
          status: state.nextDeployStatus,
          commit: { id: body.commitId },
        };
        state.deploys.set(id, deploy);
        state.deploysById.set(deploy.id, deploy);
        const environment = { ...state.envs.get(id) };
        state.deployEnvs.set(deploy.id, environment);
        state.runtimeEnvs.set(id, environment);
        return Response.json(deploy);
      }
      if (path.endsWith("/cancel") && path.includes("/deploys/")) {
        const deploy = state.deploysById.get(path.split("/").at(-2)!);
        if (!deploy) return missing();
        deploy.status = "canceled";
        return empty();
      }
      if (path.startsWith(`/services/${id}/deploys/`)) {
        const deploy = state.deploysById.get(path.split("/").at(-1)!);
        return deploy ? Response.json(deploy) : missing();
      }
      if (path === `/services/${id}/jobs` && method === "POST")
        return Response.json({ id: "job-acmecanary", serviceId: id, status: "pending" }, { status: 201 });
      if (path === `/services/${id}/jobs/job-acmecanary`)
        return Response.json({ id: "job-acmecanary", serviceId: id, status: state.nextJobStatus });
      if (path === `/services/${id}/jobs/job-acmecanary/cancel` && method === "POST")
        return Response.json({ id: "job-acmecanary", serviceId: id, status: "canceled" });
      if (path.endsWith("/suspend") || path.endsWith("/resume")) {
        service.suspended = path.endsWith("/suspend") ? "suspended" : "not_suspended";
        if (service.suspended === "not_suspended") {
          const deploy = {
            id: `dep-${++state.next}`,
            serviceId: id,
            status: state.automaticDeployStatus,
            commit: { id: "b".repeat(40) },
          };
          state.deploys.set(id, deploy);
          state.deploysById.set(deploy.id, deploy);
        }
        return empty();
      }
    }
    if (path === "/disks/dsk-minio" && method === "PATCH") {
      state.services.get("srv-acme-minio")!.serviceDetails.disk!.sizeGB = body.sizeGB;
      return empty();
    }
    if (path === "/logs")
      return Response.json({
        logs: [{ id: "log-a", timestamp: "2026-09-12T00:00:00Z", message: "ready" }],
        hasMore: false,
      });
    throw new Error(`Unexpected Render request ${method} ${path}`);
  });
  return state;
}

test("Render validates local inputs before creating provider-managed values", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  assert.doesNotMatch(readFileSync(join(d.ctx.configDir, ".env"), "utf8"), /PUBLIC_API_URL|DATABASE_URL/);
  await d.backend.doctor!();
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-core")!.PUBLIC_API_URL, "https://acme-core-assigned.onrender.com");
  assert.ok(c.envs.get("srv-acme-core")!.DATABASE_URL);
});

test("Render rejects invalid operator values before deployment or secret updates", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const path = join(d.ctx.configDir, ".env");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^CORE_SIGNING_SECRET=.*$/m, "CORE_SIGNING_SECRET=replace-me"),
  );
  for (const operation of [
    () => d.backend.doctor!(),
    () => d.backend.up({ dryRun: false }),
    () => d.backend.secretsPush(),
  ]) {
    c.calls.length = 0;
    await assert.rejects(async () => operation(), /Required secrets are missing: CORE_SIGNING_SECRET/);
    assert.ok(c.calls.every((call) => call.method === "GET"));
  }
});

test("Render accepts null empty lists for projects, Postgres, and services", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  const resources = new Set(["/projects", "/postgres", "/services"]);
  const received = new Set<string>();
  c.intercept = ({ path, method }) => {
    if (method !== "GET" || !resources.has(path)) return undefined;
    received.add(path);
    return Response.json(null);
  };
  await d.backend.up({ dryRun: false });
  assert.deepEqual(received, resources);
  assert.equal(c.projects.size, 1);
  assert.ok(c.database);
  assert.equal(c.services.size, 3);
});

test("Render appRegion changes the app creation default without moving deployment resources", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const resources = { ...d.saved().services };
  d.ctx.config.render!.appRegion = "virginia";
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().services, resources);
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_APP_REGION, "virginia");
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_REGION, "oregon");
  assert.equal(c.database?.region, "oregon");
  for (const service of c.services.values()) assert.equal(service.serviceDetails.region, "oregon");
  d.ctx.config.env.core = { ...d.ctx.config.env.core, RENDER_APP_REGION: "ohio" };
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /RENDER_APP_REGION=virginia/.test(error.message)));
  delete d.ctx.config.env.core.RENDER_APP_REGION;
  d.ctx.config.secretEnv = { core: { RENDER_APP_REGION: "CUSTOM_APP_REGION" } };
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /RENDER_APP_REGION.*secretEnv/.test(error.message)));
});

test("Render rejects a non-array list with a clear error", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) =>
    call.path === "/services" && call.method === "GET" ? Response.json({ unexpected: true }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), {
    message: "Render GET /services returned an invalid list response",
  });
});

const writes = (calls: Call[]) =>
  calls.filter((call) => call.url.origin === "https://api.render.com" && call.method !== "GET");

test("Render creates one project and wires MinIO credentials, URLs, Postgres, and repeat deployments", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
  assert.equal(c.services.get("srv-acme-core")!.serviceDetails.healthCheckPath, "/healthz");
  assert.equal(d.saved().environmentId, "evm-acme");
  const minio = c.envs.get("srv-acme-minio")!;
  const core = c.envs.get("srv-acme-core")!;
  assert.equal(core.AWS_SECRET_ACCESS_KEY, minio.QM_STORAGE_SECRET_KEY);
  assert.notEqual(minio.MINIO_ROOT_PASSWORD, core.AWS_SECRET_ACCESS_KEY);
  assert.equal(core.AWS_ACCESS_KEY_ID, "qm-storage");
  assert.equal(core.AWS_ENDPOINT_URL_S3, "https://acme-minio-assigned.onrender.com");
  assert.equal(core.RENDER_PROJECT_ID, "prj-acme");

  assert.equal(core.RENDER_ENVIRONMENT_ID, "evm-acme");
  assert.equal(core.DATABASE_URL, "postgresql://qm:private-password@pg/qm");
  assert.equal(core.PUBLIC_API_URL, "https://acme-core-assigned.onrender.com");
  assert.equal(minio.MINIO_API_CORS_ALLOW_ORIGIN, "https://acme-web-ui-assigned.onrender.com");
  assert.equal(minio.MINIO_BROWSER, "off");
  assert.equal(
    c.services.get("srv-acme-minio")!.serviceDetails.envSpecificDetails.dockerfilePath,
    "deploy/render-minio/Dockerfile",
  );
  assert.equal(c.services.get("srv-acme-minio")!.serviceDetails.envSpecificDetails.dockerCommand, renderMinioCommand);
  for (const [id, env] of c.envs)
    if (id !== "srv-acme-minio") {
      assert.equal(env.MINIO_ROOT_PASSWORD, undefined);
      assert.equal(env.QM_STORAGE_SECRET_KEY, undefined);
    }
  const disk = readFileSync(join(d.ctx.configDir, "render.resources.json"), "utf8");
  for (const secret of [minio.MINIO_ROOT_PASSWORD!, minio.QM_STORAGE_SECRET_KEY!, "private-password", "e".repeat(64)])
    assert.equal(disk.includes(secret), false);
  const first = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.ok(writes(c.calls.slice(first)).some((call) => call.path === "/services/srv-acme-core/deploys"));
  assert.ok(!writes(c.calls.slice(first)).some((call) => call.path === "/services/srv-acme-minio/deploys"));
  assert.equal(core.WORKERS, undefined);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, minio.MINIO_ROOT_PASSWORD);
});

test("Render plan needs no API calls, Git repository, or state file", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: true });
  assert.equal(c.calls.length, 0);
  assert.equal(existsSync(join(d.ctx.configDir, "render.resources.json")), false);
});

test("Render up retains MinIO until its upgrade is explicit", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const services = d.saved().services;
  d.setCommit("c".repeat(40));
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().services, services);
  assert.equal(c.deploys.get("srv-acme-core")!.commit!.id, "c".repeat(40));
  assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "a".repeat(40));
  const provider = hostingProvider("render");
  await d.backend.up(provider.upOptions(d.ctx, { "upgrade-minio": true }, false));
  assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "c".repeat(40));
  d.setCommit("d".repeat(40));
  await d.backend.up({ dryRun: false });
  assert.equal(c.deploys.get("srv-acme-core")!.commit!.id, "d".repeat(40));
  assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "c".repeat(40));
});

test("Render retains the MinIO source when the QM repository and branch change", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.setCommit("c".repeat(40));
  d.ctx.config.render!.source = { repo: "https://github.com/acme/qm-next", branch: "release" };
  await d.backend.up({ dryRun: false });
  assert.equal(c.services.get("srv-acme-minio")!.repo, "https://github.com/acme/qm");
  assert.equal(c.services.get("srv-acme-minio")!.branch, "main");
  assert.equal(c.services.get("srv-acme-core")!.repo, "https://github.com/acme/qm-next");
  assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "a".repeat(40));
  await d.backend.up({ dryRun: false, upgradeMinio: true });
  assert.equal(c.services.get("srv-acme-minio")!.repo, "https://github.com/acme/qm-next");
  assert.equal(c.services.get("srv-acme-minio")!.branch, "release");
  assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "c".repeat(40));
});

for (const failure of ["build", "status"]) {
  test(`Render retries the selected MinIO source after an explicit upgrade ${failure} failure`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    await d.backend.up({ dryRun: false });
    d.setCommit("c".repeat(40));
    d.ctx.config.render!.source = { repo: "https://github.com/acme/qm-next", branch: "release" };
    if (failure === "build") c.nextDeployStatus = "build_failed";
    else
      c.intercept = ({ path, method }) =>
        path.startsWith("/services/srv-acme-minio/deploys/") &&
        method === "GET" &&
        c.deploys.get("srv-acme-minio")?.commit?.id === "c".repeat(40)
          ? new Response(null, { status: 403 })
          : undefined;
    await assert.rejects(d.backend.up({ dryRun: false, upgradeMinio: true }), /build_failed|HTTP 403/);
    assert.deepEqual(d.saved().minioSource, {
      repo: "https://github.com/acme/qm-next",
      branch: "release",
      commit: "c".repeat(40),
    });
    assert.equal(c.deploys.get("srv-acme-minio")!.status, failure === "build" ? "build_failed" : "live");
    c.nextDeployStatus = "live";
    c.intercept = undefined;
    d.setCommit("d".repeat(40));
    const mark = c.calls.length;
    await hostingProvider("render").createBackend(d.ctx).up({ dryRun: false });
    const storageDeploys = writes(c.calls.slice(mark)).filter(
      (call) => call.path === "/services/srv-acme-minio/deploys",
    );
    assert.equal(storageDeploys.length, Number(failure === "build"));
    assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "c".repeat(40));
    assert.equal(c.services.get("srv-acme-minio")!.repo, "https://github.com/acme/qm-next");
    assert.equal(c.services.get("srv-acme-minio")!.branch, "release");
    assert.equal(c.deploys.get("srv-acme-core")!.commit!.id, "d".repeat(40));
  });
}

test("Render refuses to change an unknown MinIO version without an explicit upgrade", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const saved = d.saved();
  delete saved.minioSource;
  writeFileSync(join(d.ctx.configDir, "render.resources.json"), JSON.stringify(saved));
  d.setCommit("c".repeat(40));
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /MinIO has no saved Git source.*render.resources.json/);
  assert.ok(!writes(c.calls.slice(mark)).some((call) => call.path === "/services/srv-acme-minio/deploys"));
});

test("Render names the last probe result when core never becomes ready", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) => (call.path === "/healthz" ? new Response("starting", { status: 503 }) : undefined);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 17) });
  let outcome: unknown;
  const run = d.backend.up({ dryRun: false }).then(
    () => (outcome = "ready"),
    (error: unknown) => (outcome = error),
  );
  for (let i = 0; i < 2000 && outcome === undefined; i++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(3_000);
  }
  await run;
  assert.match(
    String((outcome as Error).message),
    /core readiness did not become ready in 20 minutes \(last result: HTTP 503\)/,
  );
});

test("Render requests wait for an HTTP-date Retry-After before retrying", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 17) });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? new Response(null, { status: 429, headers: { "retry-after": new Date(Date.now() + 20_000).toUTCString() } })
      : Response.json({ ok: true });
  });
  const pending = renderClient("test-key")<{ ok: boolean }>("/owners/test");
  await new Promise(setImmediate);
  t.mock.timers.tick(19_999);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(calls, 2);
});

test("Render config rejects retired compute plan names and names their replacements", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-render-plans-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = parseConfigJson(
    renderScaffold.renderConfig("acme", "anthropic", "resend", { repo: "https://github.com/acme/qm", branch: "main" }),
  ) as Record<string, any>;
  raw.render.workspaceId = "tea-acme";
  raw.render.postgresPlan = "standard";
  delete raw.modelProvider;
  delete raw.secretEnv;
  const configPath = join(dir, "qm.config.jsonc");
  const load = (render: Record<string, unknown>) => {
    writeFileSync(configPath, JSON.stringify({ ...raw, render: { ...raw.render, ...render } }));
    return loadConfigAt(configPath).config.render!;
  };
  assert.equal(load({}).postgresPlan, "standard");
  assert.throws(
    () => load({ corePlan: "standard" }),
    /render\.corePlan standard is a retired Render plan name; use 1c-2g/,
  );
  assert.throws(() => load({ servicePlan: "starter" }), /render\.servicePlan starter is a retired.*use 0\.5c-512mb/);
  assert.throws(() => load({ storage: { plan: "pro" } }), /render\.storage\.plan pro is a retired.*use 2c-4g/);
});

function hurryLockClock(t: TestContext): void {
  let now = Date.now();
  t.mock.method(Date, "now", () => (now += 1_000));
}

test("Render protects a live owner and recovers its lock after SIGKILL", { timeout: 10_000 }, async (t) => {
  const d = deployment(t);
  const path = join(d.ctx.configDir, ".render.lock");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createRenderBackend } from ${JSON.stringify(new URL("../src/backends/render.ts", import.meta.url).href)};
process.on("message", () => {});
globalThis.fetch = async () => {
  process.send("locked");
  return new Promise(() => {});
};
await createRenderBackend(${JSON.stringify(d.ctx)}).up({ dryRun: false });`,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const [message] = await Promise.race([
    once(child, "message"),
    exited.then(() => {
      throw new Error(`Render lock owner exited before the API call: ${stderr}`);
    }),
  ]);
  assert.equal(message, "locked");
  const owner = readdirSync(path)[0]!;
  assert.match(owner, /^owner-/);
  assert.equal(readFileSync(join(path, owner), "utf8"), String(child.pid));
  const expired = new Date(Date.now() - 10_000);
  utimesSync(path, expired, expired);
  hurryLockClock(t);
  await assert.rejects(async () => d.backend.down({}), /Another qm operation holds/);
  assert.equal(readFileSync(join(path, owner), "utf8"), String(child.pid));
  child.kill("SIGKILL");
  await exited;
  await assert.rejects(async () => d.backend.down({}), /No Render resource record exists/);
  assert.equal(existsSync(path), false);
});

test("Render waits for MinIO initialization before deploying core and retries a failed job", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.nextJobStatus = "failed";
  await assert.rejects(d.backend.up({ dryRun: false }), /MinIO initialization job.*failed/);
  assert.equal(
    c.calls.some((call) => call.method === "POST" && call.path === "/services/srv-acme-core/deploys"),
    false,
  );
  const before = c.calls.length;
  c.nextJobStatus = "succeeded";
  await d.backend.up({ dryRun: false });
  const writesAfter = writes(c.calls.slice(before));
  assert.equal(
    writesAfter.some((call) => call.path === "/services"),
    false,
  );
  const initialized = writesAfter.findIndex((call) => call.path === "/services/srv-acme-minio/jobs");
  const coreDeploy = writesAfter.findIndex((call) => call.path === "/services/srv-acme-core/deploys");
  assert.ok(initialized >= 0 && coreDeploy > initialized);
  const command = (writesAfter[initialized]!.body as { startCommand: string }).startCommand;
  const env = c.envs.get("srv-acme-minio")!;
  for (const secret of [env.MINIO_ROOT_PASSWORD!, env.QM_STORAGE_SECRET_KEY!])
    assert.equal(command.includes(secret), false);
});

test("Render builds QM services and MinIO from Git", async (t) => {
  const d = deployment(t, true);
  d.ctx.config.render!.source = { repo: "https://github.com/acme/qm", branch: "render-test" };
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const saved = d.saved();
  assert.equal(c.services.size, 4);
  for (const service of c.services.values()) {
    if (service.id === "srv-acme-minio") continue;
    assert.equal(service.repo, "https://github.com/acme/qm");
    assert.equal(service.branch, "render-test");
    assert.equal(service.imagePath, undefined);
    assert.equal(service.serviceDetails.runtime, "docker");
    assert.equal(service.autoDeploy, "no");
  }
  assert.equal(
    c.services.get("srv-acme-minio")!.serviceDetails.envSpecificDetails.dockerfilePath,
    "deploy/render-minio/Dockerfile",
  );
  assert.equal(c.services.get("srv-acme-minio")!.serviceDetails.runtime, "docker");
  assert.equal(c.services.get("srv-acme-minio")!.repo, "https://github.com/acme/qm");
  assert.equal(
    c.services.get("srv-acme-portal")!.serviceDetails.envSpecificDetails.dockerfilePath,
    "deploy/portal/Dockerfile",
  );
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_REPO, "https://github.com/acme/qm");
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_BRANCH, "render-test");
  c.services.get("srv-acme-minio")!.serviceDetails.plan = "starter";
  c.services.get("srv-acme-core")!.serviceDetails.plan = "pro";
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().services, saved.services);
  const changes = writes(c.calls.slice(mark));
  assert.ok(changes.some((call) => call.path === "/services/srv-acme-core/deploys" && call.method === "POST"));
  assert.ok(!changes.some((call) => call.path === "/services/srv-acme-minio/deploys"));
  assert.ok(!changes.some((call) => call.path === "/services/srv-acme-minio" && call.method === "PATCH"));
  assert.ok(!changes.some((call) => call.path === "/services/srv-acme-core" && call.method === "PATCH"));
});

for (const [status, plan] of [
  ["build_failed", undefined],
  ["update_failed", "4c-8g"],
] as const)
  test(`Render recovers from ${status} without new services`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    if (plan) {
      await d.backend.up({ dryRun: false });
      d.ctx.config.render!.corePlan = plan;
    }
    c.nextDeployStatus = status;
    await assert.rejects(d.backend.up({ dryRun: false }), new RegExp(status));
    if (plan) assert.equal(c.services.get("srv-acme-core")!.serviceDetails.plan, plan);
    const mark = c.calls.length;
    c.nextDeployStatus = "live";
    await d.backend.up({ dryRun: false });
    assert.ok(
      c.calls.slice(mark).some((call) => call.path === "/services/srv-acme-core/deploys" && call.method === "POST"),
    );
    assert.equal(c.services.size, 3);
    assert.equal(c.calls.filter((call) => call.path === "/services" && call.method === "POST").length, 3);
  });

test("Render retries after env write failure after a preceding service update succeeds", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.render!.corePlan = "4c-8g";
  d.ctx.config.env.core!.FEATURE = "new";
  c.intercept = (call) =>
    call.path === "/services/srv-acme-core/env-vars" && call.method === "PUT"
      ? new Response(null, { status: 500, headers: { "retry-after": "0" } })
      : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-core")!.FEATURE, "new");
});

test("Render retains completed resource IDs after a later create fails", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) =>
    call.path === "/services" && call.method === "POST" && (call.body as { name: string }).name === "acme-core"
      ? Response.json(
          { message: "plan is not available" },
          { status: 400, headers: { "render-request-id": "req-core" } },
        )
      : undefined;
  await assert.rejects(
    d.backend.up({ dryRun: false }),
    /POST \/services failed \(HTTP 400\): \{"message":"plan is not available"\} \[request id req-core\]/,
  );
  assert.equal(Object.keys(d.saved().services).length, 1);
  assert.equal(d.saved().pendingCreate, undefined);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
});

for (const status of ["live", "update_failed"]) {
  test(`Render follows an empty accepted deploy response until the new deploy is ${status}`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    await d.backend.up({ dryRun: false });
    const previous = c.deploys.get("srv-acme-core")!;
    const mark = c.calls.length;
    let queued = false;
    let listReads = 0;
    c.intercept = ({ path, method }) => {
      if (path === "/services/srv-acme-core/deploys" && method === "POST") {
        queued = true;
        return new Response(null, { status: 202 });
      }
      if (path === "/services/srv-acme-core/deploys" && queued) {
        const deploy =
          ++listReads === 1
            ? previous
            : { id: "dep-queued", status: listReads === 2 ? "queued" : status, commit: { id: "a".repeat(40) } };
        return Response.json([{ deploy }]);
      }
      if (path === "/services/srv-acme-core/deploys/dep-queued")
        return Response.json({ id: "dep-queued", status, commit: { id: "a".repeat(40) } });
      return undefined;
    };
    d.ctx.config.render!.corePlan = "4c-8g";
    if (status === "live") {
      await d.backend.up({ dryRun: false });
    } else {
      await assert.rejects(d.backend.up({ dryRun: false }), /dep-queued ended with update_failed/);
    }
    assert.equal(listReads, status === "live" ? 3 : 2);
    assert.equal(
      c.calls.slice(mark).filter((call) => call.path === "/services/srv-acme-core/deploys" && call.method === "POST")
        .length,
      1,
    );
    assert.equal(
      c.calls.slice(mark).some((call) => call.path === `/services/srv-acme-core/deploys/${previous.id}`),
      false,
    );
  });
}

test("Render cancels an active deploy before it submits an update", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const previous = c.deploys.get("srv-acme-core")!;
  let canceled = false;
  let triggered = false;
  let readsAfterCancel = 0;
  c.intercept = ({ path, method }) => {
    if (path === "/services/srv-acme-core/deploys" && method === "GET" && !triggered)
      return Response.json([
        { deploy: previous },
        {
          deploy: { id: "dep-active", status: "update_in_progress" },
        },
      ]);
    if (path === "/services/srv-acme-core/deploys/dep-active" && method === "GET")
      return Response.json({
        id: "dep-active",
        status: canceled && ++readsAfterCancel > 1 ? "canceled" : "update_in_progress",
      });
    if (path === "/services/srv-acme-core/deploys/dep-active/cancel" && method === "POST") {
      canceled = true;
      return new Response(null, { status: 204 });
    }
    if (path === "/services/srv-acme-core/deploys" && method === "POST") {
      assert.equal(canceled, true);
      triggered = true;
    }
    return undefined;
  };
  d.ctx.config.render!.corePlan = "4c-8g";
  await d.backend.up({ dryRun: false });
  assert.equal(triggered, true);
  assert.ok(readsAfterCancel >= 2);
  assert.equal(
    c.calls.filter(
      ({ path, method, url }) =>
        path === "/services/srv-acme-core/deploys" && method === "GET" && url.searchParams.get("limit") === "100",
    ).length,
    2,
  );
});

test("Render waits for an uncertain service creation before retry or purge", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) => {
    if (call.path !== "/services" || call.method !== "POST") return undefined;
    throw new TypeError("connection closed");
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /connection closed/);
  assert.equal(d.saved().pendingCreate.collection, "services");
  c.intercept = undefined;
  const backend = hostingProvider("render").createBackend(d.ctx);
  const mark = c.calls.length;
  await assert.rejects(backend.up({ dryRun: false }), /creation of acme-minio is unresolved/);
  await assert.rejects(async () => backend.down({ purge: true }), /creation of acme-minio is unresolved/);
  assert.equal(d.saved().pendingCreate.collection, "services");
  assert.deepEqual(writes(c.calls.slice(mark)), []);
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 0);
  assert.ok(c.database);
});

test("Render permits cleanup after a rejected service creation", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) =>
    path === "/services" && method === "POST" ? new Response(null, { status: 400 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 400/);
  c.intercept = undefined;
  await hostingProvider("render").createBackend(d.ctx).down({ purge: true });
  assert.equal(d.saved().pendingCreate, undefined);
  assert.equal(c.services.size, 0);
  assert.equal(c.database, undefined);
  writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${"b".repeat(40)}' "$4"\n`);
  await hostingProvider("render").createBackend(d.ctx).up({ dryRun: false });
  assert.equal(d.saved().releases[0].commit, "b".repeat(40));
});

test("Render retains the creation request when its recovery lookup fails", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path === "/projects" && method === "POST") throw new TypeError("connection closed");
    return undefined;
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /connection closed/);
  c.intercept = ({ path, method }) =>
    path === "/projects" && method === "GET" ? new Response(null, { status: 503 }) : undefined;
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 503/);
  assert.deepEqual(d.saved().pendingCreate, { collection: "projects", name: "acme-qm" });
  assert.deepEqual(writes(c.calls.slice(mark)), []);
  c.intercept = undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /creation of acme-qm is unresolved/);
  assert.deepEqual(d.saved().pendingCreate, { collection: "projects", name: "acme-qm" });
});

test("Render retains the creation request when its recovery lookup returns an empty body", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path === "/projects" && method === "POST") throw new TypeError("connection closed");
    return undefined;
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /connection closed/);
  c.intercept = ({ path, method }) =>
    path === "/projects" && method === "GET" ? new Response(null, { status: 200 }) : undefined;
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /invalid list response/);
  await assert.rejects(async () => d.backend.down({ purge: true }), /invalid list response/);
  assert.deepEqual(d.saved().pendingCreate, { collection: "projects", name: "acme-qm" });
  assert.deepEqual(writes(c.calls.slice(mark)), []);
});

test("Render records a resource after its accepted creation response is lost", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path !== "/projects" || method !== "POST") return undefined;
    c.projects.set("prj-acme", {
      id: "prj-acme",
      name: "acme-qm",
      owner: { id: "tea-acme" },
      environmentIds: ["evm-acme"],
    });
    throw new TypeError("connection closed");
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /connection closed/);
  assert.deepEqual(d.saved().pendingCreate, { collection: "projects", name: "acme-qm" });
  c.intercept = undefined;
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(d.saved().pendingCreate, undefined);
  assert.equal(d.saved().projectId, "prj-acme");
  assert.equal(c.projects.size, 1);
  assert.equal(c.calls.slice(mark).filter((call) => call.method === "POST" && call.path === "/projects").length, 0);
});

test("Render retries a resource creation rejected by rate limiting", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) =>
    call.path === "/services" && call.method === "POST" ? new Response(null, { status: 429 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 429/);
  assert.equal(d.saved().pendingCreate, undefined);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(d.saved().pendingCreate, undefined);
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
});

test("Render retries transient API failures for idempotent requests and only rate limits for creations", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  const injected = new Set<string>();
  const once = (key: string, fail: () => Response) => {
    if (injected.has(key)) return undefined;
    injected.add(key);
    return fail();
  };
  const transient = (status: number) => () => new Response(null, { status, headers: { "retry-after": "0" } });
  c.intercept = ({ path, method }) => {
    if (method === "GET" && path === "/owners/tea-acme") return once("owner", transient(503));
    if (method === "POST" && path === "/projects") return once("project", transient(429));
    if (method === "PUT" && path === "/services/srv-acme-core/env-vars")
      return once("env", () => {
        throw new TypeError("connection reset");
      });
    return undefined;
  };
  await d.backend.up({ dryRun: false });
  assert.deepEqual([...injected], ["owner", "project", "env"]);
  assert.equal(c.projects.size, 1);
  assert.equal(c.calls.filter((call) => call.method === "POST" && call.path === "/projects").length, 2);
  c.intercept = ({ path, method }) =>
    method === "POST" && path === "/services/srv-acme-core/deploys"
      ? new Response(null, { status: 503, headers: { "retry-after": "0" } })
      : undefined;
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 503/);
  assert.equal(
    c.calls.slice(mark).filter((call) => call.method === "POST" && call.path === "/services/srv-acme-core/deploys")
      .length,
    1,
  );
  c.intercept = ({ path, method }) => {
    if (method !== "DELETE" || path !== "/services/srv-acme-core") return undefined;
    return once("delete", () => {
      c.services.delete("srv-acme-core");
      return new Response(null, { status: 502, headers: { "retry-after": "0" } });
    });
  };
  await d.backend.down({ purge: true });
  assert.ok(injected.has("delete"));
  assert.equal(c.services.size, 0);
  assert.deepEqual(d.saved().services, {});
});

test("Render rejects unrecorded same-name resources and changed ownership before mutations", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.projects.set("prj-existing", {
    id: "prj-existing",
    name: "acme-qm",
    owner: { id: "tea-acme" },
    environmentIds: [],
  });
  await assert.rejects(d.backend.up({ dryRun: false }), /Refusing to adopt/);
  assert.deepEqual(writes(c.calls), []);
  c.projects.clear();
  await d.backend.up({ dryRun: false });
  c.services.get("srv-acme-web-ui")!.environmentId = "evm-other";
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /does not match/);
  assert.deepEqual(writes(c.calls.slice(mark)), []);
  await assert.rejects(async () => d.backend.down({ purge: true }), /does not match/);
  assert.equal(c.services.size, 3);
});

test("Render stops services and resumes them while retaining database and disk", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  await d.backend.down({});
  assert.equal(c.services.get("srv-acme-minio")!.suspended, "suspended");
  assert.ok(c.database);
  assert.equal(c.services.size, 3);
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.ok([...c.services.values()].every((service) => service.suspended === "not_suspended"));
  assert.equal(
    c.calls.slice(mark).some((call) => call.path.endsWith("/deploys") && call.method === "POST"),
    true,
  );
});

test("Render shutdown ignores app services outside the saved project", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const app = {
    ...c.services.get("srv-acme-web-ui")!,
    id: "srv-other-project-app",
    name: "qm-app-other",
    type: "private_service",
    environmentId: "evm-other-project",
  };
  c.services.set(app.id, app);
  c.envs.set(app.id, { QM_DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000002" });
  const mark = c.calls.length;
  await d.backend.down({});
  assert.equal(app.suspended, "not_suspended");
  assert.ok(c.calls.slice(mark).every((call) => !call.path.startsWith(`/services/${app.id}`)));
});

test("Render protects published apps in owner environments before shutdown or purge", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const app = {
    ...c.services.get("srv-acme-web-ui")!,
    id: "srv-published-app",
    name: "qm-app-a1",
    environmentId: "evm-owner",
    type: "web_service",
  };
  c.projects.get("prj-acme")!.environmentIds.push("evm-owner");
  c.services.set(app.id, app);
  c.envs.set(app.id, { QM_DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000001" });
  for (const environmentId of ["evm-acme", "evm-owner"]) {
    app.environmentId = environmentId;
    for (const purge of [false, true]) {
      const mark = c.calls.length;
      await assert.rejects(async () => d.backend.down({ purge }), /Published apps still use this deployment/);
      assert.deepEqual(writes(c.calls.slice(mark)), []);
      assert.equal(d.saved().pendingPurge, undefined);
    }
  }
  app.suspended = "suspended";
  await assert.rejects(async () => d.backend.down({ purge: true }), /Published apps still use this deployment/);
  await d.backend.down({});
  assert.ok(c.database);
});

test("Render purge resumes partial deletion and retains the project", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.intercept = (call) =>
    call.path === "/services/srv-acme-core" && call.method === "DELETE"
      ? new Response(null, { status: 500 })
      : undefined;
  await assert.rejects(async () => d.backend.down({ purge: true }), /HTTP 500/);
  assert.equal(d.saved().pendingPurge, true);
  assert.ok(c.database);
  await assert.rejects(d.backend.up({ dryRun: false }), /cleanup is incomplete/);
  c.intercept = undefined;
  await d.backend.down({ purge: true });
  assert.equal(c.services.size, 0);
  assert.equal(c.database, undefined);
  assert.equal(c.projects.size, 1);
  assert.deepEqual(d.saved().services, {});
  await d.backend.up({ dryRun: false });
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
});

test("Render secret push targets consumers and keeps managed MinIO credentials", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.envs.get("srv-acme-core")!.AWS_SESSION_TOKEN = "old-session";
  writeFileSync(
    join(d.ctx.configDir, ".env"),
    `${readFileSync(join(d.ctx.configDir, ".env"), "utf8")}\nAWS_SESSION_TOKEN=\n`,
  );
  await d.backend.secretsPush();
  assert.equal(c.envs.get("srv-acme-core")!.AWS_SESSION_TOKEN, "old-session");
  assert.equal(c.envs.get("srv-acme-web-ui")!.AWS_SECRET_ACCESS_KEY, undefined);
  await d.backend.up({ dryRun: false });
});

test("Render updates retain stored operator secrets for the core", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.envs.get("srv-acme-core")!.RESEND_API_KEY = "re_stored_only";
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-core")!.RESEND_API_KEY, "re_stored_only");
  assert.equal(c.envs.get("srv-acme-web-ui")!.RESEND_API_KEY, undefined);
});

test("Render rejects disk shrink, plain HTTP URLs, and a shared hostname", async (t) => {
  const d = deployment(t);
  cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.render!.storage.diskSizeGB = 1;
  await assert.rejects(d.backend.up({ dryRun: false }), /cannot shrink/);
  for (const publicUrl of ["http://qm.example.com", "https://qm.example.com:8443"]) {
    d.ctx.config.publicUrl = publicUrl;
    assert.ok(
      renderConfigErrors(d.ctx.config, []).some((error) => /HTTPS origin URLs on port 443/.test(error.message)),
    );
  }
  d.ctx.config.publicUrl = "https://qm.example.com";
  d.ctx.config.apiUrl = "https://qm.example.com/";
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /different hostnames/.test(error.message)));
  d.ctx.config.apiUrl = "https://www.qm.example.com";
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /www subdomain/.test(error.message)));
  d.ctx.config.apiUrl = "https://api.qm.example.com";
  assert.deepEqual(renderConfigErrors(d.ctx.config, []), []);
});

test("Render binds operator custom domains and checks their verification live", async (t) => {
  const d = deployment(t, true);
  mkdirSync(d.ctx.sandboxDir);
  const c = cloud(t, d);
  const raw = JSON.parse(readFileSync(d.ctx.configPath, "utf8"));
  Object.assign(raw, { publicUrl: "https://acme.example", apiUrl: "https://api.acme.example" });
  writeFileSync(d.ctx.configPath, JSON.stringify(raw));
  Object.assign(d.ctx.config, { publicUrl: raw.publicUrl, apiUrl: raw.apiUrl });
  const domainWrites = (calls: Call[]) =>
    writes(calls)
      .filter((call) => call.path.includes("/custom-domains"))
      .map((call) => [call.method, call.path.replace(/cd-\d+/, "cd"), call.body]);
  const application = (calls: Call[], path: string) =>
    calls
      .filter((call) => call.url.origin !== "https://api.render.com" && call.path === path)
      .map((call) => call.url.origin);
  await d.backend.up({ dryRun: false });
  assert.deepEqual(domainWrites(c.calls), [
    ["POST", "/services/srv-acme-core/custom-domains", { name: "api.acme.example" }],
    ["POST", "/services/srv-acme-portal/custom-domains", { name: "acme.example" }],
  ]);
  assert.equal(readFileSync(d.ctx.configPath, "utf8"), JSON.stringify(raw));
  assert.equal(d.ctx.config.apiUrl, "https://api.acme.example");
  assert.equal(c.envs.get("srv-acme-core")!.PUBLIC_API_URL, "https://api.acme.example");
  assert.equal(c.envs.get("srv-acme-core")!.PUBLIC_WEB_URL, "https://acme.example");
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_API_CORS_ALLOW_ORIGIN, "https://acme.example");
  assert.deepEqual([...new Set(application(c.calls, "/healthz"))], ["https://acme-core-assigned.onrender.com"]);
  assert.deepEqual(application(c.calls, "/v1/deployment-layer"), ["https://acme-core-assigned.onrender.com"]);
  assert.deepEqual(
    c.customDomains.get("srv-acme-portal")!.map((domain) => [domain.name, domain.redirectForName]),
    [
      ["acme.example", ""],
      ["www.acme.example", "acme.example"],
    ],
  );
  let mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(domainWrites(c.calls.slice(mark)), [
    ["POST", "/services/srv-acme-core/custom-domains/cd/verify", undefined],
    ["POST", "/services/srv-acme-portal/custom-domains/cd/verify", undefined],
  ]);
  d.ctx.config.publicUrl = "https://www.acme.example";
  const redirected =
    /acme-portal: www\.acme\.example redirects to acme\.example on Render; configure https:\/\/acme\.example/;
  await assert.rejects(d.backend.up({ dryRun: false }), redirected);
  d.ctx.config.publicUrl = "https://acme.example";
  await assert.rejects(
    async () => d.backend.checkLive!(),
    /acme-core: custom domain api\.acme\.example is unverified; point api\.acme\.example at acme-core-assigned\.onrender\.com with a CNAME record/,
  );
  c.customDomains.get("srv-acme-core")![0]!.verificationStatus = "verified";
  d.ctx.config.publicUrl = "https://www.acme.example";
  await assert.rejects(async () => d.backend.checkLive!(), redirected);
  d.ctx.config.publicUrl = "https://acme.example";
  await assert.rejects(
    async () => d.backend.checkLive!(),
    /acme-portal: custom domain acme\.example is unverified; point acme\.example at acme-portal-assigned\.onrender\.com with an ALIAS or ANAME record/,
  );
  c.customDomains.get("srv-acme-portal")![0]!.verificationStatus = "verified";
  mark = c.calls.length;
  await d.backend.checkLive!();
  assert.deepEqual(application(c.calls.slice(mark), "/healthz"), ["https://api.acme.example", "https://acme.example"]);
  assert.deepEqual(application(c.calls.slice(mark), "/v1/deployment-layer"), ["https://api.acme.example"]);
  await d.backend.status();
  c.customDomains.set("srv-acme-portal", []);
  await assert.rejects(async () => d.backend.checkLive!(), /acme-portal has no custom domain acme\.example; run qm up/);
  mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(domainWrites(c.calls.slice(mark)), [
    ["POST", "/services/srv-acme-portal/custom-domains", { name: "acme.example" }],
  ]);
  Object.assign(raw, { publicUrl: "https://acme-portal.onrender.com", apiUrl: "https://acme-core.onrender.com" });
  writeFileSync(d.ctx.configPath, JSON.stringify(raw));
  Object.assign(d.ctx.config, { publicUrl: raw.publicUrl, apiUrl: raw.apiUrl });
  mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(domainWrites(c.calls.slice(mark)), []);
  assert.equal(d.ctx.config.publicUrl, "https://acme-portal-assigned.onrender.com");
  assert.equal(loadConfigAt(d.ctx.configPath).config.apiUrl, "https://acme-core-assigned.onrender.com");
});

test("Render reports status, logs, and signed layer health from saved IDs", async (t) => {
  const d = deployment(t, true);
  mkdirSync(d.ctx.sandboxDir);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  await d.backend.status();
  await d.backend.logs("core", { follow: false, tail: 10 });
  await d.backend.checkLive!();
  const layerCalls = c.calls.filter((call) => call.path === "/v1/deployment-layer");
  assert.deepEqual(
    layerCalls.map((call) => call.method),
    ["PUT", "GET"],
  );
  assert.ok(layerCalls.every((call) => call.url.origin === "https://acme-core-assigned.onrender.com"));
  assert.equal(d.ctx.config.publicUrl, "https://acme-portal-assigned.onrender.com");
  const logCalls = c.calls.filter((call) => call.path === "/logs");
  assert.ok(logCalls.some((call) => call.url.searchParams.get("resource") === "srv-acme-core"));
  for (const call of logCalls) {
    const startTime = call.url.searchParams.get("startTime");
    assert.ok(
      startTime === null || Date.parse(startTime) >= Date.now() - 30 * 24 * 60 * 60_000,
      `Render rejects log queries that start more than 30 days ago: ${call.url.search}`,
    );
  }
  assert.deepEqual(c.calls.find((call) => call.path === "/services/srv-acme-core/jobs")?.body, {
    startCommand:
      "timeout -s TERM -k 30 1200 node src/deployment/postdeploy-smoke.ts session http://acme-core-assigned:8080",
  });
});

function logSubscription(t: TestContext, onConnect: (url: URL, options: WebSocketInit) => void) {
  const socket = Object.assign(new EventTarget(), { binaryType: "blob", close: t.mock.fn() });
  t.mock.method(globalThis, "WebSocket", function (url: string | URL, options: WebSocketInit) {
    queueMicrotask(() => {
      socket.dispatchEvent(new Event("open"));
      onConnect(new URL(url), options);
    });
    return socket;
  });
  return socket;
}

test("Render prints a paginated tail in time order and follows logs through one subscription", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const entries = Array.from({ length: 101 }, (_, i) => ({
    timestamp: new Date(Date.now() - 100_000 + i).toISOString(),
    message: `line ${i}`,
  }));
  entries[0]!.timestamp = `${entries[50]!.timestamp.slice(0, -1)}000001Z`;
  entries[52]!.timestamp = entries[51]!.timestamp;
  const requests: URL[] = [];
  c.intercept = ({ path, url }) => {
    if (path !== "/logs") return;
    requests.push(url);
    return Response.json({
      logs: requests.length === 1 ? entries.slice(1) : entries.slice(0, 1),
      hasMore: requests.length === 1,
      nextStartTime: new Date(Date.now() - 60 * 60_000).toISOString(),
      nextEndTime: entries[0]!.timestamp,
    });
  };
  const socket = logSubscription(t, (url, options) => {
    assert.equal(url.origin, "wss://api.render.com");
    assert.equal(url.pathname, "/v1/logs/subscribe");
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${"e".repeat(64)}`);
    assert.deepEqual(url.searchParams.getAll("resource"), ["srv-acme-core"]);
    assert.equal(url.searchParams.get("ownerId"), "tea-acme");
    assert.equal(url.searchParams.get("direction"), "forward");
    assert.equal(url.searchParams.get("endTime"), null);
    assert.equal(url.searchParams.get("limit"), null);
    const start = url.searchParams.get("startTime")!;
    const end = requests[0]!.searchParams.get("endTime")!;
    assert.equal(start, end);
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ timestamp: start, message: "live" }) }));
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: new TextEncoder().encode(JSON.stringify({ timestamp: start, message: "binary" })).buffer,
      }),
    );
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1011, reason: "service restart" }));
  });
  await assert.rejects(
    async () => d.backend.logs("core", { follow: true, tail: 101 }),
    /closed \(1011\): service restart/,
  );
  const ordered = [...entries.slice(1, 51), entries[0]!, ...entries.slice(51)];
  assert.deepEqual(
    lines.slice(0, 101),
    ordered.map((entry) => `${entry.timestamp} ${entry.message}`),
  );
  assert.ok(lines[101]!.endsWith(" live"));
  assert.ok(lines[102]!.endsWith(" binary"));
  assert.equal(lines.length, 103);
  assert.deepEqual(
    requests.map((url) => url.searchParams.get("limit")),
    ["100", "1"],
  );
  assert.equal(socket.close.mock.callCount(), 1);
});

for (const [failure, expected] of [
  ["connection", /HTTP upgrade failed/],
  ["invalid JSON", SyntaxError],
  ["invalid log", /invalid log/],
] as const) {
  test(`Render log subscriptions report ${failure} failures and close the connection`, async (t) => {
    const failureCause = new Error("HTTP upgrade failed");
    const socket = logSubscription(t, () => {
      socket.dispatchEvent(
        failure === "connection"
          ? Object.assign(new Event("error"), { error: failureCause, message: failureCause.message })
          : new MessageEvent("message", { data: failure === "invalid JSON" ? "{" : "{}" }),
      );
    });
    const output: string[] = [];
    await assert.rejects(
      streamRenderLogs("test-key", new URLSearchParams(), (log) => output.push(log.message)),
      expected,
    );
    assert.deepEqual(output, []);
    assert.equal(socket.close.mock.callCount(), 1);
  });
}

test("Render layer transport rejects missing or invalid core URLs before sending a request", async (t) => {
  const d = deployment(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("ok");
  });
  for (const apiUrl of [
    undefined,
    "http://core.onrender.com",
    "https://user:password@core.onrender.com",
    "https://core.onrender.com:8443",
    "https://core.onrender.com/path",
    "https://core.onrender.com?query=value",
    "https://core.onrender.com#fragment",
  ]) {
    d.ctx.config.apiUrl = apiUrl;
    await assert.rejects(
      () =>
        renderDeploymentLayerTransport({
          config: d.ctx.config,
          configDir: d.ctx.configDir,
          method: "GET",
          body: "",
        }),
      /Render requires apiUrl|Render deployment-layer URL must be/,
    );
  }
  assert.equal(requests, 0);
});

test("Render live checks reject foreign resources and stale URLs before starting a canary", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const core = c.services.get("srv-acme-core")!;
  core.ownerId = "tea-other";
  await assert.rejects(async () => d.backend.checkLive!(), /does not match/);
  core.ownerId = "tea-acme";
  d.ctx.config.apiUrl = "https://other-core.onrender.com";
  await assert.rejects(async () => d.backend.checkLive!(), /URLs do not match/);
  d.ctx.config.apiUrl = core.serviceDetails.url;
  core.slug = "core; unexpected-command";
  await assert.rejects(async () => d.backend.checkLive!(), /invalid private hostname/);
  assert.equal(
    c.calls.some((call) => call.path === "/services/srv-acme-core/jobs"),
    false,
  );
});

test("Render live checks fail on failed and canceled canaries and identify their logs", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  for (const status of ["failed", "canceled"]) {
    c.nextJobStatus = status;
    await assert.rejects(
      async () => d.backend.checkLive!({ report: false }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`job-acmecanary ended with ${status}`));
        assert.match(error.message, /GET \/v1\/logs\?ownerId=tea-acme&resource=job-acmecanary/);
        return true;
      },
    );
  }
  assert.equal(
    c.calls.some((call) => call.path.includes("/jobs/") && call.path.endsWith("/cancel")),
    false,
  );
});

test("Render live checks cancel a job that exceeds the deadline", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  c.nextJobStatus = "running";
  c.intercept = (call) => {
    if (call.path === "/services/srv-acme-core/jobs/job-acmecanary") now += 21 * 60_000;
    return undefined;
  };
  await assert.rejects(
    async () => d.backend.checkLive!({ report: false }),
    /job-acmecanary did not finish within 20 minutes/,
  );
  assert.equal(
    c.calls.filter((call) => call.path.includes("/jobs/") && call.path.endsWith("/cancel") && call.method === "POST")
      .length,
    1,
  );
});

test("Render live checks cancel after a polling failure and report cleanup failures", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.intercept = (call) =>
    call.path === "/services/srv-acme-core/jobs/job-acmecanary" || call.path.endsWith("/cancel")
      ? new Response(null, { status: 503 })
      : undefined;
  await assert.rejects(
    async () => d.backend.checkLive!({ report: false }),
    /job-acmecanary.*HTTP 503.*cancellation failed/,
  );
  assert.equal(
    c.calls.filter((call) => call.path.includes("/jobs/") && call.path.endsWith("/cancel") && call.method === "POST")
      .length,
    1,
  );
});

test("private Render addresses use the workload port", () => {
  assert.equal(
    renderInternalUrl({
      name: "web-ui",
      slug: "qm-web-abcd",
    }),
    "http://qm-web-abcd:8080",
  );
  for (const slug of ["", "web.onrender.com", "web:8080", "web/path", "web; command"])
    assert.throws(() => renderInternalUrl({ name: "web-ui", slug }), /invalid private hostname/);
});

test("Render connects a private web UI to the public portal and copies shared auth secrets", async (t) => {
  const d = deployment(t, true);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const portal = c.envs.get("srv-acme-portal")!;
  const core = c.envs.get("srv-acme-core")!;
  assert.equal(portal.CORE_API_URL, "http://acme-core-assigned:8080");
  assert.equal(c.envs.get("srv-acme-web-ui")!.CORE_API_URL, "http://acme-core-assigned:8080");
  assert.equal(core.PUBLIC_API_URL, "https://acme-core-assigned.onrender.com");
  assert.equal(c.services.get("srv-acme-web-ui")!.type, "private_service");
  assert.equal(portal.WEB_UI_UPSTREAM, "http://acme-web-ui-assigned:8080");
  assert.equal(portal.ADMIN_UPSTREAM, "http://acme-web-ui-assigned:8080/admin");
  assert.equal(d.ctx.config.publicUrl, "https://acme-portal-assigned.onrender.com");
  assert.equal(portal.AUTH_CLIENT_SECRET, portal.OIDC_CLIENT_SECRET);
  assert.equal(portal.CORE_SIGNING_SECRET, core.CORE_SIGNING_SECRET);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_BROWSER, "off");
});

test("Render restores remote drift and grows storage without replacing resources", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const root = c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD;
  c.services.get("srv-acme-core")!.imagePath = "example.com/wrong:latest";
  c.envs.get("srv-acme-core")!.DEPLOY_PROVIDER = "fly";
  d.setCommit("c".repeat(40));
  d.ctx.config.render!.storage.diskSizeGB = 20;
  d.ctx.config.render!.postgresDiskSizeGB = 20;
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-core")!.DEPLOY_PROVIDER, "render");
  assert.equal(c.services.get("srv-acme-minio")!.serviceDetails.disk!.sizeGB, 20);
  assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "a".repeat(40));
  assert.equal(c.database!.diskSizeGB, 20);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, root);
  assert.equal(
    c.calls.slice(mark).some((call) => call.path === "/services" && call.method === "POST"),
    false,
  );
});

test("Render rollback deploys the previous commit with current credentials and stored data", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const release = d.saved().releases[0];
  const secretFile = join(d.ctx.configDir, ".env");
  writeFileSync(
    secretFile,
    readFileSync(secretFile, "utf8").replace(/^CORE_SIGNING_SECRET=.*$/m, `CORE_SIGNING_SECRET=${"f".repeat(64)}`),
  );
  d.setCommit("c".repeat(40));
  await d.backend.up({ dryRun: false });
  const mark = c.calls.length;
  const secret = c.envs.get("srv-acme-minio")!.QM_STORAGE_SECRET_KEY;
  await d.backend.rollback();
  assert.deepEqual(
    writes(c.calls.slice(mark))
      .filter((call) => call.path.endsWith("/deploys"))
      .map((call) => [call.path, call.body]),
    [
      ["/services/srv-acme-core/deploys", { clearCache: "do_not_clear", commitId: release.commit }],
      ["/services/srv-acme-web-ui/deploys", { clearCache: "do_not_clear", commitId: release.commit }],
    ],
  );
  assert.equal(c.envs.get("srv-acme-minio")!.QM_STORAGE_SECRET_KEY, secret);
  assert.equal(c.database?.id, "dpg-acme");
  assert.equal(c.envs.get("srv-acme-core")!.GIT_SHA, d.saved().releases[0].commit);
  assert.equal(c.runtimeEnvs.get("srv-acme-core")!.CORE_SIGNING_SECRET, "f".repeat(64));
  assert.equal(c.runtimeEnvs.get("srv-acme-core")!.GIT_SHA, release.commit);
  assert.equal(c.runtimeEnvs.get("srv-acme-web-ui")!.CORE_SIGNING_SECRET, "f".repeat(64));
});

test("Render rejects a live service built from a different source commit", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path !== "/services/srv-acme-core/deploys" || method !== "POST") return undefined;
    const deploy = { id: "dep-wrong", status: "live", commit: { id: "b".repeat(40) } };
    c.deploys.set("srv-acme-core", deploy);
    c.deploysById.set(deploy.id, deploy);
    return Response.json(deploy);
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /deployed commit b+.*expected a+/);
  assert.equal(d.saved().releases, undefined);
  assert.equal(d.saved().updateInProgress, true);
});

test("Render resumes rollback to the last good release after a partial update", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const successful = d.saved();
  c.intercept = ({ path, method }) =>
    path === "/services/srv-acme-web-ui/deploys" && method === "POST" ? new Response(null, { status: 500 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  assert.equal(d.saved().updateInProgress, true);
  assert.equal(d.saved().releases.length, 1);
  c.intercept = ({ path, method }) =>
    path === "/services/srv-acme-web-ui/deploys" && method === "POST" ? new Response(null, { status: 500 }) : undefined;
  await assert.rejects(async () => d.backend.rollback(), /HTTP 500/);
  assert.ok(d.saved().rollbackProgress.restored.core);
  const mark = c.calls.length;
  c.intercept = undefined;
  await d.backend.rollback();
  assert.deepEqual(
    writes(c.calls.slice(mark))
      .filter((call) => call.path.endsWith("/deploys"))
      .map((call) => [call.path, call.body]),
    [["/services/srv-acme-web-ui/deploys", { clearCache: "do_not_clear", commitId: successful.releases[0].commit }]],
  );
  assert.equal(d.saved().rollbackProgress, undefined);
  assert.equal(d.saved().updateInProgress, undefined);
});

test("Render creates services with a no-op command and cancels the automatic build before pinning", async (t) => {
  const d = deployment(t);
  mkdirSync(join(d.ctx.configDir, "plugins", "reports"), { recursive: true });
  writeFileSync(join(d.ctx.configDir, "plugins", "reports", "Dockerfile"), "FROM node:24\n");
  const c = cloud(t, d);
  const canceled = new Set<string>();
  c.intercept = ({ path, method, body }) => {
    if (method === "POST" && path === "/services") {
      const create = body as {
        envVars: Array<{ key: string }>;
        secretFiles: unknown[];
        serviceDetails: { envSpecificDetails: { dockerCommand: string } };
      };
      assert.ok(create.envVars.some((pair) => pair.key === "PORT"));
      assert.deepEqual(create.secretFiles, []);
      assert.equal(create.serviceDetails.envSpecificDetails.dockerCommand, "/bin/sh -c exit 0");
    }
    const serviceId = path.split("/")[2]!;
    if (path.includes("/deploys/") && path.endsWith("/cancel")) {
      canceled.add(serviceId);
      assert.equal(c.deploys.get(serviceId)!.commit?.id, "b".repeat(40));
    }
    if (method === "POST" && path.endsWith("/deploys")) {
      assert.ok(canceled.has(serviceId));
      assert.equal((body as { commitId: string }).commitId, "a".repeat(40));
      assert.notEqual(c.services.get(serviceId)!.serviceDetails.envSpecificDetails.dockerCommand, "/bin/sh -c exit 0");
    }
    return undefined;
  };
  await d.backend.up({ dryRun: false });
  assert.equal(c.services.size, 4);
  assert.equal(canceled.size, 4);
});

test("Render resumes a suspended service with a no-op command and keeps its credentials across an interrupted resume", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const storage = { ...c.envs.get("srv-acme-minio")! };
  d.setCommit("c".repeat(40));
  await d.backend.down({});
  let interrupted = false;
  c.intercept = ({ path, method }) => {
    if (path === "/services/srv-acme-minio/resume" && method === "POST") {
      assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, storage.MINIO_ROOT_PASSWORD);
      assert.equal(
        c.services.get("srv-acme-minio")!.serviceDetails.envSpecificDetails.dockerCommand,
        "/bin/sh -c exit 0",
      );
    }
    if (path.startsWith("/services/srv-acme-minio/deploys/") && path.endsWith("/cancel") && !interrupted) {
      interrupted = true;
      return new Response(null, { status: 500 });
    }
    return undefined;
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  const recorded = readFileSync(join(d.ctx.configDir, "render.resources.json"), "utf8");
  for (const value of [storage.MINIO_ROOT_PASSWORD!, storage.QM_STORAGE_SECRET_KEY!, "e".repeat(64)])
    assert.ok(!recorded.includes(value));
  const mark = c.calls.length;
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.calls.slice(mark).filter((call) => call.path === "/services/srv-acme-minio/resume").length, 0);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, storage.MINIO_ROOT_PASSWORD);
  assert.equal(c.envs.get("srv-acme-minio")!.QM_STORAGE_SECRET_KEY, storage.QM_STORAGE_SECRET_KEY);
  assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "a".repeat(40));
  assert.equal(c.deploys.get("srv-acme-core")!.commit!.id, "c".repeat(40));
});

test("Render keeps the selected MinIO commit when an interrupted bootstrap retries after the branch moves", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path }) =>
    path.includes("/deploys/") && path.endsWith("/cancel") ? new Response(null, { status: 500 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${"c".repeat(40)}' "$4"\n`);
  c.intercept = undefined;
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  const pinned = c.calls.slice(mark).filter((call) => call.method === "POST" && call.path.endsWith("/deploys"));
  assert.equal(pinned.length, 3);
  assert.deepEqual(
    pinned.map((call) => (call.body as { commitId: string }).commitId),
    ["a".repeat(40), "c".repeat(40), "c".repeat(40)],
  );
  assert.equal(d.saved().releases[0].commit, "c".repeat(40));
  assert.equal(c.envs.get("srv-acme-core")!.GIT_SHA, "c".repeat(40));
});

for (const resource of ["retained", "deleted", "rejected"]) {
  test(`Render ignores an interrupted plugin bootstrap after the plugin is removed and its service is ${resource}`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    await d.backend.up({ dryRun: false });
    const pluginDir = join(d.ctx.configDir, "plugins", "reports");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "Dockerfile"), "FROM node:24\n");
    c.intercept = ({ path, method, body }) => {
      if (resource === "rejected")
        return path === "/services" && method === "POST" && (body as { name: string }).name === "acme-reports"
          ? new Response(null, { status: 400 })
          : undefined;
      return path.startsWith("/services/srv-acme-reports/deploys/") && path.endsWith("/cancel")
        ? new Response(null, { status: 503 })
        : undefined;
    };
    await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 400|HTTP 503/);
    if (resource === "deleted") {
      c.services.delete("srv-acme-reports");
      c.envs.delete("srv-acme-reports");
      c.deploys.delete("srv-acme-reports");
    }
    rmSync(pluginDir, { recursive: true });
    c.intercept = undefined;
    for (const commit of ["c".repeat(40), "d".repeat(40)]) {
      writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${commit}' "$4"\n`);
      const mark = c.calls.length;
      await hostingProvider("render").createBackend(d.ctx).up({ dryRun: false });
      const calls = c.calls.slice(mark);
      const deploys = calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys"));
      assert.deepEqual(
        deploys.map((call) => (call.body as { commitId: string }).commitId),
        [commit, commit],
      );
      assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "a".repeat(40));
      assert.equal(d.saved().releases[0].commit, commit);
      assert.equal(d.saved().pendingCreate, undefined);
      assert.equal(Boolean(d.saved().services.reports), resource === "retained");
      assert.equal(
        calls.some((call) => call.method !== "GET" && call.path.includes("srv-acme-reports")),
        false,
      );
    }
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "Dockerfile"), "FROM node:24\n");
    const commit = "e".repeat(40);
    writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${commit}' "$4"\n`);
    const mark = c.calls.length;
    await d.backend.up({ dryRun: false });
    const calls = c.calls.slice(mark);
    assert.equal(d.saved().releases[0].commit, commit);
    const deploys = calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys"));
    assert.deepEqual(
      deploys.map((call) => (call.body as { commitId: string }).commitId),
      [commit, commit, commit],
    );
    assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "a".repeat(40));
    assert.equal(
      calls.filter((call) => call.method === "POST" && call.path === "/services").length,
      resource === "retained" ? 0 : 1,
    );
    assert.equal(c.deploys.get("srv-acme-reports")!.status, "live");
  });
}

test("Render retries a rejected resume without losing retained storage credentials", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const password = c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD;
  await d.backend.down({});
  c.intercept = ({ path }) =>
    path === "/services/srv-acme-minio/resume" ? new Response(null, { status: 429 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 429/);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, password);
});

test("Render retries a resume after a lost connection and retains storage credentials", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const storage = { ...c.envs.get("srv-acme-minio")! };
  await d.backend.down({});
  c.intercept = ({ path, method }) => {
    if (path !== "/services/srv-acme-minio/resume" || method !== "POST") return undefined;
    throw new TypeError("connection closed");
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /connection closed/);
  assert.equal(c.services.get("srv-acme-minio")!.suspended, "suspended");
  c.intercept = undefined;
  const backend = hostingProvider("render").createBackend(d.ctx);
  await backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, storage.MINIO_ROOT_PASSWORD);
  assert.equal(c.envs.get("srv-acme-minio")!.QM_STORAGE_SECRET_KEY, storage.QM_STORAGE_SECRET_KEY);
  assert.equal(c.calls.filter((call) => call.path === "/services/srv-acme-minio/resume").length, 2);
  await backend.down({ purge: true });
  assert.equal(c.services.size, 0);
  assert.equal(c.database, undefined);
});

test("Render records a service after its creation reply is lost and ignores same-named services elsewhere", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const core = c.services.get("srv-acme-core")!;
  c.services.set("srv-elsewhere", { ...core, id: "srv-elsewhere", environmentId: "evm-other" });
  const state = d.saved();
  delete state.services.core;
  state.pendingCreate = { collection: "services", name: "acme-core" };
  writeFileSync(join(d.ctx.configDir, "render.resources.json"), JSON.stringify(state));
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(d.saved().pendingCreate, undefined);
  assert.deepEqual(d.saved().services.core, { id: "srv-acme-core", name: "acme-core", type: "web_service" });
  assert.equal(c.calls.slice(mark).filter((call) => call.method === "POST" && call.path === "/services").length, 0);
});

test("Render rollback --to deploys a retained release by label, commit prefix, or deploy ID", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.setCommit("c".repeat(40));
  await d.backend.up({ dryRun: false });
  d.setCommit("d".repeat(40));
  await d.backend.up({ dryRun: false });
  const [third, second, first] = d.saved().releases as Array<{
    label: string;
    commit: string;
    services: Record<string, string>;
  }>;
  assert.deepEqual(
    [first!, second!, third!].map((release) => [release.label, release.commit[0]]),
    [
      ["r1", "a"],
      ["r2", "c"],
      ["r3", "d"],
    ],
  );
  const restores = (mark: number) =>
    writes(c.calls.slice(mark))
      .filter((call) => call.path.endsWith("/deploys"))
      .map((call) => [call.path, (call.body as { commitId: string }).commitId]);
  let mark = c.calls.length;
  await d.backend.rollback("r1");
  assert.deepEqual(restores(mark), [
    ["/services/srv-acme-core/deploys", first!.commit],
    ["/services/srv-acme-web-ui/deploys", first!.commit],
  ]);
  assert.equal(c.envs.get("srv-acme-core")!.GIT_SHA, "a".repeat(40));
  assert.equal(d.saved().releases[0].label, "r4");
  assert.equal(d.saved().releases[0].commit, "a".repeat(40));
  mark = c.calls.length;
  await d.backend.rollback("c".repeat(7));
  assert.deepEqual(restores(mark)[0], ["/services/srv-acme-core/deploys", second!.commit]);
  assert.equal(d.saved().releases[0].label, "r5");
  mark = c.calls.length;
  await d.backend.rollback(third!.services["web-ui"]!);
  assert.deepEqual(restores(mark)[0], ["/services/srv-acme-core/deploys", third!.commit]);
  assert.equal(c.envs.get("srv-acme-core")!.GIT_SHA, "d".repeat(40));
  assert.equal(d.saved().releases.length, 6);
});

test("Render rollback --to rejects unknown, ambiguous, and short targets and lists the releases", async (t) => {
  const d = deployment(t);
  cloud(t, d);
  await d.backend.up({ dryRun: false });
  await d.backend.up({ dryRun: false });
  await assert.rejects(
    async () => d.backend.rollback("r9"),
    /not a release label, commit, or deploy ID\. Retained releases: r2 \(aaaaaaa, .*\), r1/,
  );
  await assert.rejects(
    async () => d.backend.rollback("dep-nope"),
    /No retained Render release contains deploy dep-nope/,
  );
  await assert.rejects(
    async () => d.backend.rollback("a".repeat(7)),
    /matches several retained releases; use a release label/,
  );
  await assert.rejects(async () => d.backend.rollback("f".repeat(7)), /give the full 40-character commit to build it/);
  assert.equal(d.saved().rollbackProgress, undefined);
});

test("Render rollback --to builds a full commit that no retained release recorded", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const mark = c.calls.length;
  await d.backend.rollback("f".repeat(40));
  const written = writes(c.calls.slice(mark));
  assert.equal(
    written.some((call) => call.path.endsWith("/rollback")),
    false,
  );
  assert.deepEqual(
    written.filter((call) => call.path.endsWith("/deploys")).map((call) => [call.path, call.body]),
    ["core", "web-ui"].map((name) => [
      `/services/srv-acme-${name}/deploys`,
      { clearCache: "do_not_clear", commitId: "f".repeat(40) },
    ]),
  );
  assert.equal(c.envs.get("srv-acme-core")!.GIT_SHA, "f".repeat(40));
  const [latest, previous] = d.saved().releases;
  assert.equal(latest.label, "r2");
  assert.equal(latest.commit, "f".repeat(40));
  assert.deepEqual(Object.keys(latest.services).sort(), ["core", "web-ui"]);
  assert.equal(previous.label, "r1");
});

test("Render rollback can rebuild a release after its provider deploy record is gone", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.setCommit("c".repeat(40));
  await d.backend.up({ dryRun: false });
  const first = d.saved().releases[1];
  c.deploysById.delete(first.services["web-ui"]);
  const mark = c.calls.length;
  await d.backend.rollback("r1");
  assert.equal(
    c.calls.slice(mark).some((call) => call.path.endsWith(`/${first.services["web-ui"]}`)),
    false,
  );
  assert.equal(d.saved().rollbackProgress, undefined);
  assert.equal(c.deploys.get("srv-acme-web-ui")!.commit!.id, first.commit);
});

test("Render rollback keeps every release and can replace an incomplete target", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  for (let index = 0; index < 12; index++) {
    d.setCommit(index.toString(16).repeat(40).slice(0, 40));
    await d.backend.up({ dryRun: false });
  }
  const labels = d.saved().releases.map((release: { label: string }) => release.label);
  assert.deepEqual(labels, ["r12", "r11", "r10", "r9", "r8", "r7", "r6", "r5", "r4", "r3", "r2", "r1"]);
  const lines: string[] = [];
  const log = t.mock.method(console, "log", (message: string) => void lines.push(String(message)));
  await d.backend.status();
  log.mock.restore();
  assert.ok(
    lines.some((line) => /^release r12 \(bbbbbbb, .*\) latest$/.test(line)),
    lines.join("\n"),
  );
  assert.equal(lines.filter((line) => line.startsWith("release r")).length, 12);
  c.intercept = ({ path, method }) =>
    path === "/services/srv-acme-web-ui/deploys" && method === "POST" ? new Response(null, { status: 500 }) : undefined;
  await assert.rejects(async () => d.backend.rollback("r5"), /HTTP 500/);
  assert.equal(d.saved().rollbackProgress.label, "r5");
  c.intercept = undefined;
  await d.backend.rollback("r4");
  assert.equal(d.saved().rollbackProgress, undefined);
  assert.equal(d.saved().releases[0].label, "r13");
  assert.equal(d.saved().releases[0].commit, "3".repeat(40));
  assert.equal(c.deploys.get("srv-acme-core")!.commit!.id, "3".repeat(40));
  assert.equal(c.deploys.get("srv-acme-web-ui")!.commit!.id, "3".repeat(40));
});

test("Render accepts a corrected target after a rejected rollback request", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.intercept = ({ path, method, body }) =>
    path.endsWith("/deploys") && method === "POST" && (body as { commitId: string }).commitId === "f".repeat(40)
      ? new Response("Commit is not available", { status: 400 })
      : undefined;
  await assert.rejects(async () => d.backend.rollback("f".repeat(40)), /HTTP 400.*Commit is not available/);
  c.intercept = undefined;
  await hostingProvider("render").createBackend(d.ctx).rollback("r1");
  assert.equal(d.saved().rollbackProgress, undefined);
  assert.equal(c.runtimeEnvs.get("srv-acme-core")!.GIT_SHA, "a".repeat(40));
  await d.backend.up({ dryRun: false });
});

test("Render preflight rejects a source-only plugin with the bundled storage name", (t) => {
  const d = deployment(t);
  const plugin = join(d.ctx.configDir, "plugins", "minio");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "Dockerfile"), "FROM node:24\n");
  assert.throws(
    () => runChecks(d.ctx.config, d.ctx.configDir, d.ctx.sandboxDir, { report: false }),
    /plugin minio conflicts/,
  );
});

test("Render branch resolution keeps Git diagnostics before cloud changes", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  writeFileSync(
    join(d.ctx.configDir, "bin", "git"),
    "#!/bin/sh\nprintf 'fatal: could not resolve host review.invalid\\n' >&2\nexit 128\n",
  );
  await assert.rejects(
    d.backend.up({ dryRun: false }),
    /Cannot resolve Render Git branch.*fatal: could not resolve host review.invalid/s,
  );
  assert.deepEqual(c.calls, []);
});

test("Render deployment accepts a Git ref that contains non-breaking space", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  d.ctx.config.render!.source.branch = "fix/non\u00a0breaking";
  await d.backend.up({ dryRun: false });
  assert.equal(c.services.get("srv-acme-core")!.branch, d.ctx.config.render!.source.branch);
  assert.equal(c.runtimeEnvs.get("srv-acme-core")!.GIT_SHA, "a".repeat(40));
});
