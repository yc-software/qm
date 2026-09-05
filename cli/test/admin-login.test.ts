import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { adminLoginUrl } from "../src/commands/admin-login.ts";
import { openAdminLogin } from "../../plugins/portal/src/admin-login.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../bin/qm.ts");
const settings = {
  publicUrl: "https://qm.example.com",
  secret: "deployment-secret-".repeat(3),
  adminGrants: "Admin@example.com:org_admin",
};
const tokenFrom = (url: string): string => new URLSearchParams(new URL(url).hash.slice(1)).get("token")!;

test("CLI-issued links satisfy the portal contract and expire after five minutes", () => {
  const url = adminLoginUrl(settings);
  const token = tokenFrom(url);
  const verified = openAdminLogin(token, settings.secret, settings.publicUrl);
  assert.equal(verified?.email, "admin@example.com");
  assert.ok(verified);
  assert.equal(new URL(url).pathname, "/auth/admin-login");
  assert.equal(new URL(url).search, "");
  assert.equal(openAdminLogin(token, settings.secret, settings.publicUrl, verified.expiresAtMs), null);
  assert.equal(openAdminLogin(token, "different-secret-".repeat(3), settings.publicUrl), null);
  assert.equal(openAdminLogin(token, settings.secret, "https://other.example.com"), null);
  const other = openAdminLogin(tokenFrom(adminLoginUrl(settings)), settings.secret, settings.publicUrl);
  assert.notEqual(verified.jti, other?.jti);
});

test("CLI only selects configured administrator emails and requires a choice when ambiguous", () => {
  assert.throws(() => adminLoginUrl({ ...settings, email: "member@example.com" }), /configured admins/);
  assert.throws(() => adminLoginUrl({ ...settings, adminGrants: "member@example.com:member" }), /ADMIN_GRANTS/);
  const adminGrants = "admin@example.com:org_admin,second@example.com:org_admin";
  assert.throws(() => adminLoginUrl({ ...settings, adminGrants }), /--email/);
  const url = adminLoginUrl({ ...settings, adminGrants, email: " Second@Example.com " });
  assert.equal(openAdminLogin(tokenFrom(url), settings.secret, settings.publicUrl)?.email, "second@example.com");
});

test("CLI refuses invalid signing keys and unsafe public URLs", () => {
  for (const secret of ["", "replace-me", "short", " ".repeat(40)]) {
    assert.throws(() => adminLoginUrl({ ...settings, secret }), /PORTAL_SESSION_SECRET/);
  }
  for (const publicUrl of [
    "http://public.example.com",
    "https://user:pass@qm.example.com",
    "https://qm.example.com/x",
    "https://qm.example.com?x=y",
  ]) {
    assert.throws(() => adminLoginUrl({ ...settings, publicUrl }), /HTTPS public URL/);
  }
  assert.match(
    adminLoginUrl({ ...settings, publicUrl: "http://127.0.0.1:8080" }),
    /^http:\/\/127\.0\.0\.1:8080\/auth\/admin-login#/,
  );
});

test("the command uses deployment config and local secrets without contacting a provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-admin-login-"));
  try {
    writeFileSync(
      join(dir, "qm.config.jsonc"),
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: settings.publicUrl,
        target: "docker",
        services: ["core", "web-ui", "admin", "portal", "auth"],
        env: { auth: { AUTH_EMAIL_TRANSPORT: "resend", AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" } },
        secretEnv: { core: { ADMIN_GRANTS: "OPERATOR_ADMINS" }, portal: { PORTAL_SESSION_SECRET: "SESSION_KEY" } },
      }),
    );
    writeFileSync(join(dir, ".env"), `OPERATOR_ADMINS=${settings.adminGrants}\nSESSION_KEY=${settings.secret}\n`);
    const result = spawnSync(process.execPath, [cli, "admin-login"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      openAdminLogin(tokenFrom(result.stdout.trim()), settings.secret, settings.publicUrl)?.email,
      "admin@example.com",
    );
    assert.doesNotMatch(result.stdout, new RegExp(settings.secret));
    const invalid = spawnSync(process.execPath, [cli, "admin-login", "--email", "member@example.com"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command runs inside a deployment using environment variables alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-admin-login-env-"));
  try {
    const env = {
      ...process.env,
      PORTAL_PUBLIC_URL: settings.publicUrl,
      PORTAL_SESSION_SECRET: settings.secret,
      ADMIN_GRANTS: settings.adminGrants,
    };
    const result = spawnSync(process.execPath, [cli, "admin-login"], { cwd: dir, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      openAdminLogin(tokenFrom(result.stdout.trim()), settings.secret, settings.publicUrl)?.email,
      "admin@example.com",
    );
    for (const args of [["--ttl", "999"], ["--secret", "unsafe"], ["unexpected"]]) {
      const invalid = spawnSync(process.execPath, [cli, "admin-login", ...args], { cwd: dir, encoding: "utf8", env });
      assert.notEqual(invalid.status, 0);
      assert.equal(invalid.stdout, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
