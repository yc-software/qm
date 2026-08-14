import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { openAdminBootstrapToken } from "../plugins/chassis/src/admin-bootstrap.ts";
import { scopeId } from "../src/types.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

interface Harness {
  base: string;
  delivered: Array<Record<string, unknown>>;
  setValidationFailure(value: boolean | string): void;
  close(): Promise<void>;
  built: ReturnType<typeof buildApp>;
}

async function start(options: { beforeAdminStatus?: () => Promise<void> } = {}): Promise<Harness> {
  let validationFailure: string | null = null;
  const delivered: Array<Record<string, unknown>> = [];
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "auth-email-route-")),
    authServiceUrl: "http://auth.test",
  });
  const built = buildApp(config);
  await built.admin.createGrant(
    { id: "admin-alice", type: "internal" },
    { principalId: "admin@example.com", role: "org_admin", scopeId: scopeId("org", "default-org") },
  );
  const claimed = new Set<string>();
  const replayDedupe = {
    durable: true,
    async claim(key: string) {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
  const authServiceFetch: typeof fetch = async (raw, init) => {
    const url = new URL(String(raw));
    if (url.pathname === "/internal/email-settings/status") {
      const status = await built.authEmailSettings.status();
      return Response.json({
        state: status.configured ? "ready" : "unconfigured",
        source: status.configured ? "admin" : "absent",
        ...(status.version ? { activeVersion: status.version } : {}),
      });
    }
    if (
      url.pathname === "/internal/email-settings/validate" ||
      url.pathname === "/internal/email-settings/validate-environment"
    ) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      delivered.push(payload);
      if (validationFailure) {
        return Response.json({ error: "validation_failed", message: validationFailure }, { status: 400 });
      }
      if (url.pathname.endsWith("/validate")) {
        const settings = payload.settings as { access?: { mode?: string; emails?: string[]; domain?: string } };
        const recipient = String(payload.recipient ?? "");
        const allowed =
          settings.access?.mode === "emails"
            ? settings.access.emails?.includes(recipient)
            : recipient.endsWith(`@${settings.access?.domain}`);
        if (!allowed) {
          return Response.json(
            { error: "validation_failed", message: "the current administrator must remain allowed to sign in" },
            { status: 400 },
          );
        }
      }
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const admin = options.beforeAdminStatus
    ? {
        ...built.admin,
        async adminStatusOf(principal: Parameters<typeof built.admin.adminStatusOf>[0]) {
          await options.beforeAdminStatus!();
          return built.admin.adminStatusOf(principal);
        },
      }
    : built.admin;
  const server = createInsecureTestServer(built.app, {
    ...serverDeps(config, built),
    admin,
    authServiceFetch,
    replayDedupe,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    delivered,
    setValidationFailure(value) {
      if (!value) validationFailure = null;
      else validationFailure = typeof value === "string" ? value : "test delivery failed";
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    built,
  };
}

const actor = { "x-admin-actor": "admin@example.com@default-org" };
const resendBody = (expectedVersion: string | null, apiKey = "resend-secret") => ({
  expectedVersion,
  transport: "resend",
  from: "QM <no-reply@example.com>",
  access: { mode: "domain", domain: "example.com" },
  resend: { apiKey },
});
const smtpBody = (
  expectedVersion: string | null,
  password = "smtp-secret",
  connection: { host?: string; port?: number; tls?: "implicit" | "starttls" | "none"; username?: string } = {},
) => ({
  expectedVersion,
  transport: "smtp",
  from: "QM <no-reply@example.com>",
  access: { mode: "emails", emails: ["admin@example.com"] },
  smtp: {
    host: connection.host ?? "smtp.example.com",
    port: connection.port ?? 587,
    tls: connection.tls ?? "starttls",
    username: connection.username ?? "mailer",
    password,
  },
});

async function put(base: string, body: unknown, headers = actor): Promise<Response> {
  return fetch(`${base}/v1/admin/auth-email-settings`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("Admin validates and delivers before saving, retains write-only secrets, and rejects stale versions", async () => {
  const h = await start();
  try {
    const denied = await put(h.base, resendBody(null), { "x-admin-actor": "user@example.com@default-org" });
    assert.equal(denied.status, 403);

    const excluded = await put(h.base, { ...resendBody(null), access: { mode: "domain", domain: "elsewhere.test" } });
    assert.equal(excluded.status, 400);
    assert.equal((await h.built.authEmailSettings.status()).managed, false);

    h.setValidationFailure(true);
    const failed = await put(h.base, resendBody(null));
    assert.equal(failed.status, 400);
    assert.equal((await h.built.authEmailSettings.status()).managed, false);

    h.setValidationFailure(false);
    const saved = await put(h.base, resendBody(null));
    assert.equal(saved.status, 200);
    const first = (await saved.json()) as { version: string; resend: Record<string, unknown> };
    assert.equal(first.resend.apiKeySet, true);
    assert.equal(first.resend.apiKey, undefined);
    assert.equal(JSON.stringify(first).includes("resend-secret"), false);
    assert.equal(h.delivered.at(-1)?.recipient, "admin@example.com");

    const retained = await put(h.base, resendBody(first.version, ""));
    assert.equal(retained.status, 200);
    const received = h.delivered.at(-1)?.settings as { resend?: { apiKey?: string } };
    assert.equal(received.resend?.apiKey, "resend-secret");

    const deliveriesBeforeConflict = h.delivered.length;
    const conflict = await put(h.base, resendBody(first.version, "replacement"));
    assert.equal(conflict.status, 409);
    assert.equal(h.delivered.length, deliveriesBeforeConflict);
  } finally {
    await h.close();
  }
});

test("a blank SMTP password is retained only for the exact saved connection identity", async () => {
  const h = await start();
  try {
    const saved = await put(h.base, smtpBody(null));
    assert.equal(saved.status, 200);
    const first = (await saved.json()) as { version: string };
    const deliveriesBeforeChangedHost = h.delivered.length;

    const changedHost = await put(h.base, smtpBody(first.version, "", { host: "collector.example.net" }));
    assert.equal(changedHost.status, 400);
    assert.match(await changedHost.text(), /smtp\.password is required/);
    assert.equal(h.delivered.length, deliveriesBeforeChangedHost);

    const retained = await put(h.base, smtpBody(first.version, ""));
    assert.equal(retained.status, 200);
    const received = h.delivered.at(-1)?.settings as { smtp?: { password?: string } };
    assert.equal(received.smtp?.password, "smtp-secret");
  } finally {
    await h.close();
  }
});

test("a stale draft retains only the secret from its matching version snapshot", async () => {
  const h = await start();
  try {
    const saved = await put(h.base, smtpBody(null, "version-one-secret"));
    const first = (await saved.json()) as { version: string };
    const originalSnapshot = h.built.authEmailSettings.snapshot.bind(h.built.authEmailSettings);
    let entered!: () => void;
    let release!: () => void;
    const captured = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.built.authEmailSettings.snapshot = async () => {
      const snapshot = await originalSnapshot();
      entered();
      await gate;
      return snapshot;
    };

    const staleSave = put(h.base, smtpBody(first.version, ""));
    await captured;
    await h.built.authEmailSettings.set(
      {
        transport: "smtp",
        from: "QM <no-reply@example.com>",
        access: { mode: "emails", emails: ["admin@example.com"] },
        smtp: {
          host: "smtp.example.com",
          port: 587,
          tls: "starttls",
          username: "mailer",
          password: "version-two-secret",
        },
      },
      "second-admin@example.com",
      first.version,
    );
    release();

    const response = await staleSave;
    assert.equal(response.status, 409);
    const received = h.delivered.at(-1)?.settings as { smtp?: { password?: string } };
    assert.equal(received.smtp?.password, "version-one-secret");
  } finally {
    await h.close();
  }
});

test("Core replaces an Auth validation error that contains candidate secrets or authorization headers", async () => {
  const h = await start();
  try {
    h.setValidationFailure("Authorization: Bearer resend-secret; apiKey=resend-secret");
    const response = await put(h.base, resendBody(null));
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.match(text, /auth email service rejected the request/);
    assert.doesNotMatch(text, /resend-secret|Authorization|Bearer/i);
  } finally {
    await h.close();
  }
});

test("bootstrap is durable and single-use, becomes permanently disabled, and fallback changes only after testing", async () => {
  const h = await start();
  try {
    const prematureFallback = await fetch(`${h.base}/v1/operator/auth-email-settings/fallback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: "admin@example.com" }),
    });
    assert.equal(prematureFallback.status, 409);

    const consume = (jti: string, org = "default-org") =>
      fetch(`${h.base}/v1/auth/bootstrap/consume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principal: "admin@example.com",
          org,
          jti,
          expiresAtMs: Date.now() + 60_000,
        }),
      });
    assert.equal((await consume("cross-org", "other-org")).status, 400);
    assert.equal((await consume("one-time")).status, 200);
    assert.equal((await consume("one-time")).status, 409);

    const saved = await put(h.base, resendBody(null));
    assert.equal(saved.status, 200);
    assert.equal((await consume("after-setup")).status, 403);

    h.setValidationFailure(true);
    const failed = await fetch(`${h.base}/v1/operator/auth-email-settings/fallback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: "admin@example.com" }),
    });
    assert.equal(failed.status, 400);
    assert.equal((await h.built.authEmailSettings.status()).source, "admin");

    h.setValidationFailure(false);
    const fallback = await fetch(`${h.base}/v1/operator/auth-email-settings/fallback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: "admin@example.com" }),
    });
    assert.equal(fallback.status, 200);
    assert.equal((await h.built.authEmailSettings.status()).source, "environment");
    assert.equal(await h.built.authEmailSettings.hasEverBeenManaged(), true);
    assert.equal((await consume("after-fallback")).status, 403);
    const actions = (await h.built.auditLog.events()).map((event) => event.action);
    assert.ok(actions.includes("auth-email-settings.bootstrap"));
    assert.ok(actions.includes("auth-email-settings.update"));
    assert.ok(actions.includes("auth-email-settings.fallback"));
  } finally {
    await h.close();
  }
});

