import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresUpdateJobStore } from "../src/updates/postgres-update-job-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL to run the Postgres update-job tests";

test("Postgres update jobs survive store instances and serialize active requests", { skip }, async () => {
  const writer = createPostgresUpdateJobStore(URL!);
  const reader = createPostgresUpdateJobStore(URL!);
  const scopeId = `org:update-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const first = await writer.create({
      scopeId,
      requestedBy: "admin@example.com",
      currentVersion: "0.1.9",
      targetVersion: "0.2.0",
    });
    assert.equal(first.created, true);
    assert.deepEqual(await reader.get(scopeId, first.job.id), first.job);
    const duplicate = await reader.create({
      scopeId,
      requestedBy: "other@example.com",
      currentVersion: "0.1.9",
      targetVersion: "0.2.0",
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);
    await writer.update(scopeId, first.job.id, "dispatching", { state: "succeeded", detail: "Deployed" });
    assert.equal(
      await reader.update(scopeId, first.job.id, "dispatching", { state: "running", detail: "Deploying" }),
      null,
    );
    assert.equal((await reader.get(scopeId, first.job.id))?.state, "succeeded");
    const next = await reader.create({
      scopeId,
      requestedBy: "admin@example.com",
      currentVersion: "0.2.0",
      targetVersion: "0.2.1",
    });
    assert.equal(next.created, true);
  } finally {
    await writer.close?.();
    await reader.close?.();
  }
});
