import { verificationUpstream } from "./support/model-verification-upstream.ts";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { test } from "node:test";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createModelOverlayStore } from "../src/model/model-overlay-store.ts";

const databaseUrl = process.env.MODEL_OVERLAY_TEST_DATABASE_URL;
const headers = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const runtimePath = "/v1/runtime-config?principalId=admin-alice@default-org&scopeId=personal:admin-alice@default-org";

async function start(databaseUrl: string, upstream: string) {
  const child = fork(new URL("./support/model-overlay-server.ts", import.meta.url), {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, MODEL_OVERLAY_TEST_DATABASE_URL: databaseUrl, MODEL_OVERLAY_TEST_UPSTREAM: upstream },
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  const message = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw new Error("local API child exited before listening");
    }),
  ]);
  clearTimeout(timeout);
  return { child, base: (message[0] as { base: string }).base };
}

async function stop(child: ChildProcess) {
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

test(
  "Postgres persistence: two serving processes refresh add/update/delete, including a cold start",
  { skip: !databaseUrl, timeout: 90_000 },
  async (t) => {
    assert.ok(databaseUrl);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname),
      "use a dedicated local test database",
    );
    const upstream = await verificationUpstream();
    t.after(() => upstream.close());
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const schema = `model_overlay_${randomUUID().replaceAll("-", "")}`;
    t.after(async () => {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    });
    await pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
    const isolatedDatabaseUrl = url.toString();
    const factory = createPostgresMapFactory(isolatedDatabaseUrl);
    const processes: ChildProcess[] = [];
    try {
      const first = await start(isolatedDatabaseUrl, upstream.url);
      processes.push(first.child);
      const second = await start(isolatedDatabaseUrl, upstream.url);
      processes.push(second.child);
      const read = async (base: string) => {
        const response = await fetch(base + runtimePath, { headers });
        assert.equal(response.status, 200);
        return (await response.json()) as {
          effective: { modelId: string };
          unavailableReason?: string;
          modelCatalog: Record<string, { name: string; contextWindow: number }>;
        };
      };
      assert.equal((await read(second.base)).modelCatalog["overlay-pg-model"], undefined);
      const spec = {
        verify: true,
        name: "Future PG model",
        provider: "openai",
        template: "gpt-5.5",
        contextWindow: 400_000,
        maxTokens: 20_000,
        cost: { input: 7, output: 21, cacheRead: 0.3, cacheWrite: 8 },
      };
      const path = first.base + "/v1/admin/model-registry/overlay-pg-model";
      assert.equal((await fetch(path, { method: "PUT", headers, body: JSON.stringify(spec) })).status, 200);
      assert.equal((await read(second.base)).modelCatalog["overlay-pg-model"]?.contextWindow, 400_000);
      assert.equal((await read(second.base)).effective.modelId, "overlay-pg-model");
      assert.equal(
        (await fetch(path, { method: "PUT", headers, body: JSON.stringify({ ...spec, contextWindow: 600_000 }) }))
          .status,
        200,
      );
      assert.equal((await read(second.base)).modelCatalog["overlay-pg-model"]?.contextWindow, 600_000);
      const raced = await Promise.all([
        fetch(first.base + "/v1/admin/model-registry/overlay-race-model", {
          method: "PUT",
          headers,
          body: JSON.stringify(spec),
        }),
        fetch(second.base + "/v1/admin/custom-providers/race-gateway", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            name: "Race gateway",
            protocol: "openai",
            baseUrl: "https://example.invalid/v1",
            models: [{ id: "overlay-race-model" }],
          }),
        }),
      ]);
      assert.deepEqual(
        raced.map((response) => response.status),
        raced[0]!.status === 200 ? [200, 400] : [409, 200],
      );
      await read(first.base);
      await read(second.base);
      const cold = await start(isolatedDatabaseUrl, upstream.url);
      processes.push(cold.child);
      const coldConfig = await read(cold.base);
      assert.equal(coldConfig.effective.modelId, "overlay-pg-model");
      assert.equal(coldConfig.modelCatalog["overlay-pg-model"]?.contextWindow, 600_000);
      const reloaded = createModelOverlayStore(factory.map("model_registry"));
      assert.equal(
        (await reloaded.statuses()).find((m) => m.spec.id === "overlay-pg-model")?.spec.contextWindow,
        600_000,
      );
      assert.equal((await fetch(path, { method: "DELETE", headers })).status, 200);
      for (const instance of [second, cold]) {
        const deleted = await read(instance.base);
        assert.equal(deleted.modelCatalog["overlay-pg-model"], undefined);
        assert.equal(deleted.effective.modelId, "overlay-pg-model");
        assert.match(deleted.unavailableReason ?? "", /deleted/);
      }
    } finally {
      await Promise.all(processes.map(stop));
      await factory.pool.close();
    }
  },
);
