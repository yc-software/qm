import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigAt, type QmConfig } from "../src/config.ts";
import { derivedTomlFor } from "../src/backends/fly.ts";
import { tenantSettingsEnv } from "../src/tenant-settings.ts";
import { serviceUrlEnv as contractServiceUrlEnv } from "../src/contract.ts";
import { serviceUrlEnv, runnableServices } from "../src/services.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("acme fly config derives the packaged cli/templates/fly/<svc>.toml byte-for-byte", () => {
  const { config } = loadConfigAt(join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"));
  for (const svc of runnableServices(config.services)) {
    const derived = derivedTomlFor(config, svc, repoRoot);
    const template = readFileSync(join(repoRoot, "cli", "templates", "fly", `${svc}.toml`), "utf8");
    assert.equal(derived, template, `derived ${svc} fly.toml diverged from cli/templates/fly/${svc}.toml`);
  }
});

test("Fly edge and harness defaults can sustain the 16-worker baseline and drain like core", () => {
  const { config } = loadConfigAt(join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"));
  for (const workload of ["edge", "harness"] as const) {
    const toml = derivedTomlFor(config, workload, repoRoot);
    assert.match(toml, /\[\[restart\]\]\n\s*policy = "always"/);
    assert.match(toml, /\[\[vm\]\]\n\s*size = "performance-2x"\n\s*memory = "4gb"/);
    assert.match(toml, /^kill_timeout = "300s"$/m);
    assert.match(
      toml,
      /\[checks\.health\]\n\s*type = "http"\n\s*port = 8080\n\s*method = "get"\n\s*path = "\/healthz"/,
    );
  }
});

test("each Fly app runs its own entry point from the one core image", () => {
  const { config } = loadConfigAt(join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"));
  const edge = derivedTomlFor(config, "edge", repoRoot);
  const harness = derivedTomlFor(config, "harness", repoRoot);
  assert.match(edge, /^app = "qm-core"$/m, "the edge keeps the core app, its IPs, and its internal name");
  assert.match(edge, /\[processes\]\n {2}app = "node src\/edge\/main\.ts"/);
  assert.match(harness, /^app = "qm-harness"$/m);
  assert.match(harness, /\[processes\]\n {2}app = "node src\/harness\/main\.ts"/);
  assert.doesNotMatch(harness, /http_service|\[\[services\]\]/, "the harness has no ingress");
  assert.equal(derivedTomlFor(config, "harness", repoRoot), harness, "derivation is stable");
});

test("web-ui serves at the root in both shapes — publicUrl IS the web-ui URL (no /web-ui suffix)", () => {
  const url = "https://acme-web-ui.fly.dev";
  assert.equal(serviceUrlEnv("core", url, false).WEB_UI_PUBLIC_URL, url);
  assert.equal(serviceUrlEnv("web-ui", url, false).WEB_UI_PUBLIC_URL, url);
  assert.equal(serviceUrlEnv("core", `${url}/`, true).WEB_UI_PUBLIC_URL, url);
  assert.equal(serviceUrlEnv("web-ui", url, true).WEB_UI_PUBLIC_URL, url);
  assert.equal(serviceUrlEnv("admin", url, true).ADMIN_BASE_PATH, "/admin");
  assert.equal(serviceUrlEnv("admin", url, false).ADMIN_BASE_PATH, undefined);
});

test("brand reaches auth as AUTH_BRAND_NAME only when configured and never reaches core env", () => {
  const url = "https://acme-web-ui.fly.dev";
  const brand = { botName: "straylight", orgName: "Acme Corp" };
  const core = serviceUrlEnv("core", url, false, brand);
  assert.equal(core.ORG_BRAND_SELF_LABEL, undefined);
  assert.equal(core.ORG_BRAND_ORG_NAME, undefined);
  assert.equal(serviceUrlEnv("auth", url, false, brand).AUTH_BRAND_NAME, "straylight");
  const bare = serviceUrlEnv("core", url, false);
  assert.equal(bare.ORG_BRAND_SELF_LABEL, undefined);
  assert.equal(bare.ORG_BRAND_ORG_NAME, undefined);
  assert.equal(serviceUrlEnv("auth", url, false).AUTH_BRAND_NAME, undefined);
  assert.equal(serviceUrlEnv("web-ui", url, false, brand).ORG_BRAND_SELF_LABEL, undefined);
});

test("the contract's serviceUrlEnv keeps its per-service outputs", () => {
  const url = "https://agent.example.com";
  const brand = { botName: "straylight", orgName: "Acme Corp" };
  assert.equal(contractServiceUrlEnv, serviceUrlEnv);
  assert.deepEqual(contractServiceUrlEnv("core", `${url}/`, true, brand), {
    PUBLIC_WEB_URL: url,
    WEB_UI_PUBLIC_URL: url,
  });
  assert.deepEqual(contractServiceUrlEnv("portal", url, true, brand), {
    PORTAL_PUBLIC_URL: url,
    AUTH_BRAND_NAME: "straylight",
  });
  assert.deepEqual(contractServiceUrlEnv("web-ui", url, true), { WEB_UI_PUBLIC_URL: url, ADMIN_BASE_PATH: "/admin" });
  assert.deepEqual(contractServiceUrlEnv("admin", url, true), { ADMIN_BASE_PATH: "/admin" });
  assert.deepEqual(contractServiceUrlEnv("admin", url, false), {});
  assert.deepEqual(contractServiceUrlEnv("auth", url, true, brand), { AUTH_BRAND_NAME: "straylight" });
  assert.deepEqual(contractServiceUrlEnv("egress-proxy", url, true), {});
});

const imageFromStack = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "imagefrom-stack.json");

test("an imageFrom stack reuses the reference images and overrides only its own keys", () => {
  const { config } = loadConfigAt(imageFromStack);
  assert.equal(config.imageFrom, "qm");
  const coreToml = derivedTomlFor(config, "edge", repoRoot);
  assert.match(coreToml, /app = "beta-core"/);
  assert.doesNotMatch(coreToml, /ORG_ID/);
  assert.match(coreToml, /PUBLIC_WEB_URL = "https:\/\/beta-portal\.fly\.dev"/);
  assert.match(coreToml, /STACK_MARKER = "beta-sandboxes"/);
});

const exampleFlyConfig = (): QmConfig => ({
  contract: 1,
  deploymentId: "example",
  publicUrl: "https://example.invalid",
  target: "fly",
  model: "example-model",
  appPrefix: "example-stack",
  region: "ord",
  flyOrg: "example-org",
  sandbox: {
    app: "example-sandboxes",
  },
  services: ["core", "admin", "web-ui", "portal"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
});

test("a configured bot identity reaches the derived edge fly toml only as the sign-in brand", () => {
  const config = { ...exampleFlyConfig(), botName: "straylight", orgName: "Straylight Industries" };
  const edge = derivedTomlFor(config, "edge", repoRoot);
  assert.doesNotMatch(edge, /ORG_BRAND/);
  assert.match(edge, /^\s*AUTH_BRAND_NAME = "straylight"$/m);
  assert.equal(tenantSettingsEnv(config, new Map()).ORG_BRAND_ORG_NAME, "Straylight Industries");
  const bare = derivedTomlFor(exampleFlyConfig(), "edge", repoRoot);
  assert.doesNotMatch(bare, /ORG_BRAND_SELF_LABEL|AUTH_BRAND_NAME/);
  const harness = derivedTomlFor(config, "harness", repoRoot);
  assert.doesNotMatch(harness, /ORG_BRAND|AUTH_BRAND_NAME/);
});

test("derived Fly configs contain only the deployment's region, org, sandbox, and portal policy", () => {
  const config = exampleFlyConfig();
  const core = derivedTomlFor(config, "edge", repoRoot);

  assert.match(core, /^primary_region = "ord"$/m);
  assert.match(core, /^\s*ADMIN_ENABLED = "1"$/m);
  assert.match(core, /^\s*FLY_ORG = "example-org"$/m);
  assert.doesNotMatch(core, /PI_MODEL/);
  assert.equal(tenantSettingsEnv(config, new Map()).PI_MODEL, "example-model");
  assert.match(core, /^\s*QM_DEPLOYMENT_ID = "qm-v2:example-org:example:example-stack"$/m);
  assert.doesNotMatch(core, /PI_DETECT_MODEL/);
  assert.doesNotMatch(core, /OIDC_ALLOWED_EMAIL_DOMAIN/);
});

test("the edge gets public ingress on its public port only when the deployment has a portal", () => {
  const withPortal = derivedTomlFor(exampleFlyConfig(), "edge", repoRoot);
  assert.match(withPortal, /^\[http_service\]\n {2}internal_port = 8000$/m);
  assert.match(withPortal, /^\s*PUBLIC_PORT = "8000"$/m);
  const coreOnly = derivedTomlFor({ ...exampleFlyConfig(), services: ["core", "slack"] }, "edge", repoRoot);
  assert.doesNotMatch(coreOnly, /http_service|PUBLIC_PORT|PORTAL_PUBLIC_URL/);
  assert.match(coreOnly, /\[checks\.health\]\n\s*type = "http"\n\s*port = 8080/);
});

test("virtual-service env folds into the edge [env] only (core's own block wins)", () => {
  const { config } = loadConfigAt(imageFromStack);
  const coreToml = derivedTomlFor(config, "edge", repoRoot);
  assert.match(
    coreToml,
    /WEB_UI_PUBLIC_URL = "https:\/\/beta-portal\.fly\.dev"/,
    "env.slack reaches the in-process slack surface on core",
  );
  const coreWins = {
    ...config,
    env: { ...config.env, core: { ...config.env.core, WEB_UI_PUBLIC_URL: "https://core-wins.example.com" } },
  };
  assert.match(derivedTomlFor(coreWins, "edge", repoRoot), /WEB_UI_PUBLIC_URL = "https:\/\/core-wins\.example\.com"/);
  assert.match(
    derivedTomlFor(coreWins, "harness", repoRoot),
    /WEB_UI_PUBLIC_URL = "https:\/\/core-wins\.example\.com"/,
  );
});

test("a vms.core override sizes edge and harness, and a per-workload entry wins", () => {
  const { config } = loadConfigAt(imageFromStack);
  for (const workload of ["edge", "harness"] as const) {
    const toml = derivedTomlFor(config, workload, repoRoot);
    assert.match(toml, /\[\[vm\]\]\n\s*size = "shared-cpu-2x"\n\s*memory = "4gb"/);
    assert.doesNotMatch(toml, /size = "shared-cpu-1x"/);
  }
  const split = { ...config, vms: { ...config.vms, harness: { size: "performance-4x", memory: "8gb" } } };
  assert.match(derivedTomlFor(split, "harness", repoRoot), /size = "performance-4x"\n\s*memory = "8gb"/);
  assert.match(derivedTomlFor(split, "edge", repoRoot), /size = "shared-cpu-2x"\n\s*memory = "4gb"/);
});
