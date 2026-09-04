import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-bg-activity-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

function registryRow(
  processId: string,
  sessionRef: string | undefined,
  over: Partial<{ kind: "build" | "dev-server" | "background"; ttlMs: number }> = {},
) {
  return {
    processId,
    scopeId: "personal:U1",
    kind: over.kind ?? ("background" as const),
    command: "sleep 600",
    ttlMs: over.ttlMs ?? 60_000,
    ...(sessionRef ? { sessionRef } : {}),
  };
}

function watchInput(
  threadRef: string,
  over: Partial<{ expiresAt: number; pattern: string; instructions: string }> = {},
) {
  return {
    ownerScopeId: "personal:U1" as const,
    owner: "U1",
    createdBy: "U1",
    processId: "p-watch",
    command: "npm test",
    threadRef,
    expiresAt: over.expiresAt ?? Date.now() + 60_000,
    ...(over.pattern ? { pattern: over.pattern } : {}),
    ...(over.instructions ? { instructions: over.instructions } : {}),
  };
}

test("listSessions counts detached work per conversation — live jobs and armed watches, keyed by threadRef", async () => {
  const { app, processes, monitors } = freshApp();
  assert.ok(processes, "test sandbox supports process sessions");

  const busy = "web:U1:busy";
  const idle = "web:U1:idle";
  await app.turn(dm("kick off something long", busy));
  await app.turn(dm("just a question", idle));

  await processes!.register(registryRow("p-1", busy));
  await processes!.register(registryRow("p-2", busy));
  await monitors.create(watchInput(busy));

  await processes!.register(registryRow("p-devserver", busy, { kind: "dev-server" }));
  await processes!.register(registryRow("p-expired", busy, { ttlMs: -1 }));
  const exited = await processes!.register(registryRow("p-exited", busy));
  await processes!.markStatus(exited.processId, "exited");
  await processes!.register(registryRow("p-unowned", undefined));
  await monitors.create(watchInput(busy, { expiresAt: Date.now() - 1 }));

  const list = await app.listSessions("U1");
  const busyRow = list.find((s) => s.threadRef === busy);
  const idleRow = list.find((s) => s.threadRef === idle);
  assert.equal(busyRow?.backgroundJobs, 2, "live background jobs, this conversation's only");
  assert.equal(busyRow?.watches, 1, "armed unexpired watches only");
  assert.equal(idleRow?.backgroundJobs, undefined, "clean rows carry no zero-count fields");
  assert.equal(idleRow?.watches, undefined);
});

test("sessionBackground spells the badge out for the viewer — and stays invisible to strangers", async () => {
  const { app, processes, monitors } = freshApp();
  const thread = "web:U1:inspect";
  const r = await app.turn(dm("start the job", thread));
  const sessionId = r.sessionId!;

  await processes!.register(registryRow("p-1", thread));
  await monitors.create(watchInput(thread, { pattern: "error|FAILED", instructions: "summarize failures" }));

  const view = await app.sessionBackground(sessionId, "U1");
  assert.equal(view?.jobs.length, 1);
  assert.equal(view?.jobs[0]?.processId, "p-1");
  assert.equal(view?.jobs[0]?.command, "sleep 600");
  assert.ok((view?.jobs[0]?.expiresAt ?? 0) > Date.now(), "jobs carry their TTL deadline");
  assert.equal(view?.watches.length, 1);
  assert.equal(view?.watches[0]?.pattern, "error|FAILED");
  assert.equal(view?.watches[0]?.instructions, "summarize failures");

  assert.equal(await app.sessionBackground(sessionId, "U2"), null, "not the viewer's session — not even a 404 hint");
  assert.equal(await app.sessionBackground("nope", "U1"), null);
});

test("readSessionBackgroundOutput binds the job to the conversation, not just the scope", async () => {
  const { app, processes } = freshApp();
  const mine = "web:U1:mine";
  const other = "web:U1:other";
  const r1 = await app.turn(dm("conversation A", mine));
  const r2 = await app.turn(dm("conversation B", other));

  await processes!.register(registryRow("p-mine", mine));
  await processes!.register(registryRow("p-other", other));

  assert.equal(await app.readSessionBackgroundOutput(r1.sessionId!, "p-other", "U1", 0), null);
  assert.equal(await app.readSessionBackgroundOutput(r2.sessionId!, "p-other", "U2", 0), null);
  assert.equal(await app.readSessionBackgroundOutput(r1.sessionId!, "p-ghost", "U1", 0), null);
});

function cronInput(target: string | undefined, action: string) {
  return {
    ownerScopeId: "personal:U1" as const,
    owner: "U1",
    createdBy: "U1",
    schedule: { everyMs: 60_000 },
    action,
    ...(target ? { destination: { type: "web", target } } : {}),
  };
}

test("listSessions counts session-targeted crons — enabled and unarchived only, keyed by destination target", async () => {
  const { app, crons } = freshApp();
  const here = "web:U1:cronned";
  const elsewhere = "web:U1:plain";
  await app.turn(dm("watch my PR", here));
  await app.turn(dm("nothing scheduled", elsewhere));

  await crons.create(cronInput(here, "check the pipeline"));
  await crons.create(cronInput(here, "refresh the dashboard"));
  const paused = await crons.create(cronInput(here, "poll the checks"));
  await crons.setEnabled(paused.id, false);
  const archived = await crons.create(cronInput(here, "sweep the queue"));
  await crons.update(archived.id, { archived: true });
  await crons.create(cronInput(undefined, "cron with no destination"));
  await crons.create(cronInput("slack:C123", "cron aimed elsewhere"));

  const list = await app.listSessions("U1");
  const hereRow = list.find((s) => s.threadRef === here);
  const plainRow = list.find((s) => s.threadRef === elsewhere);
  assert.equal(hereRow?.crons, 2, "enabled, unarchived crons aimed at this conversation");
  assert.equal(plainRow?.crons, undefined, "clean rows carry no zero-count fields");
});

test("sessionBackground lists the session's crons alongside jobs and watches", async () => {
  const { app, crons } = freshApp();
  const thread = "web:U1:cron-inspect";
  const r = await app.turn(dm("schedule it", thread));

  const made = await crons.create({ ...cronInput(thread, "watch PR checks"), title: "PR watch" });
  const paused = await crons.create(cronInput(thread, "poll the checks"));
  await crons.setEnabled(paused.id, false);

  const view = await app.sessionBackground(r.sessionId!, "U1");
  assert.equal(view?.crons.length, 1);
  assert.equal(view?.crons[0]?.id, made.id);
  assert.equal(view?.crons[0]?.title, "PR watch");
  assert.ok(view?.crons[0]?.nextFireAt, "carries the next fire time");
});
