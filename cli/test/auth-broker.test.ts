import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, loadConfigAt, validatePortalTrust, type QmConfig } from "../src/config.ts";
import { derivedTomlFor } from "../src/backends/fly.ts";
import { serviceEnvironment } from "../src/backends/aws.ts";
import { dockerServiceEnv } from "../src/backends/docker.ts";
import { computedSecrets, runtimeSecretNames, secretsForService } from "../src/secrets.ts";
import { stageFlyEmailAllowlist } from "../src/backends/fly.ts";
import { isReservedContainerName, SERVICE_NAMES, serviceDef, serviceHost } from "../src/services.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const brokerStack = join(repoRoot, "deploy", "stacks", "broker", "qm.config.jsonc");
const brokerConfig = (): QmConfig => loadConfigAt(brokerStack).config;

function configWith(body: string): QmConfig {
  const dir = mkdtempSync(join(tmpdir(), "qm-auth-cfg-"));
  try {
    writeFileSync(join(dir, CONFIG_FILENAME), body);
    return loadConfigAt(join(dir, CONFIG_FILENAME)).config;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function configText(over: { services?: string; env?: string } = {}): string {
  return `{
    "contract": 1, "orgId": "acme", "publicUrl": "https://agent.example.com", "target": "docker",
    "services": ${over.services ?? '["core", "web-ui", "admin", "portal", "auth"]'},
    "plugins": [], "skills": [],
    "env": ${over.env ?? '{ "auth": { "AUTH_EMAIL_TRANSPORT": "resend", "AUTH_ALLOWED_EMAIL_DOMAIN": "example.com" } }'}
  }`;
}

test("the web surfaces are names core hosts, reserved from plugins", () => {
  for (const name of ["web-ui", "admin", "portal", "auth"]) {
    assert.ok(!SERVICE_NAMES.includes(name as never), `${name} is not a separate workload`);
    assert.equal(serviceHost(name), "core");
    assert.ok(isReservedContainerName(name), "a third-party plugin may not shadow a core-hosted surface");
  }
  const offsets = SERVICE_NAMES.map((name) => serviceDef(name).docker.hostPortOffset);
  assert.equal(new Set(offsets).size, offsets.length, "host port offsets stay unique");
});

test("fly derives the whole OIDC block from the embedded broker into core", () => {
  const core = derivedTomlFor(brokerConfig(), "core", repoRoot);
  assert.match(core, /OIDC_ISSUER = "https:\/\/agent\.example\.com\/idp"/);
  assert.match(core, /OIDC_AUTH_ENDPOINT = "https:\/\/agent\.example\.com\/idp\/authorize"/);
  assert.match(core, /OIDC_TOKEN_ENDPOINT = "http:\/\/127\.0\.0\.1:8099\/token"/);
  assert.match(core, /OIDC_USERINFO_ENDPOINT = "http:\/\/127\.0\.0\.1:8099\/userinfo"/);
  assert.match(core, /OIDC_JWKS_URI = "http:\/\/127\.0\.0\.1:8099\/\.well-known\/jwks\.json"/);
  assert.match(core, /AUTH_BROKER_UPSTREAM = "http:\/\/127\.0\.0\.1:8099"/);
  assert.match(core, /AUTH_EMBEDDED = "1"/);
  assert.match(core, /AUTH_BROKER_PREFIX = "\/idp"/);
  assert.match(core, /AUTH_ISSUER = "https:\/\/agent\.example\.com\/idp"/);
  assert.match(core, /AUTH_REDIRECT_URI = "https:\/\/agent\.example\.com\/auth\/callback"/);
  assert.match(core, /OIDC_PRINCIPAL_CLAIM = "email"/);
  assert.match(core, /OIDC_ALLOWED_EMAIL_DOMAIN = "example\.com"/);
  assert.match(core, /AUTH_ALLOWED_EMAIL_DOMAIN = "example\.com"/, "core refuses in-domain external invites");
  assert.doesNotMatch(core, /internal_port = 8080/, "core's API port never gets public ingress");
  assert.doesNotMatch(core, /WEB_UI_UPSTREAM|ADMIN_UPSTREAM|CORE_API_URL/, "core wires its hosted surfaces itself");
});

test("the external-IdP stack keeps its own OIDC endpoints and gains no broker wiring", () => {
  const acme = loadConfigAt(join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc")).config;
  assert.ok(!acme.services.includes("auth"));
  const core = derivedTomlFor(acme, "core", repoRoot);
  assert.match(core, /OIDC_ISSUER = "https:\/\/accounts\.google\.com"/);
  assert.doesNotMatch(core, /AUTH_BROKER_UPSTREAM/);
});

test("a configured botName brands core's docker env, including the hosted sign-in pages", () => {
  const config = configWith(
    configText().replace('"plugins": [],', '"botName": "straylight", "orgName": "Acme Corp", "plugins": [],'),
  );
  const core = dockerServiceEnv(config, "core");
  assert.equal(core.ORG_BRAND_SELF_LABEL, "straylight");
  assert.equal(core.ORG_BRAND_ORG_NAME, "Acme Corp");
  assert.equal(core.AUTH_BRAND_NAME, "straylight");
  const bare = dockerServiceEnv(configWith(configText()), "core");
  assert.equal(bare.ORG_BRAND_SELF_LABEL, undefined);
  assert.equal(bare.AUTH_BRAND_NAME, undefined);
});

test("docker and AWS wire the edge and the broker into core with parity", () => {
  const dockerCore = dockerServiceEnv(configWith(configText()), "core");
  const aws = configWith(`{
    "contract": 1, "orgId": "acme", "publicUrl": "https://agent.example.com", "target": "aws",
    "services": ["core", "web-ui", "admin", "portal", "auth"], "plugins": [], "skills": [],
    "env": { "core": { "AWS_DEPLOY_IMAGE": "acme-sandbox" }, "auth": { "AUTH_EMAIL_TRANSPORT": "smtp", "AUTH_ALLOWED_EMAIL_DOMAIN": "example.com" } },
    "aws": {
      "accountId": "123456789012", "region": "us-west-2", "cluster": "acme-qm",
      "deployRoleArn": "arn:aws:iam::123456789012:role/acme-qm-github-deploy",
      "secretsPrefix": "acme/qm/", "imageLabel": "latest",
      "networking": { "cloudMapNamespace": "acme.internal" },
      "services": {
        "core": { "ecrRepository": "acme-qm-core", "ecsService": "acme-qm-core", "cpu": 2048, "memory": 4096 }
      }
    }
  }`);
  const awsCore = serviceEnvironment(aws, "core");
  for (const env of [dockerCore, awsCore]) {
    assert.equal(env.PUBLIC_PORT, "8000");
    assert.equal(env.PORTAL_PUBLIC_URL, "https://agent.example.com");
    assert.equal(env.REQUIRE_SIGNED_PORTAL_IDENTITY, "1");
    assert.equal(env.ADMIN_ENABLED, "1");
    assert.equal(env.AUTH_EMBEDDED, "1");
    assert.equal(env.AUTH_BROKER_UPSTREAM, "http://127.0.0.1:8099");
    assert.equal(env.OIDC_TOKEN_ENDPOINT, "http://127.0.0.1:8099/token");
    assert.equal(env.OIDC_JWKS_URI, "http://127.0.0.1:8099/.well-known/jwks.json");
    assert.equal(env.OIDC_ISSUER, "https://agent.example.com/idp");
    assert.equal(env.AUTH_REDIRECT_URI, "https://agent.example.com/auth/callback");
    assert.equal(env.OIDC_ALLOWED_EMAIL_DOMAIN, "example.com");
    assert.equal(env.AUTH_ALLOWED_EMAIL_DOMAIN, "example.com");
    assert.equal(env.WEB_UI_UPSTREAM, undefined);
    assert.equal(env.CORE_API_URL, undefined);
  }
  assert.equal(awsCore.PORT, "8080");
  assert.equal(
    awsCore.PORTAL_XFF_TRUSTED_HOPS,
    "1",
    "only the hop the load balancer appends is unforgeable; counting further left would select a client-prepended entry",
  );
  assert.equal(dockerCore.PORTAL_XFF_TRUSTED_HOPS, undefined);
});

test("docker local wires the host daemon coordinates only into core", () => {
  const local = configWith(
    configText().replace(
      '"plugins": [],',
      '"sandbox": { "backend": "local", "image": "qm-sandbox-local:latest" }, "plugins": [],',
    ),
  );
  assert.equal(dockerServiceEnv(local, "core").DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(dockerServiceEnv(local, "core").QM_CORE_CONTAINER, "qm-acme-core");
  assert.equal(dockerServiceEnv(local, "egress-proxy").DOCKER_HOST, undefined);
});

test("the broker's generated secrets reach both sides under the right names", () => {
  const config = brokerConfig();
  const secrets = computedSecrets(config);
  const clientSecret = secrets.find((secret) => secret.name === "AUTH_CLIENT_SECRET")!;
  assert.deepEqual(runtimeSecretNames("auth", clientSecret), ["AUTH_CLIENT_SECRET", "OIDC_CLIENT_SECRET"]);
  assert.deepEqual(runtimeSecretNames("portal", clientSecret), ["AUTH_CLIENT_SECRET", "OIDC_CLIENT_SECRET"]);
  assert.ok(clientSecret.generate, "the CLI mints it rather than asking the operator");

  const jwk = secrets.find((secret) => secret.name === "AUTH_SIGNING_JWK")!;
  assert.deepEqual(runtimeSecretNames("auth", jwk), ["AUTH_SIGNING_JWK"]);
  assert.deepEqual(runtimeSecretNames("portal", jwk), ["AUTH_SIGNING_JWK"]);
  assert.match(jwk.generate ?? "", /P-256/);

  const names = new Set(secrets.map((secret) => secret.name));
  assert.ok(!names.has("OIDC_CLIENT_SECRET"), "the operator is never asked for an OIDC client secret in broker mode");
  assert.ok(!names.has("OIDC_CLIENT_ID"));
  assert.ok(!names.has("PORTAL_EXPECTED_TEAM_ID"));
  assert.ok(!names.has("AUTH_ALLOWED_EMAILS"), "a configured domain removes the per-address allowlist requirement");
  assert.ok(names.has("RESEND_API_KEY"));
  assert.ok(!names.has("SMTP_HOST"), "only the configured transport's credentials are collected");
  for (const name of ["RESEND_API_KEY", "AUTH_EMAIL_FROM"]) {
    const shared = secrets.find((secret) => secret.name === name)!;
    assert.equal(shared.required, false, "email delivery can be deferred while admins use the operator CLI");
    assert.deepEqual(runtimeSecretNames("auth", shared), [name]);
    assert.deepEqual(runtimeSecretNames("core", shared), [name], `core emails external-user invitations with ${name}`);
  }
  assert.ok(secretsForService(config, "auth").some((secret) => secret.name === "CORE_SIGNING_SECRET"));
});

test("without a configured domain the allowlist becomes a required secret on both services", () => {
  const config = configWith(configText({ env: `{ "auth": { "AUTH_EMAIL_TRANSPORT": "smtp" } }` }));
  const allowed = computedSecrets(config).find((secret) => secret.name === "AUTH_ALLOWED_EMAILS")!;
  assert.ok(allowed.required);
  assert.deepEqual(runtimeSecretNames("auth", allowed), ["AUTH_ALLOWED_EMAILS", "OIDC_ALLOWED_EMAILS"]);
  assert.deepEqual(runtimeSecretNames("portal", allowed), ["AUTH_ALLOWED_EMAILS", "OIDC_ALLOWED_EMAILS"]);
  assert.deepEqual(runtimeSecretNames("core", allowed), ["AUTH_ALLOWED_EMAILS", "OIDC_ALLOWED_EMAILS"]);
  const names = new Set(computedSecrets(config).map((secret) => secret.name));
  for (const name of ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"]) assert.ok(names.has(name), name);
  const resend = computedSecrets(config).find((secret) => secret.name === "RESEND_API_KEY")!;
  assert.equal(resend.required, false, "the unselected transport's key stays optional");
  assert.deepEqual(runtimeSecretNames("core", resend), ["RESEND_API_KEY"], "core keeps it for invitations");
});

test("the config refuses a surface without a portal, a bad transport, and hand-set derived env", () => {
  const refuses = (body: string, pattern: RegExp): void => {
    assert.throws(() => configWith(body), pattern);
  };
  refuses(configText({ services: '["core", "auth"]' }), /"auth" requires "portal"/);
  refuses(configText({ services: '["core", "web-ui"]' }), /"web-ui" requires "portal"/);
  refuses(
    configText({ env: `{ "auth": { "AUTH_EMAIL_TRANSPORT": "sendmail" } }` }),
    /AUTH_EMAIL_TRANSPORT must be "resend" or "smtp"/,
  );
  refuses(configText({ env: `{ "auth": {} }` }), /AUTH_EMAIL_TRANSPORT must be "resend" or "smtp"/);
  refuses(
    configText({ env: `{ "auth": { "AUTH_EMAIL_TRANSPORT": "resend", "AUTH_ALLOWED_EMAIL_DOMAIN": "nodot" } }` }),
    /AUTH_ALLOWED_EMAIL_DOMAIN must be a valid/,
  );
  refuses(
    configText({
      env: `{ "auth": { "AUTH_EMAIL_TRANSPORT": "resend", "AUTH_ALLOWED_EMAIL_DOMAIN": "example.com" }, "portal": { "OIDC_ISSUER": "https://evil.test" } }`,
    }),
    /env\.portal\.OIDC_ISSUER is derived from the built-in auth broker/,
  );
  refuses(
    configText({
      env: `{ "auth": { "AUTH_EMAIL_TRANSPORT": "resend", "AUTH_ALLOWED_EMAIL_DOMAIN": "example.com", "AUTH_ISSUER": "https://evil.test" } }`,
    }),
    /env\.auth\.AUTH_ISSUER is derived from publicUrl/,
  );
  refuses(
    configText({
      env: `{ "auth": { "AUTH_EMAIL_TRANSPORT": "resend", "AUTH_ALLOWED_EMAIL_DOMAIN": "example.com" }, "portal": { "PORTAL_EXPECTED_TEAM_ID": "T1" } }`,
    }),
    /PORTAL_EXPECTED_TEAM_ID belongs to Slack sign-in/,
  );
});

test("a broker deployment with no allowlist at all is refused once secret values are known", () => {
  const config = configWith(configText({ env: `{ "auth": { "AUTH_EMAIL_TRANSPORT": "resend" } }` }));
  assert.throws(
    () => validatePortalTrust(config, "config", new Map()),
    /requires env\.auth\.AUTH_ALLOWED_EMAIL_DOMAIN or a valid AUTH_ALLOWED_EMAILS/,
  );
  assert.throws(
    () => validatePortalTrust(config, "config", new Map([["AUTH_ALLOWED_EMAILS", "replace-me"]])),
    /requires env\.auth\.AUTH_ALLOWED_EMAIL_DOMAIN or a valid AUTH_ALLOWED_EMAILS/,
  );
  assert.doesNotThrow(() =>
    validatePortalTrust(config, "config", new Map([["AUTH_ALLOWED_EMAILS", "admin@example.com"]])),
  );
  assert.doesNotThrow(() => validatePortalTrust(brokerConfig(), "config", new Map()));
});

test("fly up staging copies a changed .env email allowlist to core under both names", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-allowlist-up-"));
  const fly = join(dir, "fly");
  const log = join(dir, "fly.log");
  writeFileSync(
    fly,
    `#!/usr/bin/env node
const fs=require("node:fs"); fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ")+" value="+fs.readFileSync(0,"utf8")+"\\n");`,
  );
  chmodSync(fly, 0o755);
  writeFileSync(join(dir, ".env"), "AUTH_ALLOWED_EMAILS=new@example.com,other@example.com\n");
  const config = configWith(configText({ env: `{ "auth": { "AUTH_EMAIL_TRANSPORT": "smtp" } }` }));
  const prior = process.env.FLY_BIN;
  process.env.FLY_BIN = fly;
  try {
    stageFlyEmailAllowlist(config, dir, new Set(["core"]));
  } finally {
    if (prior === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = prior;
  }
  const calls = readFileSync(log, "utf8");
  const prefix = "acme";
  assert.match(calls, new RegExp(`-a ${prefix}-core AUTH_ALLOWED_EMAILS=- value=new@example.com,other@example.com`));
  assert.match(calls, new RegExp(`-a ${prefix}-core OIDC_ALLOWED_EMAILS=- value=new@example.com,other@example.com`));
  assert.doesNotMatch(calls, /-a acme-(portal|auth) /);
});
