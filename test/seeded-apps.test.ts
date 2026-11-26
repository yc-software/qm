import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSeededApp } from "../src/deploy/seeded-apps.ts";
import type { DeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore, type PublishedApp } from "../src/deploy/deploy-store.ts";
import { testDeployBackings } from "./support/test-database.ts";
import type { AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { personalScope } from "../src/types.ts";

const signOff = async () => true;

function fakeDeploy() {
  const apps = new Map<string, PublishedApp & { env?: Record<string, string>; paths?: string[] }>();
  const calls: string[] = [];
  const deploy = {
    seededApp: async (createdBy: string, seed: string) =>
      [...apps.values()].find((d) => d.createdBy === createdBy && d.seed === seed) ?? null,
    deploy: async (input: Parameters<DeployService["deploy"]>[0]) => {
      calls.push("deploy");
      const d = {
        id: `app-${apps.size + 1}`,
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        ...(input.seed ? { seed: input.seed } : {}),
        currentVersion: 1,
        status: "running",
        endpoint: null,
        versions: [],
        env: input.stampEnv,
        paths: input.files.map((f) => f.path).sort(),
      } as PublishedApp & { env?: Record<string, string>; paths?: string[] };
      apps.set(d.id, d);
      return d;
    },
    redeploy: async (id: string) => {
      calls.push("redeploy");
      return apps.get(id)!;
    },
    setAppDisplayName: async (id: string, displayName: string) => Object.assign(apps.get(id)!, { displayName }),
    setAppEmbedAncestors: async (id: string, embedAncestors: string[]) =>
      Object.assign(apps.get(id)!, { embedAncestors }),
    setAppConnectors: async (id: string, connectors: string[]) => Object.assign(apps.get(id)!, { connectors }),
  } as unknown as DeployService;
  const lock = { withLock: (_key: string, fn: () => Promise<unknown>) => fn() } as unknown as AdvisoryLock;
  return { deps: { deploy, lock, publicWebUrl: "https://qm.example.com/ui" }, calls };
}

test("a person's seeded calendar is created once, lent Google, and reset in place", async () => {
  const { deps, calls } = fakeDeploy();
  const first = (await ensureSeededApp(deps, "ada@example.com", "calendar", { signOff })) as PublishedApp & {
    env?: Record<string, string>;
    paths?: string[];
  };
  assert.deepEqual(
    [first.seed, first.ownerScopeId, first.displayName, first.connectors, first.embedAncestors, first.env],
    [
      "calendar",
      personalScope("ada@example.com"),
      "Calendar",
      ["www.googleapis.com"],
      ["https://qm.example.com"],
      { QM_APP_OWNER: "ada@example.com" },
    ],
  );
  assert.ok(first.paths?.includes("server.mjs") && first.paths.includes("public/app.js"));
  assert.equal((await ensureSeededApp(deps, "ada@example.com", "calendar", { signOff })).id, first.id);
  assert.equal((await ensureSeededApp(deps, "ada@example.com", "calendar", { reset: true, signOff })).id, first.id);
  assert.notEqual((await ensureSeededApp(deps, "bo@example.com", "calendar", { signOff })).id, first.id);
  assert.deepEqual(calls, ["deploy", "redeploy", "deploy"]);
  await assert.rejects(
    ensureSeededApp(deps, "ada@example.com", "toString", { signOff }),
    /no seeded app named toString/,
  );
});

test("the store finds a person's seeded app whatever the case of their address", async () => {
  const store = createDeployStore(testDeployBackings());
  const version = { entrypoint: "node server.mjs", snapshotDir: "/tmp/seed", files: [] };
  const ada = personalScope("ada@example.com");
  const seeded = await store.create({ ...version, ownerScopeId: ada, createdBy: "ada@example.com", seed: "calendar" });
  await store.create({ ...version, ownerScopeId: ada, createdBy: "ada@example.com" });
  assert.equal((await store.findSeeded("Ada@Example.com", "calendar"))?.id, seeded.id);
  assert.equal(await store.findSeeded("ada@example.com", "inbox"), null);
  assert.equal(await store.findSeeded("bo@example.com", "calendar"), null);
});
