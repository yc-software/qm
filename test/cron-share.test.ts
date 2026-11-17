import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

test("a cron shared with a person becomes their paused linked copy until they edit it", async () => {
  const { app } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cron-share-")) }));
  const source = await app.createCron({
    ownerScopeId: "personal:U1",
    owner: "U1",
    createdBy: "U1",
    title: "Weather",
    schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
    action: "weather in SF",
  });

  const { copy } = await app.shareCron(source.id, "U2", "U1");
  assert.equal(copy.owner, "U2");
  assert.equal(copy.ownerScopeId, "personal:U2");
  assert.equal(copy.enabled, false);
  assert.equal(copy.destination?.type, "web");
  const notice = (await app.pendingDeliveries("web")).find((d) => d.destination.target === copy.destination?.target);
  assert.match(notice?.text ?? "", new RegExp(`turning cron ${copy.id} on`));
  assert.equal((await app.shareCron(source.id, "U2", "U1")).copy.id, copy.id);

  await app.updateCron(source.id, { action: "weather in Oakland" }, { actorId: "U1" });
  assert.equal((await app.getCron(copy.id))?.action, "weather in Oakland");

  await app.updateCron(copy.id, { title: "My weather" }, { actorId: "U2" });
  await app.updateCron(source.id, { action: "weather in Berkeley" }, { actorId: "U1" });
  const forked = await app.getCron(copy.id);
  assert.ok(forked?.forkedAt);
  assert.equal(forked.action, "weather in Oakland");
  const { owned } = await app.listCronsForViewer("U1");
  assert.deepEqual(
    owned.find((c) => c.id === source.id)?.copies?.map((c) => [c.owner, Boolean(c.forkedAt)]),
    [["U2", true]],
  );
});
