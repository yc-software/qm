import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfigAt, parseConfigJson, renderSource } from "../src/config.ts";
import { renderScaffold } from "../src/provider-scaffold.ts";
import { renderConfigErrors } from "../src/backends/render.ts";
import { discoverPlugins } from "../src/plugins.ts";
import { renderServiceEnv, renderWorkloads } from "../src/render-services.ts";
import { computedSecrets, FIRST_PARTY_SECRET_SPECS, managedByFor } from "../src/secrets.ts";

interface ScaffoldConfig {
  render: Record<string, unknown>;
  env: { core: Record<string, string> };
  plugins?: Record<string, unknown>[];
}

function deployment(t: TestContext, change?: (raw: ScaffoldConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), "qm-render-services-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = parseConfigJson(
    renderScaffold.renderConfig("acme", "anthropic", "resend", { repo: "https://github.com/acme/qm", branch: "main" }),
  ) as ScaffoldConfig;
  change?.(raw);
  const path = join(dir, "qm.config.jsonc");
  writeFileSync(path, JSON.stringify(raw));
  return { dir, path, raw, config: loadConfigAt(path).config };
}

const connections = {
  databaseUrl: "postgres://qm:password@postgres/qm",
  coreUrl: "http://core-assigned:8080",
  webUiUrl: "http://web-ui:8080",
  projectId: "prj-acme",
  environmentId: "evm-production",
};

test("Render rejects services that require TCP ingress", (t) => {
  const { config } = deployment(t);
  config.services.push("egress-proxy");
  assert.ok(
    renderConfigErrors(config, []).some(
      (error) => error.message === "Render hosting does not support TCP ingress for egress-proxy",
    ),
  );
});

test("Render Git source accepts GitHub repositories and branch names without credentials", () => {
  assert.deepEqual(renderSource({ repo: "https://github.com/acme/qm.git/", branch: "feature/render" }, "config"), {
    repo: "https://github.com/acme/qm",
    branch: "feature/render",
  });
  for (const source of [
    {},
    { repo: "https://github.com/acme/qm" },
    { repo: "https://github.com/acme/qm", branch: "main", commit: "a" },
    ...[
      "http://github.com/acme/qm",
      "git@github.com:acme/qm.git",
      "https://token@github.com/acme/qm",
      "https://github.com/acme/qm?token=secret",
      "https://github.com/acme/..",
      "https://github.com/acme/qm/tree/main",
      "https://other.test/acme/qm",
    ].map((repo) => ({ repo, branch: "main" })),
    ...[
      "",
      "bad branch",
      "-main",
      "../main",
      "main..next",
      "feature//name",
      "main.lock",
      "feature/.hidden",
      "main@{1}",
      "main\nnext",
      "main*",
      "main\\next",
      "main/",
      "main.",
    ].map((branch) => ({ repo: "https://github.com/acme/qm", branch })),
  ])
    assert.throws(() => renderSource(source, "config"), /render.source/);
});

test("Render uses Git builds for all services and rejects image overrides", (t) => {
  const { config, dir } = deployment(t);
  const workloads = renderWorkloads(config, dir);
  assert.deepEqual(
    workloads.find((workload) => workload.name === "core"),
    { name: "core", source: config.render!.source, dockerfile: "deploy/core/Dockerfile" },
  );
  assert.ok(workloads.every((workload) => workload.source));
  const core = renderServiceEnv(config, "core", new Map(), connections);
  assert.equal(core.RENDER_DEPLOY_REPO, config.render!.source.repo);
  assert.equal(core.RENDER_DEPLOY_BRANCH, "main");
  assert.equal(config.render!.appRegion, undefined);
  assert.equal(core.RENDER_APP_REGION, config.render!.region);
  config.imageOverrides.core = "example.test/core:custom";
  assert.ok(renderConfigErrors(config, []).some((error) => /remove imageOverrides/.test(error.message)));
});