test("first configuration atomically closes an in-flight bootstrap consumption", async () => {
  let entered!: () => void;
  let release!: () => void;
  const captured = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = await start({
    async beforeAdminStatus() {
      entered();
      await gate;
    },
  });
  try {
    const consuming = fetch(`${h.base}/v1/auth/bootstrap/consume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principal: "admin@example.com",
        org: "default-org",
        jti: "racing-bootstrap",
        expiresAtMs: Date.now() + 60_000,
      }),
    });
    await captured;
    await h.built.authEmailSettings.set(
      {
        transport: "resend",
        from: "QM <no-reply@example.com>",
        access: { mode: "domain", domain: "example.com" },
        resend: { apiKey: "configured-during-bootstrap" },
      },
      "admin@example.com",
      null,
    );
    release();
    const response = await consuming;
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: string }).error, "bootstrap_disabled");
  } finally {
    release();
    await h.close();
  }
});

test("the signed deployment channel asks Core to mint a bootstrap token and Core closes it after first setup", async () => {
  const secret = "core-signing-secret-that-is-long-enough-for-source-auth";
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "auth-email-bootstrap-")),
    signingSecret: secret,
  });
  const built = buildApp(config);
  await built.admin.createGrant(
    { id: "admin-alice", type: "internal" },
    { principalId: "admin@example.com", role: "org_admin", scopeId: scopeId("org", "default-org") },
  );
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const path = "/v1/operator/auth-email-settings/bootstrap";
  const request = async (principal: string) => {
    const body = JSON.stringify({ principal });
    const target = `${path}?nonce=${crypto.randomUUID()}`;
    return fetch(`${base}${target}`, { method: "POST", headers: signedHeaders(secret, "POST", target, body), body });
  };
  try {
    const unsigned = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: "admin@example.com" }),
    });
    assert.equal(unsigned.status, 401);
    assert.equal((await request("not-admin@example.com")).status, 403);
    const response = await request("admin@example.com");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { token: string; expiresAt: number };
    const claims = openAdminBootstrapToken(payload.token, secret);
    assert.equal(claims?.principal, "admin@example.com");
    assert.equal(claims?.org, "default-org");
    assert.equal(payload.expiresAt, claims!.exp * 1000);
    assert.ok((await built.auditLog.events()).some((event) => event.action === "auth-email-settings.bootstrap-link"));

    await built.authEmailSettings.set(
      {
        transport: "resend",
        from: "QM <no-reply@example.com>",
        access: { mode: "domain", domain: "example.com" },
        resend: { apiKey: "secret" },
      },
      "admin@example.com",
      null,
    );
    assert.equal((await request("admin@example.com")).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
