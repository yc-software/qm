import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

test("`node src/index.ts` (relative entry, like Docker) binds the port and serves /healthz", async () => {
  const PORT = "18097";
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT, PORTAL_PUBLIC_URL: `http://localhost:${PORT}`, NODE_ENV: "test" },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 8000;
    let ok = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://localhost:${PORT}/healthz`);
        if (r.status === 200) {
          ok = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    assert.ok(ok, "portal entry should bind the port and answer /healthz");
  } finally {
    child.kill("SIGKILL");
  }
});

test("production boot requires an explicit OIDC tenant trust boundary", () => {
  const command = "import('./src/index.ts').then(m => m.bootChecks())";
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORTAL_PUBLIC_URL: "https://agent.example.com",
    PORTAL_SESSION_SECRET: "portal-session-secret",
    CORE_SIGNING_SECRET: "core-signing-secret",
    SKILL_SIGNING_SECRET: "skill-signing-secret",
    SANDBOX_BACKEND: "local",
    OIDC_CLIENT_ID: "client-id",
    OIDC_CLIENT_SECRET: "client-secret",
  };
  delete baseEnv.PORTAL_EXPECTED_TEAM_ID;
  delete baseEnv.OIDC_ALLOWED_EMAIL_DOMAIN;
  delete baseEnv.OIDC_ALLOWED_EMAILS;
  for (const value of [undefined, "", " ", "replace-me"]) {
    const env = { ...baseEnv };
    if (value !== undefined) env.PORTAL_EXPECTED_TEAM_ID = value;
    const missing = spawnSync(process.execPath, ["--input-type=module", "-e", command], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_EMAIL_DOMAIN, or PORTAL_EXPECTED_TEAM_ID/);
  }
  for (const gate of [
    { OIDC_ALLOWED_EMAILS: "admin@example.com" },
    { OIDC_ALLOWED_EMAIL_DOMAIN: "example.com" },
    { PORTAL_EXPECTED_TEAM_ID: "T123" },
    { OIDC_ALLOWED_EMAIL_DOMAIN: "example.com", PORTAL_EXPECTED_TEAM_ID: "T123" },
  ]) {
    const accepted = spawnSync(process.execPath, ["--input-type=module", "-e", command], {
      cwd: process.cwd(),
      env: { ...baseEnv, ...gate },
      encoding: "utf8",
    });
    assert.equal(accepted.status, 0, accepted.stderr);
  }
});

test("production boot requires an explicit JWKS URI for custom issuers", () => {
  const command = "import('./src/index.ts').then(m => m.bootChecks())";
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORTAL_PUBLIC_URL: "https://agent.example.com",
    PORTAL_SESSION_SECRET: "portal-session-secret",
    CORE_SIGNING_SECRET: "core-signing-secret",
    OIDC_CLIENT_ID: "client-id",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_ISSUER: "https://auth.example.com",
    OIDC_AUTH_ENDPOINT: "https://auth.example.com/authorize",
    OIDC_TOKEN_ENDPOINT: "https://auth.example.com/token",
    OIDC_USERINFO_ENDPOINT: "https://auth.example.com/userinfo",
    OIDC_ALLOWED_EMAILS: "admin@example.com",
  };
  delete baseEnv.OIDC_JWKS_URI;
  const missing = spawnSync(process.execPath, ["--input-type=module", "-e", command], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /OIDC_JWKS_URI is required/);

  const accepted = spawnSync(process.execPath, ["--input-type=module", "-e", command], {
    cwd: process.cwd(),
    env: { ...baseEnv, OIDC_JWKS_URI: "https://auth.example.com/jwks.json" },
    encoding: "utf8",
  });
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("a session TTL above the default max ceiling still boots, but a contradictory pair does not", () => {
  const command = "import('./src/index.ts').then(m => m.bootChecks())";
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORTAL_PUBLIC_URL: "https://agent.example.com",
    PORTAL_SESSION_SECRET: "portal-session-secret",
    CORE_SIGNING_SECRET: "core-signing-secret",
    SKILL_SIGNING_SECRET: "skill-signing-secret",
    SANDBOX_BACKEND: "local",
    OIDC_CLIENT_ID: "client-id",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_ALLOWED_EMAILS: "admin@example.com",
    PORTAL_SESSION_TTL_S: "604800",
  };
  delete baseEnv.PORTAL_SESSION_MAX_TTL_S;

  const derived = spawnSync(process.execPath, ["--input-type=module", "-e", command], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: "utf8",
  });
  assert.equal(derived.status, 0, derived.stderr);

  const contradictory = spawnSync(process.execPath, ["--input-type=module", "-e", command], {
    cwd: process.cwd(),
    env: { ...baseEnv, PORTAL_SESSION_MAX_TTL_S: "86400" },
    encoding: "utf8",
  });
  assert.notEqual(contradictory.status, 0);
  assert.match(contradictory.stderr, /PORTAL_SESSION_MAX_TTL_S must be a finite number/);
});

