import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigAt, type QmConfig } from "../src/config.ts";
import { derivedTomlFor } from "../src/backends/fly.ts";
import { orgEnv, runnableServices } from "../src/services.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("acme fly config derives the packaged cli/templates/fly/<svc>.toml byte-for-byte", () => {
  const { config } = loadConfigAt(join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"));
  for (const svc of runnableServices(config.services)) {
    const derived = derivedTomlFor(config, svc, repoRoot);
    const template = readFileSync(join(repoRoot, "cli", "templates", "fly", `${svc}.toml`), "utf8");
    assert.equal(derived, template, `derived ${svc} fly.toml diverged from cli/templates/fly/${svc}.toml`);
  }
});

test("Fly core defaults can sustain the 16-worker baseline", () => {
  const { config } = loadConfigAt(join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"));
  const core = derivedTomlFor(config, "core", repoRoot);
  assert.match(core, /\[\[restart\]\]\n\s*policy = "always"/);
  assert.match(core, /\[\[vm\]\]\n\s*size = "performance-2x"\n\s*memory = "4gb"/);
});

test("core serves the web UI and sign-in at the root of publicUrl on the public port", () => {
  const url = "https://acme-core.fly.dev";
  for (const publicUrl of [url, `${url}/`]) {
    const env = orgEnv("core", "acme", publicUrl);
    assert.equal(env.PUBLIC_WEB_URL, url);
    assert.equal(env.PUBLIC_PORT, "8000");
  }
});

test("brand env reaches core as ORG_BRAND_* and AUTH_BRAND_NAME, and only when configured", () => {
  const url = "https://acme-core.fly.dev";
  const brand = { botName: "straylight", orgName: "Acme Corp" };
  const core = orgEnv("core", "acme", url, brand);
  assert.equal(core.ORG_BRAND_SELF_LABEL, "straylight");
  assert.equal(core.ORG_BRAND_ORG_NAME, "Acme Corp");
  assert.equal(core.AUTH_BRAND_NAME, "straylight");
  const bare = orgEnv("core", "acme", url);
  assert.equal(bare.ORG_BRAND_SELF_LABEL, undefined);
  assert.equal(bare.ORG_BRAND_ORG_NAME, undefined);
  assert.equal(bare.AUTH_BRAND_NAME, undefined);
  assert.equal(orgEnv("egress-proxy", "acme", url, brand).ORG_BRAND_SELF_LABEL, undefined);
});

const imageFromStack = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "imagefrom-stack.json");

test("an imageFrom stack reuses the reference images and overrides only its own keys", () => {
  const { config } = loadConfigAt(imageFromStack);
  assert.equal(config.imageFrom, "qm");
  const coreToml = derivedTomlFor(config, "core", repoRoot);
  assert.match(coreToml, /app = "beta-core"/);
  assert.match(coreToml, /ORG_ID = "beta"/);
  assert.match(coreToml, /PUBLIC_WEB_URL = "https:\/\/beta-core\.fly\.dev"/);
  assert.match(coreToml, /STACK_MARKER = "beta-sandboxes"/);
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
  },
  services: ["core"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
});

test("a configured bot identity lands in the derived core fly toml", () => {
  const config = { ...exampleFlyConfig(), botName: "straylight", orgName: "Straylight Industries" };
  config.services = ["core", "auth"];
  const core = derivedTomlFor(config, "core", repoRoot);
  assert.match(core, /^\s*ORG_BRAND_SELF_LABEL = "straylight"$/m);
  assert.match(core, /^\s*ORG_BRAND_ORG_NAME = "Straylight Industries"$/m);
  assert.match(core, /^\s*AUTH_BRAND_NAME = "straylight"$/m);
  const bare = derivedTomlFor(exampleFlyConfig(), "core", repoRoot);
  assert.doesNotMatch(bare, /ORG_BRAND_SELF_LABEL|AUTH_BRAND_NAME/);
});

test("derived Fly configs contain only the deployment's region, org, sandbox, and sign-in policy", () => {
  const config = exampleFlyConfig();
  const core = derivedTomlFor(config, "core", repoRoot);

  assert.match(core, /^primary_region = "ord"$/m);
  assert.match(core, /^\s*FLY_ORG = "example-org"$/m);
  assert.match(core, /^\s*PI_MODEL = "example-model"$/m);
  assert.match(core, /^\s*QM_DEPLOYMENT_ID = "qm-v2:example-org:example:example-stack"$/m);
  assert.doesNotMatch(core, /PI_DETECT_MODEL/);
  assert.doesNotMatch(core, /OIDC_ALLOWED_EMAIL_DOMAIN|OIDC_AUTH_ENDPOINT/);
});

test("virtual-service env folds into the core [env] (core's own block wins)", () => {
  const { config } = loadConfigAt(imageFromStack);
  const coreToml = derivedTomlFor(config, "core", repoRoot);
  assert.match(
    coreToml,
    /PUBLIC_WEB_URL = "https:\/\/beta-core\.fly\.dev"/,
    "env.slack reaches the in-process slack surface on core",
  );
  const coreWins = {
    ...config,
    env: { ...config.env, core: { ...config.env.core, PUBLIC_WEB_URL: "https://core-wins.example.com" } },
  };
  assert.match(derivedTomlFor(coreWins, "core", repoRoot), /PUBLIC_WEB_URL = "https:\/\/core-wins\.example\.com"/);
});

test("a vms override rewrites the core [[vm]] size/memory", () => {
  const { config } = loadConfigAt(imageFromStack);
  const coreToml = derivedTomlFor(config, "core", repoRoot);
  assert.match(coreToml, /\[\[vm\]\]\n\s*size = "shared-cpu-2x"\n\s*memory = "4gb"/);
  assert.doesNotMatch(coreToml, /performance-2x/);
});
