import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testTenant } from "./support/test-tenant.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { principalDestination } from "../src/reach/reach.ts";
import { personalScope } from "../src/types.ts";

test("a cron shared with a person becomes their paused linked copy until they edit it", async () => {
  const { app } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cron-share-")) }));
  const source = await app.createCron({
    ownerScopeId: personalScope("U1"),
    owner: "U1",
    createdBy: "U1",
    title: "Weather",
    schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
    action: "weather in SF",
  });

  const { copy } = await app.shareCron(testTenant, source.id, "U2", "U1");
  assert.equal(copy.owner, "U2");
  assert.equal(copy.ownerScopeId, personalScope("U2"));
  assert.equal(copy.enabled, false);
  assert.equal(copy.destination?.type, "web");
  const notice = (await app.pendingDeliveries("web")).find((d) => d.destination.target === copy.destination?.target);
  assert.match(notice?.text ?? "", new RegExp(`turning cron ${copy.id} on`));
  assert.equal((await app.shareCron(testTenant, source.id, "U2", "U1")).copy.id, copy.id);

  await app.updateCron(source.id, { action: "weather in Oakland" }, { actorId: "U1" });
  assert.equal((await app.getCron(copy.id))?.action, "weather in Oakland");

  await app.updateCron(copy.id, { title: "My weather" }, { actorId: "U2" });
  await app.updateCron(source.id, { action: "weather in Berkeley" }, { actorId: "U1" });
  const forked = await app.getCron(copy.id);
  assert.ok(forked?.forkedAt);
  assert.equal(forked.action, "weather in Oakland");
  const { owned } = await app.listCronsForViewer("U1");
  assert.deepEqual(
    owned.find((c) => c.id === source.id)?.copies?.map((c) => [c.owner, c.status, c.deliversTo]),
    [["U2", "edited", "web"]],
  );
});

test("unsharing a cron detaches each copy and leaves it with its owner", async () => {
  const { app } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cron-unshare-")) }));
  const source = await app.createCron({
    ownerScopeId: personalScope("U1"),
    owner: "U1",
    createdBy: "U1",
    schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
    action: "weather in SF",
  });
  const paused = (await app.shareCron(testTenant, source.id, "U2", "U1")).copy;
  const accepted = (await app.shareCron(testTenant, source.id, "U3", "U1")).copy;
  await app.updateCron(accepted.id, { enabled: true }, { actorId: "U3" });

  await app.unshareCron(source.id, "U2");
  await app.unshareCron(source.id, "U3");
  assert.equal((await app.getCron(paused.id))?.sharedFrom, undefined);
  assert.equal((await app.getCron(accepted.id))?.enabled, true);
  assert.deepEqual(await app.cronCopies(source.id), []);
});

test("a copy of a project cron keeps its persona and project, and the persona's owner lends it to the recipient", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cron-share-origin-")) }));
  const { app } = built;
  for (const who of ["U1", "U2"]) await built.featureFlags.setEnabled("personas", personalScope(who), true, "admin");
  const project = (await app.createProject("U1", "Launch"))!;
  const persona = await app.personas!.create("U1", { name: "Ada" });
  assert.equal(persona.status, "ok");
  const personaId = (persona as { value: { id: string } }).value.id;
  const { session } = (await app.spawnSession("U1", { scopeId: projectScopeId(project.id), title: "Launch" }))!;
  await built.sessions.setPersona(session.id, personaId);
  const source = await app.createCron({
    ownerScopeId: projectScopeId(project.id),
    owner: "U1",
    createdBy: "U1",
    sessionRef: session.threadRef,
    destination: principalDestination("U1", "U1"),
    schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
    action: "launch status",
  });

  const { copy, note } = await app.shareCron(testTenant, source.id, "U2", "U1");
  assert.match(note ?? "", /posts as the persona Ada: they now have read access/);
  assert.equal(await app.personas!.role("U2", personaId), "read");
  assert.deepEqual(await app.cronOrigin(copy), { personaId, project: { id: project.id, name: "Launch" } });
});
