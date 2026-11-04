import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../src/connectors/connector-client-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import {
  replaceLoadedTenantSettings,
  tenantEnv,
  tenantSettingsSchema,
  type TenantSettings,
} from "../src/tenants/settings.ts";
import { tenantMailer } from "../src/tenants/tenant-mailer.ts";

const a = randomUUID();
const b = randomUUID();
const deploymentKey = deriveConnectorKey("deployment-connector-key", "keychain");

function load(): void {
  replaceLoadedTenantSettings(
    new Map<string, TenantSettings>([
      [
        a,
        {
          connectorSecretKey: "a".repeat(40),
          env: { ANTHROPIC_API_KEY: "anthropic-a", RESEND_API_KEY: "resend-a", AUTH_EMAIL_FROM: "a@a.test" },
        },
      ],
      [b, { connectorSecretKey: "b".repeat(40), env: { ANTHROPIC_API_KEY: "anthropic-b" } }],
    ]),
  );
}

afterEach(() => replaceLoadedTenantSettings(new Map()));

describe("per-tenant keys and settings", () => {
  it("decrypts a tenant's secret only under that tenant's key", () => {
    load();
    const sealed = withTenant(a, () => encryptSecret("token-a", deploymentKey));
    assert.equal(
      withTenant(a, () => decryptSecret(sealed, deploymentKey)),
      "token-a",
    );
    assert.throws(() => withTenant(b, () => decryptSecret(sealed, deploymentKey)));
    assert.throws(() => decryptSecret(sealed, deploymentKey));
  });

  it("keeps the deployment key when no tenant settings are loaded", () => {
    const sealed = encryptSecret("plain", deploymentKey);
    assert.equal(
      withTenant(a, () => decryptSecret(sealed, deploymentKey)),
      "plain",
    );
  });

  it("reads only the bound tenant's env values", () => {
    load();
    assert.equal(
      withTenant(a, () => tenantEnv("ANTHROPIC_API_KEY")),
      "anthropic-a",
    );
    assert.equal(
      withTenant(b, () => tenantEnv("ANTHROPIC_API_KEY")),
      "anthropic-b",
    );
    assert.equal(
      withTenant(b, () => tenantEnv("RESEND_API_KEY")),
      undefined,
    );
    assert.equal(tenantEnv("ANTHROPIC_API_KEY"), undefined);
  });

  it("accepts only allowlisted env names", () => {
    assert.equal(tenantSettingsSchema.safeParse({ env: { SPRITES_TOKEN: "t", BROKER_SECRET_X: "s" } }).success, true);
    assert.equal(tenantSettingsSchema.safeParse({ env: { DATABASE_URL: "postgres://x" } }).success, false);
    assert.equal(tenantSettingsSchema.safeParse({ env: { CORE_SIGNING_SECRET: "x" } }).success, false);
  });

  it("sends invite mail with the bound tenant's sender and key", async () => {
    load();
    const sent: { auth: string | null; from: unknown }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      const from = body && typeof body === "object" && "from" in body ? body.from : undefined;
      sent.push({ auth: new Headers(init?.headers).get("authorization"), from });
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    };
    const mailer = tenantMailer("resend-deployment", "ops@deploy.test", fetchImpl);
    const message = { to: "x@x.test", subject: "s", text: "t", html: "h" };
    await withTenant(a, () => mailer.send(message));
    await withTenant(b, () => mailer.send(message));
    await mailer.send(message);
    assert.deepEqual(sent, [
      { auth: "Bearer resend-a", from: "a@a.test" },
      { auth: "Bearer resend-deployment", from: "ops@deploy.test" },
      { auth: "Bearer resend-deployment", from: "ops@deploy.test" },
    ]);
  });
});
