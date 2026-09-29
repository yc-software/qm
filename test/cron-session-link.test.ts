import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { createControlService } from "../src/api/control-service.ts";
import { cronIsActive } from "../src/cron/cron-store.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const THREAD = "web:U1:watching";

function claims(extra: Partial<CapabilityClaims> = {}): CapabilityClaims {
  return {
    actorId: "U1",
    scopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
    exp: Date.now() + CAPABILITY_TTL_MS,
    threadRef: THREAD,
    ...extra,
  };
}

function dm(text: string, threadRef: string): TurnRequest {
  return { surface: "test", actor: { externalId: "U1" }, conversation: { kind: "dm", threadRef }, text };
}

async function setup() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cron-session-")) }));
  const control = createControlService(built.app, built.scheduler, built.admin);
  const session = await built.app.turn(dm("watch CI for me", THREAD));
  await built.app.turn(dm("unrelated", "web:U1:other"));
  return { built, control, sessionId: session.sessionId! };
}

const watch = { schedule: { everyMs: 600_000 }, action: "check CI", title: "CI watch" };

test("a cron created from a live session is tied to it and shows as that session's background work", async () => {
  const { built, control, sessionId } = await setup();
  const created = await control.createCron(watch, claims());
  assert.ok(created.ok, JSON.stringify(created));
  assert.equal(created.cron.sessionRef, THREAD);
  assert.equal(created.cron.destination?.target, "D1", "delivery stays where it was addressed");

  const list = await built.app.listSessions("U1");
  assert.equal(list.find((s) => s.threadRef === THREAD)?.crons, 1);
  assert.ok(!list.find((s) => s.threadRef === "web:U1:other")?.crons);

  await built.crons.recordFire(created.cron.id, {
    fireKey: "f1",
    threadRef: `cron:${created.cron.id}:fire:1`,
    firedAt: 1_000,
    status: "ok",
  });
  const bg = await built.app.sessionBackground(sessionId, "U1");
  assert.deepEqual(bg?.crons, [
    {
      id: created.cron.id,
      title: "CI watch",
      nextFireAt: created.cron.nextFireAt,
      lastFire: { firedAt: 1_000, status: "ok" },
    },
  ]);

  await control.patchCron(created.cron.id, { enabled: false }, claims());
  assert.ok(!(await built.app.listSessions("U1")).find((s) => s.threadRef === THREAD)?.crons, "paused crons drop off");
});

test("session:false and triggered turns leave a cron untied, and patch ties or unties it", async () => {
  const { built, control } = await setup();
  const untied = await control.createCron({ ...watch, session: false }, claims());
  assert.ok(untied.ok && untied.cron.sessionRef === undefined);
  const elsewhere = await control.patchCron(
    untied.cron.id,
    { session: true },
    claims({ scopeId: scopeId("channel", "C9") }),
  );
  assert.equal(elsewhere.ok ? "" : elsewhere.code, "bad_request", "a cron only ties to sessions in its own scope");
  const fromFire = await control.createCron({ ...watch, title: "Fire child" }, claims({ triggered: true }));
  assert.ok(fromFire.ok && fromFire.cron.sessionRef === undefined);

  const noop = await control.patchCron(untied.cron.id, { session: false }, claims());
  assert.ok(noop.ok && noop.cron.sessionRef === undefined);
  const tied = await control.patchCron(untied.cron.id, { session: true }, claims());
  assert.ok(tied.ok && tied.cron.sessionRef === THREAD);
  const refused = await control.patchCron(untied.cron.id, { session: true }, claims({ threadRef: undefined }));
  assert.equal(refused.ok ? "" : refused.code, "bad_request");
  const cleared = await control.patchCron(untied.cron.id, { session: false }, claims());
  assert.ok(cleared.ok && cleared.cron.sessionRef === undefined);
  assert.ok(!(await built.app.listSessions("U1")).find((s) => s.threadRef === THREAD)?.crons);
});

test("a one-shot cron stops counting as active once it has fired", () => {
  const base = { enabled: true, archived: false, schedule: { firstFireAt: 5 } };
  assert.equal(cronIsActive(base), true);
  assert.equal(cronIsActive({ ...base, lastFiredAt: 6 }), false);
  assert.equal(cronIsActive({ ...base, schedule: { everyMs: 60_000, firstFireAt: 5 }, lastFiredAt: 6 }), true);
  assert.equal(cronIsActive({ ...base, archived: true }), false);
});