test("production accepts cleartext OIDC only on private-network hosts, and only for the server-to-server endpoints", () => {
  const command = "import('./src/index.ts').then(m => m.bootChecks())";
  const brokerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORTAL_PUBLIC_URL: "https://agent.example.com",
    PORTAL_SESSION_SECRET: "portal-session-secret",
    CORE_SIGNING_SECRET: "core-signing-secret",
    OIDC_CLIENT_ID: "qm-portal",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_ISSUER: "https://agent.example.com/idp",
    OIDC_AUTH_ENDPOINT: "https://agent.example.com/idp/authorize",
    OIDC_TOKEN_ENDPOINT: "http://acme-auth.internal:8080/token",
    OIDC_USERINFO_ENDPOINT: "http://acme-auth.internal:8080/userinfo",
    OIDC_JWKS_URI: "http://acme-auth.internal:8080/.well-known/jwks.json",
    OIDC_ALLOWED_EMAILS: "admin@example.com",
    AUTH_BROKER_UPSTREAM: "http://acme-auth.internal:8080",
  };
  const boot = (env: NodeJS.ProcessEnv): { status: number | null; stderr: string } =>
    spawnSync(process.execPath, ["--input-type=module", "-e", command], { cwd: process.cwd(), env, encoding: "utf8" });

  const wired = boot(brokerEnv);
  assert.equal(wired.status, 0, wired.stderr);

  for (const [override, pattern] of [
    [
      { OIDC_TOKEN_ENDPOINT: "http://tokens.example.com/token" },
      /OIDC endpoint must be https unless it is the built-in broker/,
    ],
    [{ OIDC_JWKS_URI: "http://10.0.0.5/keys" }, /OIDC endpoint must be https unless it is the built-in broker/],
    [{ OIDC_AUTH_ENDPOINT: "http://agent.example.com/idp/authorize" }, /OIDC_AUTH_ENDPOINT must be https/],
    [{ AUTH_BROKER_UPSTREAM: "https://auth.example.com" }, /AUTH_BROKER_UPSTREAM must address a private-network host/],
    [
      { OIDC_AUTH_ENDPOINT: "https://elsewhere.example.com/idp/authorize" },
      /OIDC_AUTH_ENDPOINT must be https:\/\/agent\.example\.com\/idp\/authorize/,
    ],
    [{ OIDC_ISSUER: "https://elsewhere.example.com/idp" }, /OIDC_ISSUER must be https:\/\/agent\.example\.com\/idp/],
  ] as Array<[NodeJS.ProcessEnv, RegExp]>) {
    const refused = boot({ ...brokerEnv, ...override });
    assert.notEqual(refused.status, 0, JSON.stringify(override));
    assert.match(refused.stderr, pattern);
  }

  const externalEnv: NodeJS.ProcessEnv = { ...brokerEnv };
  delete externalEnv.AUTH_BROKER_UPSTREAM;
  externalEnv.OIDC_ISSUER = "https://auth.example.com";
  externalEnv.OIDC_AUTH_ENDPOINT = "https://auth.example.com/authorize";
  const externalCleartext = boot({ ...externalEnv, OIDC_JWKS_URI: "http://10.0.0.5/keys" });
  assert.notEqual(externalCleartext.status, 0, "the relaxation is for the built-in broker only");
  assert.match(externalCleartext.stderr, /OIDC endpoint must be https unless it is the built-in broker/);
});
