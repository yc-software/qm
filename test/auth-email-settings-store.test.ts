import assert from "node:assert/strict";
import test from "node:test";
import { AuthEmailSettingsConflict, createAuthEmailSettingsStore } from "../src/auth/email-settings.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const smtp = {
  transport: "smtp" as const,
  from: "QM <no-reply@example.com>",
  access: { mode: "emails" as const, emails: ["admin@example.com"] },
  smtp: {
    host: "smtp.example.com",
    port: 587,
    tls: "starttls" as const,
    username: "mailer",
    password: "smtp-secret-value",
  },
};

test("SMTP credentials are encrypted at rest and omitted from status", async () => {
  const backing = createMemoryMap<any>();
  const store = createAuthEmailSettingsStore({ orgId: "acme", backing, keyMaterial: "persistent-key" });
  const status = await store.set(smtp, "admin@example.com", null);

  assert.equal(status.configured, true);
  assert.equal(status.source, "admin");
  assert.equal(status.smtp?.passwordSet, true);
  assert.equal((status.smtp as Record<string, unknown>).password, undefined);
  assert.doesNotMatch(JSON.stringify(await backing.entries()), /smtp-secret-value/);
  const active = await store.get();
  assert.equal(active?.settings.transport, "smtp");
  assert.equal(active?.settings.transport === "smtp" ? active.settings.smtp.password : null, "smtp-secret-value");
});

test("Resend credentials are encrypted and stale administrators cannot overwrite a newer version", async () => {
  const backing = createMemoryMap<any>();
  const store = createAuthEmailSettingsStore({ orgId: "acme", backing, keyMaterial: "persistent-key" });
  const first = await store.set(smtp, "admin@example.com", null);
  const resend = {
    transport: "resend" as const,
    from: "QM <no-reply@example.com>",
    access: { mode: "domain" as const, domain: "example.com" },
    resend: { apiKey: "resend-secret-value" },
  };
  const second = await store.set(resend, "admin@example.com", first.version!);

  assert.equal(second.resend?.apiKeySet, true);
  assert.doesNotMatch(JSON.stringify(await backing.entries()), /resend-secret-value/);
  await assert.rejects(() => store.set(smtp, "other@example.com", first.version!), AuthEmailSettingsConflict);
  assert.equal((await store.get())?.settings.transport, "resend");
});

test("initial configuration is atomic and fallback leaves a permanent tombstone", async () => {
  const backing = createMemoryMap<any>();
  const store = createAuthEmailSettingsStore({ orgId: "acme", backing, keyMaterial: "persistent-key" });
  const attempts = await Promise.allSettled([
    store.set(smtp, "one@example.com", null),
    store.set({ ...smtp, from: "Two <two@example.com>" }, "two@example.com", null),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const current = await store.status();
  const fallback = await store.useEnvironment("deployment-cli", current.version!);
  assert.deepEqual(
    { configured: fallback.configured, managed: fallback.managed, source: fallback.source },
    { configured: false, managed: true, source: "environment" },
  );
  assert.equal(await store.get(), null);
  assert.equal(await store.hasEverBeenManaged(), true);
});

test("bootstrap permission shares the atomic initial-configuration record", async () => {
  const backing = createMemoryMap<any>();
  const store = createAuthEmailSettingsStore({ orgId: "acme", backing, keyMaterial: "persistent-key" });

  assert.equal(await store.permitBootstrap(), true);
  assert.deepEqual(await store.status(), { configured: false, managed: false, source: "absent" });
  assert.equal(await store.hasEverBeenManaged(), false);

  await store.set(smtp, "admin@example.com", null);
  assert.equal(await store.permitBootstrap(), false);
  assert.equal(await store.hasEverBeenManaged(), true);
});
