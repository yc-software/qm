import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { createMemoryConfigStore, type PersistedLocale } from "../src/resolution/config-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("config store: locale round-trips durable storage and clears to inherit", async () => {
  const c = createMemoryConfigStore("default-org");
  const alice = scopeId("personal", "alice");
  assert.equal(await c.getLocaleDurable(alice), null);
  await c.setLocaleLatest(alice, "zh-CN");
  assert.equal(await c.getLocaleDurable(alice), "zh-CN");
  await c.setLocaleLatest(alice, "ko");
  assert.equal(await c.getLocaleDurable(alice), "ko");
  await c.setLocaleLatest(alice, null);
  assert.equal(await c.getLocaleDurable(alice), null);
});

test("config store: the durable read sees a flip from another instance", async () => {
  const store = createMemoryMap<PersistedLocale>();
  const a = createMemoryConfigStore("default-org", { locales: store });
  const b = createMemoryConfigStore("default-org", { locales: store });
  const alice = scopeId("personal", "alice");
  await a.setLocaleLatest(alice, "ja");
  assert.equal(await b.getLocaleDurable(alice), "ja");
});

test("GET/PUT /v1/locale: self-service set, read-back, inherit, and validation", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "locale-pref-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    auditLog: built.auditLog,
    orgLocale: "zh-CN",
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const qs = "principalId=alice&scopeId=personal%3Aalice";
  try {
    const initial = await fetch(`${base}/v1/locale?${qs}`);
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { scopeId: "personal:alice", locale: null, orgLocale: "zh-CN" });

    const bad = await fetch(`${base}/v1/locale`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:alice", locale: "fr" }),
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error?: string }).error, "unsupported_locale");

    const set = await fetch(`${base}/v1/locale`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:alice", locale: "ja" }),
    });
    assert.equal(set.status, 200);

    const read = await fetch(`${base}/v1/locale?${qs}`);
    assert.equal(((await read.json()) as { locale?: string | null }).locale, "ja");

    const inherit = await fetch(`${base}/v1/locale`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:alice", locale: null }),
    });
    assert.equal(inherit.status, 200);
    assert.equal(await built.config.getLocaleDurable(scopeId("personal", "alice")), null);

    const foreign = await fetch(`${base}/v1/locale`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:bob", locale: "ko" }),
    });
    assert.equal(foreign.status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("surface-config advertises the locale registry and the org default", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "locale-surface-")) }));
  const server = createInsecureTestServer(built.app, { config: built.config, orgLocale: "ko" });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/surface-config`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      orgLocale?: string;
      locales?: Array<{ id: string; name: string }>;
    };
    assert.equal(body.orgLocale, "ko");
    assert.deepEqual(
      body.locales?.map((l) => l.id),
      ["en", "zh-CN", "ja", "ko"],
    );
    assert.ok(body.locales?.every((l) => typeof l.name === "string" && l.name.length > 0));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("surface-config omits orgLocale when the org sets no default", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "locale-surface-none-")) }));
  const server = createInsecureTestServer(built.app, { config: built.config });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/surface-config`);
    const body = (await res.json()) as { orgLocale?: string };
    assert.equal(body.orgLocale, undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
