import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigAt, type QmConfig } from "../src/config.ts";
import { derivedTomlFor } from "../src/backends/fly.ts";
import { orgEnv, runnableServices } from "../src/services.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("acme fly config derives the checked-in deploy/<svc>/fly.toml byte-for-byte", () => {
  const { config } = loadConfigAt(join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"));
  for (const svc of runnableServices(config.services)) {
    const derived = derivedTomlFor(config, svc, repoRoot);
    const checkedIn = readFileSync(join(repoRoot, "deploy", svc, "fly.toml"), "utf8");
    assert.equal(derived, checkedIn, `derived ${svc} fly.toml diverged from deploy/${svc}/fly.toml`);
  }
});

test("web-ui serves at the root in both shapes — publicUrl IS the web-ui URL (no /web-ui suffix)", () => {
  const url = "https://acme-web-ui.fly.dev";
  assert.equal(orgEnv("core", "acme", url, false).WEB_UI_PUBLIC_URL, url);
  assert.equal(orgEnv("web-ui", "acme", url, false).WEB_UI_PUBLIC_URL, url);
  assert.equal(orgEnv("core", "acme", `${url}/`, true).WEB_UI_PUBLIC_URL, url);
  assert.equal(orgEnv("web-ui", "acme", url, true).WEB_UI_PUBLIC_URL, url);
  assert.equal(orgEnv("admin", "acme", url, true).ADMIN_BASE_PATH, "/admin");
  assert.equal(orgEnv("admin", "acme", url, false).ADMIN_BASE_PATH, undefined);
});

test("brand env reaches core as ORG_BRAND_* and auth as AUTH_BRAND_NAME, and only when configured", () => {
  const url = "https://acme-web-ui.fly.dev";
  const brand = { botName: "straylight", orgName: "Acme Corp" };
  const core = orgEnv("core", "acme", url, false, brand);
  assert.equal(core.ORG_BRAND_SELF_LABEL, "straylight");
  assert.equal(core.ORG_BRAND_ORG_NAME, "Acme Corp");
  assert.equal(orgEnv("auth", "acme", url, false, brand).AUTH_BRAND_NAME, "straylight");
  const bare = orgEnv("core", "acme", url, false);
  assert.equal(bare.ORG_BRAND_SELF_LABEL, undefined);
  assert.equal(bare.ORG_BRAND_ORG_NAME, undefined);
  assert.equal(orgEnv("auth", "acme", url, false).AUTH_BRAND_NAME, undefined);
  assert.equal(orgEnv("web-ui", "acme", url, false, brand).ORG_BRAND_SELF_LABEL, undefined);
});

const imageFromStack = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "imagefrom-stack.json");

test("an imageFrom stack reuses the reference images and overrides only its own keys", () => {
  const { config } = loadConfigAt(imageFromStack);
  assert.equal(config.imageFrom, "qm");
  const coreToml = derivedTomlFor(config, "core", repoRoot);
  assert.match(coreToml, /app = "beta-core"/);
  assert.match(coreToml, /ORG_ID = "beta"/);
  assert.match(coreToml, /PUBLIC_WEB_URL = "https:\/\/beta-portal\.fly\.dev"/);
  assert.match(coreToml, /FLY_SANDBOX_APP_NAME = "beta-sandboxes"/);
});

