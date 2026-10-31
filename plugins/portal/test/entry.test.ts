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
    PORTAL_SESSION_TTL_S: "5184000",
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

test("production boot requires the broker upstream on a private-network host", () => {
  const command = "import('./src/index.ts').then(m => m.bootChecks())";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORTAL_PUBLIC_URL: "https://agent.example.com",
    PORTAL_SESSION_SECRET: "portal-session-secret",
    CORE_SIGNING_SECRET: "core-signing-secret",
    AUTH_BROKER_UPSTREAM: "http://acme-auth.internal:8080",
  };
  const boot = (override: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", command], {
      cwd: process.cwd(),
      env: { ...env, ...override },
      encoding: "utf8",
    });
  const wired = boot({});
  assert.equal(wired.status, 0, wired.stderr);
  const exposed = boot({ AUTH_BROKER_UPSTREAM: "https://auth.example.com" });
  assert.notEqual(exposed.status, 0);
  assert.match(exposed.stderr, /AUTH_BROKER_UPSTREAM must address a private-network host/);
});