test("Render core starts sandboxes from the configured base image and refuses the unpublished placeholder", (t) => {
  const image = `ghcr.io/yc-software/qm/sandbox-base:${"c".repeat(40)}@sha256:${"d".repeat(64)}`;
  const { config } = deployment(t, (raw) => Object.assign(raw, { sandbox: { backend: "render", baseImage: image } }));
  assert.equal(renderServiceEnv(config, "core", new Map(), connections).RENDER_SANDBOX_IMAGE, image);
  assert.ok(!renderConfigErrors(config, []).some((error) => /sandbox.baseImage/.test(error.message)));
  delete config.sandbox!.baseImage;
  assert.match(renderServiceEnv(config, "core", new Map(), connections).RENDER_SANDBOX_IMAGE!, /^registry\.invalid\//);
  assert.ok(
    renderConfigErrors(config, []).some((error) =>
      /pins no published sandbox base image; set sandbox.baseImage/.test(error.message),
    ),
  );
  for (const baseImage of [
    image.replace(/:c+@/, "@"),
    image.replace(/:c+@/, ":@"),
    image.replace(/d{64}$/, "D".repeat(64)),
  ]) {
    const { config: invalid } = deployment(t, (raw) =>
      Object.assign(raw, { sandbox: { backend: "render", baseImage } }),
    );
    assert.ok(
      renderConfigErrors(invalid, []).some((error) =>
        /Render sandbox.baseImage must be <repository>:<tag>@sha256:<64 hex digits>/.test(error.message),
      ),
    );
  }
  const { config: stray } = deployment(t, (raw) =>
    Object.assign(raw, { sandbox: { backend: "render", baseImage: image, env: { FOO: "bar" } } }),
  );
  assert.ok(renderConfigErrors(stray, []).some((error) => /Render sandboxes ignore sandbox.env/.test(error.message)));
});

test("Render init selects managed MinIO without generated infrastructure files or storage inputs", (t) => {
  const { config } = deployment(t);
  assert.deepEqual(config.render?.storage, { plan: "0.5c-512mb", diskSizeGB: 10 });
  assert.deepEqual(
    renderScaffold.files(config).map((file) => file.segments),
    [["sandbox", "skills", "render-platform", "SKILL.md"]],
  );
  const secrets = computedSecrets(config);
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"])
    assert.equal(
      secrets.some((secret) => secret.name === key),
      false,
    );
});

test("Render appRegion accepts supported regions without changing the core region", (t) => {
  const { path, raw } = deployment(t);
  for (const appRegion of ["oregon", "ohio", "virginia", "frankfurt", "singapore"]) {
    writeFileSync(path, JSON.stringify({ ...raw, render: { ...raw.render, appRegion } }));
    const config = loadConfigAt(path).config;
    assert.equal(config.render!.appRegion, appRegion);
    assert.equal(config.render!.region, "oregon");
    const core = renderServiceEnv(config, "core", new Map(), connections);
    assert.equal(core.RENDER_APP_REGION, appRegion);
    assert.equal(core.RENDER_REGION, "oregon");
    assert.equal(renderServiceEnv(config, "web-ui", new Map(), connections).RENDER_APP_REGION, undefined);
  }
  for (const appRegion of ["us-east-1", "Virginia", "", null, 3, {}]) {
    writeFileSync(path, JSON.stringify({ ...raw, render: { ...raw.render, appRegion } }));
    assert.throws(() => loadConfigAt(path), /render.appRegion must be a Render region/);
  }
});

test("Render core receives scoped storage credentials and assigned URLs", (t) => {
  const { config } = deployment(t);
  config.apiUrl = "https://core-assigned.onrender.com";
  config.publicUrl = "https://portal-assigned.onrender.com";
  const values = new Map([
    ["MINIO_ROOT_USER", "root-user"],
    ["MINIO_ROOT_PASSWORD", "root-secret"],
    ["AWS_SESSION_TOKEN", "old-token"],
    ["CORE_SIGNING_SECRET", "qm-signing-key"],
  ]);
  const wired = {
    ...connections,
    storage: { endpoint: "https://minio-assigned.onrender.com", secretKey: "scoped-secret" },
  };
  const core = renderServiceEnv(config, "core", values, wired);
  assert.equal(core.AWS_ACCESS_KEY_ID, "qm-storage");
  assert.equal(core.AWS_SECRET_ACCESS_KEY, "scoped-secret");
  assert.equal(core.AWS_ENDPOINT_URL_S3, "https://minio-assigned.onrender.com");
  assert.equal(core.AWS_SESSION_TOKEN, "");
  assert.equal(core.S3_BUCKET, "qm-storage");
  assert.equal(core.RENDER_PROJECT_ID, connections.projectId);
  assert.equal(core.RENDER_ENVIRONMENT_ID, connections.environmentId);
  assert.equal(core.PUBLIC_API_URL, config.apiUrl);
  assert.equal(core.PUBLIC_WEB_URL, config.publicUrl);
  assert.equal(core.DATABASE_URL, connections.databaseUrl);
  assert.equal(core.CORE_SIGNING_SECRET, "qm-signing-key");
  assert.equal(core.WORKERS, undefined);
  assert.equal(core.WORKSPACE_STORE, "postgres");
  for (const service of ["core", "web-ui", "portal"]) {
    const env = renderServiceEnv(config, service, values, wired);
    assert.equal(env.CORE_API_URL, connections.coreUrl);
    assert.equal(env.MINIO_ROOT_USER, undefined);
    assert.equal(env.MINIO_ROOT_PASSWORD, undefined);
    if (service !== "core") {
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    }
  }
  const portal = renderServiceEnv(config, "portal", values, connections);
  assert.equal(portal.OIDC_ISSUER, `${config.publicUrl}/idp`);
  assert.equal(portal.AUTH_REDIRECT_URI, `${config.publicUrl}/auth/callback`);
  assert.equal(portal.ADMIN_UPSTREAM, "http://web-ui:8080/admin");
  assert.equal(renderServiceEnv(config, "slack", values, connections).PUBLIC_API_URL, config.apiUrl);
});

test("Render supplies core every secret that the specs mark as Render-managed and rejects overrides", (t) => {
  const { config } = deployment(t);
  const core = renderServiceEnv(config, "core", new Map(), connections);
  for (const { name } of FIRST_PARTY_SECRET_SPECS.filter((spec) => managedByFor(spec, "render") === "render")) {
    assert.ok(core[name], name);
    config.secretEnv = { core: { [name]: name } };
    assert.ok(
      renderConfigErrors(config, []).some(
        (error) => error.message === `Render derives core ${name}; remove its secretEnv entry`,
      ),
      name,
    );
  }
});

test("Render rejects prebuilt plugin images", (t) => {
  const { config, dir } = deployment(t, (raw) => {
    raw.plugins = [{ name: "reports", image: "example.test/reports:1" }];
  });
  const plugins = discoverPlugins(dir, config).plugins;
  assert.ok(renderConfigErrors(config, plugins).some((error) => /Git source Dockerfiles/.test(error.message)));
});

test("removing hosted auth, admin, and Slack resets their managed settings", (t) => {
  const { config } = deployment(t);
  config.services = config.services.filter((service) => !["auth", "admin", "slack"].includes(service));
  config.env.portal = { OIDC_ISSUER: "https://idp.example.test" };
  const core = renderServiceEnv(config, "core", new Map(), connections);
  for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET", "AUTH_ALLOWED_EMAIL_DOMAIN"])
    assert.equal(core[key], "");
  const portal = renderServiceEnv(config, "portal", new Map(), connections);
  assert.equal(portal.AUTH_EMBEDDED, "0");
  assert.equal(portal.AUTH_BROKER_UPSTREAM, "");
  assert.equal(portal.ADMIN_UPSTREAM, "");
  assert.equal(portal.OIDC_ISSUER, "https://idp.example.test");
  assert.equal(portal.OIDC_ALLOWED_EMAIL_DOMAIN, "");
});

test("removing an embedded auth domain clears the core and broker allowlists", (t) => {
  const { config } = deployment(t);
  config.env.auth = { AUTH_ALLOWED_EMAIL_DOMAIN: "example.test" };
  assert.equal(renderServiceEnv(config, "core", new Map(), connections).AUTH_ALLOWED_EMAIL_DOMAIN, "example.test");
  delete config.env.auth.AUTH_ALLOWED_EMAIL_DOMAIN;
  const core = renderServiceEnv(config, "core", new Map(), connections);
  const portal = renderServiceEnv(config, "portal", new Map(), connections);
  assert.equal(core.AUTH_ALLOWED_EMAIL_DOMAIN, "");
  assert.equal(portal.AUTH_ALLOWED_EMAIL_DOMAIN, "");
  assert.equal(portal.OIDC_ALLOWED_EMAIL_DOMAIN, "");
});

test("Render storage validates settings and reserves bundled resource names", (t) => {
  const { dir, path, raw } = deployment(t);
  for (const storage of [
    { type: "other" },
    { type: "external", diskSizeGB: 10 },
    { type: "minio", plan: "free" },
    { type: "minio", diskSizeGB: 0 },
    { type: "minio", diskSizeGB: 1.5 },
  ]) {
    writeFileSync(path, JSON.stringify({ ...raw, render: { ...raw.render, storage } }));
    assert.throws(() => loadConfigAt(path), /render.storage/);
  }
  writeFileSync(path, JSON.stringify({ ...raw, plugins: [{ name: "minio", image: "example.test/plugin:1" }] }));
  const config = loadConfigAt(path).config;
  assert.ok(
    renderConfigErrors(config, discoverPlugins(dir, config).plugins).some(
      (error) => error.message === "Render plugin minio conflicts with the bundled Render minio service",
    ),
  );
});