const exampleFlyConfig = (): QmConfig => ({
  contract: 1,
  orgId: "example",
  publicUrl: "https://example.invalid",
  target: "fly",
  model: "example-model",
  appPrefix: "example-stack",
  region: "ord",
  flyOrg: "example-org",
  sandbox: {
    app: "example-sandboxes",
    image: "registry.fly.io/example-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
  },
  services: ["core", "admin", "web-ui", "portal"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
});

test("a configured bot identity lands in the derived fly toml for core and auth only", () => {
  const config = { ...exampleFlyConfig(), botName: "straylight", orgName: "Straylight Industries" };
  config.services = ["core", "admin", "web-ui", "portal", "auth"];
  const core = derivedTomlFor(config, "core", repoRoot);
  assert.match(core, /^\s*ORG_BRAND_SELF_LABEL = "straylight"$/m);
  assert.match(core, /^\s*ORG_BRAND_ORG_NAME = "Straylight Industries"$/m);
  const auth = derivedTomlFor(config, "auth", repoRoot);
  assert.match(auth, /^\s*AUTH_BRAND_NAME = "straylight"$/m);
  const webUi = derivedTomlFor(config, "web-ui", repoRoot);
  assert.doesNotMatch(webUi, /ORG_BRAND_SELF_LABEL/);
  const bare = derivedTomlFor(exampleFlyConfig(), "core", repoRoot);
  assert.doesNotMatch(bare, /ORG_BRAND_SELF_LABEL/);
});

test("derived Fly configs contain only the deployment's region, org, sandbox, and portal policy", () => {
  const config = exampleFlyConfig();
  const core = derivedTomlFor(config, "core", repoRoot);
  const portal = derivedTomlFor(config, "portal", repoRoot);
  const admin = derivedTomlFor(config, "admin", repoRoot);

  assert.match(core, /^primary_region = "ord"$/m);
  assert.match(portal, /^primary_region = "ord"$/m);
  assert.match(admin, /^\s*ADMIN_BASE_PATH = "\/admin"$/m);
  assert.match(core, /^\s*FLY_ORG = "example-org"$/m);
  assert.match(core, /^\s*PI_MODEL = "example-model"$/m);
  assert.match(
    core,
    /^\s*FLY_DEPLOY_BASE_IMAGE = "registry\.fly\.io\/example-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a"$/m,
  );
  assert.match(core, /^\s*QM_DEPLOYMENT_ID = "qm-v2:example-org:example:example-stack"$/m);
  assert.doesNotMatch(core, /PI_DETECT_MODEL/);
  assert.doesNotMatch(portal, /OIDC_ALLOWED_EMAIL_DOMAIN/);
});

test("virtual-service env folds into the core [env] (core's own block wins)", () => {
  const { config } = loadConfigAt(imageFromStack);
  const coreToml = derivedTomlFor(config, "core", repoRoot);
  assert.match(
    coreToml,
    /WEB_UI_PUBLIC_URL = "https:\/\/beta-portal\.fly\.dev"/,
    "env.slack reaches the in-process slack surface on core",
  );
  const coreWins = {
    ...config,
    env: { ...config.env, core: { ...config.env.core, WEB_UI_PUBLIC_URL: "https://core-wins.example.com" } },
  };
  assert.match(derivedTomlFor(coreWins, "core", repoRoot), /WEB_UI_PUBLIC_URL = "https:\/\/core-wins\.example\.com"/);
  assert.doesNotMatch(derivedTomlFor(config, "admin", repoRoot), /beta-portal\.fly\.dev\/web-ui/);
});

test("a vms override rewrites the core [[vm]] size/memory without touching other services", () => {
  const { config } = loadConfigAt(imageFromStack);
  const coreToml = derivedTomlFor(config, "core", repoRoot);
  assert.match(coreToml, /\[\[vm\]\]\n\s*size = "shared-cpu-2x"\n\s*memory = "4gb"/);
  assert.doesNotMatch(coreToml, /size = "shared-cpu-1x"/);
  assert.doesNotMatch(coreToml, /memory = "2gb"/);
  const adminToml = derivedTomlFor(config, "admin", repoRoot);
  const adminVm = readFileSync(join(repoRoot, "deploy", "admin", "fly.toml"), "utf8").match(
    /\[\[vm\]\][\s\S]*?(?=\n\[|\n\n|$)/,
  );
  if (adminVm) assert.ok(adminToml.includes(adminVm[0]), "admin [[vm]] block changed despite no vms override");
  assert.doesNotMatch(adminToml, /shared-cpu-2x|memory = "4gb"/);
});
