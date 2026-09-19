import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { testConfig } from "./support/test-config.ts";
import { cachedModelCatalog, selectableModelCatalog } from "../src/model/model-catalog.ts";

const ADMIN = { "x-admin-actor": "admin-alice@default-org" };

function start(overrides: Partial<ServerDeps> = {}) {
  const config = testConfig();
  const built = buildApp(config);
  const deps = { ...serverDeps(config, built), ...overrides };
  const server = createInsecureTestServer(built.app, deps);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { built, deps, base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const scopePath = "/v1/admin/scopes/org%3Adefault-org";

test("settings projections preserve values while excluding unrelated payloads", async (t) => {
  const srv = start();
  t.after(srv.close);
  srv.built.config.setBranding("org:default-org", { selfLabel: "Test assistant", accent: "#445566" });
  await srv.built.config.setTurnWallClockSec("org:default-org", 120);
  await srv.built.config.flushScope("org:default-org");
  await srv.built.directory.replaceChannels([{ channelId: "C-settings", name: "settings-test" }]);
  const full = (await (await fetch(srv.base + scopePath, { headers: ADMIN })).json()) as Record<string, unknown>;
  for (const view of [
    "customize",
    "governance",
    "models",
    "credentials",
    "connectors",
    "slack-settings",
    "onboarding",
  ]) {
    const response = await fetch(srv.base + scopePath + "?view=" + view, { headers: ADMIN });
    assert.equal(response.status, 200, view);
    const projected = (await response.json()) as Record<string, unknown> & { branding: { selfLabel: string } };
    for (const [key, value] of Object.entries(projected)) assert.deepEqual(value, full[key], view + ":" + key);
    if (view !== "credentials") assert.equal("serviceCredentials" in projected, false, view);
    else assert.deepEqual(projected.directoryChannels, [{ channelId: "C-settings", name: "settings-test" }]);
    assert.match(response.headers.get("server-timing") ?? "", /authorize;dur=/);
    if (["customize", "credentials", "connectors"].includes(view))
      assert.equal("modelsByHarness" in projected, false, view);
    if (view === "slack-settings") {
      for (const key of ["externalSlackParticipants", "internalMemberOverrides", "channelHeaderPinDefault", "ackEmoji"])
        assert.equal(key in projected, true);
      assert.equal("orgAmbient" in projected, false);
    }
    if (view === "customize") {
      assert.equal(projected.branding.selfLabel, "Test assistant");
      assert.equal("turnWallClockSec" in projected, false);
      assert.equal("orgAmbient" in projected, false);
      assert.equal("channelHeaderPinDefault" in projected, false);
      assert.equal("soulHistory" in projected, true);
      assert.equal("connectors" in projected, false);
    }
  }
});

test("Customize completes within 500 ms with unrelated model and credential services unavailable", async (t) => {
  const fail = () => {
    throw new Error("Unrelated dependency must not be called");
  };
  const srv = start({ refreshModels: fail, modelCredentialFetch: fail });
  t.after(srv.close);
  t.mock.method(srv.built.serviceCreds, "listServiceCredentials", fail);
  t.mock.method(srv.built.config, "listConnectorClients", fail);
  t.mock.method(srv.built.config, "getSecurityPostureDurable", fail);
  const started = performance.now();
  const response = await fetch(srv.base + scopePath + "?view=customize", { headers: ADMIN });
  assert.equal(response.status, 200);
  assert.equal(typeof ((await response.json()) as { soul: string }).soul, "string");
  assert.ok(performance.now() - started < 500);
});

test("independent governance reads overlap rather than accumulating network round trips", async (t) => {
  const srv = start();
  t.after(srv.close);
  const reads = [
    "getSecurityPostureDurable",
    "getSharingPostureDurable",
    "getSharingPostureOwnDurable",
    "getApprovalGrantModesDurable",
  ] as const;
  let active = 0;
  let maxActive = 0;
  for (const name of reads) {
    const original = srv.built.config[name].bind(srv.built.config);
    t.mock.method(srv.built.config, name, async (scope: string) => {
      active++;
      maxActive = Math.max(active, maxActive);
      await delay(100);
      active--;
      return original(scope);
    });
  }
  const started = performance.now();
  const response = await fetch(srv.base + scopePath + "?view=governance", { headers: ADMIN });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(maxActive, reads.length);
  assert.ok(performance.now() - started < 500);
});

test("each settings projection retains authorization before reading configuration", async (t) => {
  let reads = 0;
  const srv = start({
    refreshModels: async () => {
      reads++;
    },
  });
  t.after(srv.close);
  t.mock.method(srv.built.config, "refreshScope", async () => {
    reads++;
  });
  for (const view of [
    "customize",
    "governance",
    "models",
    "credentials",
    "connectors",
    "slack-settings",
    "onboarding",
  ]) {
    const response = await fetch(srv.base + scopePath + "?view=" + view, {
      headers: { "x-admin-actor": "nobody@default-org" },
    });
    assert.equal(response.status, 403);
  }
  assert.equal(reads, 0);
  assert.equal((await fetch(srv.base + scopePath + "?view=toString", { headers: ADMIN })).status, 400);
});

test("Models settings do not wait for a cold external model catalog", async (t) => {
  const pending = Promise.withResolvers<Response>();
  const fetcher: typeof fetch = () => pending.promise;
  const srv = start({ modelCredentialFetch: fetcher });
  t.after(srv.close);
  t.after(() => pending.resolve(Response.json({ data: [] })));
  t.mock.method(srv.built.modelCredentials, "availability", async () => ({
    anthropic: true,
    openai: true,
    openrouter: true,
  }));
  await srv.built.config.setRuntimeSelectionLatest("org:default-org", {
    harnessId: "pi",
    modelId: "settings/previously-saved-model",
  });
  const started = performance.now();
  const response = await fetch(srv.base + scopePath + "?view=models", {
    headers: ADMIN,
    signal: AbortSignal.timeout(500),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    baseModelOptions: { id: string }[];
    modelsByHarness: Record<string, { id: string }[]>;
    runtime: { modelId: string };
    modelCatalogRefreshing: boolean;
  };
  assert.ok(body.baseModelOptions.length > 0);
  assert.equal(body.runtime.modelId, "settings/previously-saved-model");
  assert.ok(body.modelsByHarness.pi!.some((model) => model.id === body.runtime.modelId));
  assert.equal(body.modelCatalogRefreshing, true);
  assert.ok(performance.now() - started < 500);
});

test("cached model catalogs refresh in the background and retain dynamic entries after expiry", async (t) => {
  let requests = 0;
  let release = Promise.withResolvers<Response>();
  const fetcher: typeof fetch = () => {
    requests++;
    return release.promise;
  };
  assert.ok(cachedModelCatalog(fetcher).models.length > 0);
  assert.ok(cachedModelCatalog(fetcher).models.length > 0);
  assert.equal(requests, 1);
  release.resolve(
    Response.json({
      data: [
        {
          id: "testing/settings-fast",
          name: "Settings test",
          context_length: 8192,
          pricing: { prompt: "0", completion: "0" },
          top_provider: { max_completion_tokens: 1024 },
          architecture: { input_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    }),
  );
  await selectableModelCatalog(fetcher);
  assert.ok(cachedModelCatalog(fetcher).models.some((m) => m.id === "testing/settings-fast"));
  const later = Date.now() + 6 * 60_000;
  t.mock.method(Date, "now", () => later);
  release = Promise.withResolvers<Response>();
  assert.ok(cachedModelCatalog(fetcher).models.some((m) => m.id === "testing/settings-fast"));
  assert.equal(requests, 2);
  release.reject(new Error("Catalog offline"));
  await selectableModelCatalog(fetcher);
  assert.ok(cachedModelCatalog(fetcher).models.some((m) => m.id === "testing/settings-fast"));
});
