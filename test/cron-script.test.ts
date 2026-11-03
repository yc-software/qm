import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { createControlService } from "../src/api/control-service.ts";
import type { CronScriptRequest } from "../src/cron/script.ts";
import { scopeId } from "../src/types.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { runNowSettled } from "./support/settle.ts";
import { isUserItem } from "../src/sessions/items.ts";

const OWNER = "U1";
const HOME = scopeId("personal", OWNER);

function claims(): CapabilityClaims {
  return {
    actorId: OWNER,
    scopeId: HOME,
    destination: { type: "slack", target: "D1", audienceScopeId: HOME },
    destinations: [{ key: "k-dm", type: "slack", target: "D1", audienceScopeId: HOME, label: "this DM" }],
    defaultDestinationKey: "k-dm",
    exp: Date.now() + CAPABILITY_TTL_MS,
  };
}

async function setup() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cron-script-")) }));
  await selectDefaultSandbox(built, OWNER, HOME);
  const control = createControlService(built.app, built.scheduler, built.admin);
  return { built, control };
}

async function fireOnce(script: CronScriptRequest) {
  const { built, control } = await setup();
  const created = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "post the new rows", script, session: false },
    claims(),
  );
  assert.ok(created.ok, created.ok ? "" : created.message);
  await runNowSettled(built.scheduler, created.cron.id);
  const [fire] = (await built.crons.listFires(created.cron.id)).runs;
  assert.ok(fire);
  const llmCalls = fire.sessionId ? (await built.sessions.listLlmRequests(fire.sessionId)).length : 0;
  const items = fire.sessionId ? await built.sessions.getItems(fire.sessionId) : [];
  const prompt = items.find(isUserItem)?.text ?? "";
  return { fire, llmCalls, prompt };
}

test("a live script that exits 0 handles the fire without waking the agent", async () => {
  const { fire, llmCalls } = await fireOnce({ command: "echo checked 40 rows; echo posted 3 rows", mode: "live" });
  assert.equal(fire.status, "silent");
  assert.equal(fire.note, "handled by script: posted 3 rows");
  assert.equal(fire.reply, undefined);
  assert.equal(llmCalls, 0);
});

test("a live script that exits non-zero escalates to the agent with its output", async () => {
  const { fire, llmCalls, prompt } = await fireOnce({ command: "echo row 7 has no owner; exit 1", mode: "live" });
  assert.equal(fire.status, "ok");
  assert.equal(fire.note, "escalated (exit 1): row 7 has no owner");
  assert.match(prompt, /exit 1/);
  assert.match(prompt, /row 7 has no owner/);
  assert.ok(llmCalls > 0);
});

test("a live script that cannot run escalates instead of hiding the fire", async () => {
  const { fire, prompt } = await fireOnce({ command: "echo hi", mode: "live", credentials: ["no-such-credential"] });
  assert.equal(fire.status, "ok");
  assert.match(fire.note ?? "", /^escalated \(could not run: .+\)$/);
  assert.match(prompt, /could not run: /);
});

test("a shadow script logs its verdict while the agent still runs the fire unchanged", async () => {
  const handled = await fireOnce({ command: "echo nothing new" });
  assert.equal(handled.fire.status, "ok");
  assert.equal(handled.fire.note, "shadow: script would have handled it: nothing new");
  assert.doesNotMatch(handled.prompt, /nothing new/);
  assert.ok(handled.llmCalls > 0);

  const escalated = await fireOnce({ command: "echo 2 candidates >&2; exit 3", mode: "shadow" });
  assert.equal(escalated.fire.note, "shadow: script would have escalated (exit 3): 2 candidates");
  assert.doesNotMatch(escalated.prompt, /2 candidates/);
});

test("a script needs a task cron, defaults to shadow, and is removed by patch null or a switch to text", async () => {
  const { control } = await setup();
  const relay = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, text: "standup!", script: { command: "true" } },
    claims(),
  );
  assert.deepEqual(relay, { ok: false, code: "bad_request", message: "script needs a cron with a task for the agent" });

  const badMode = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "check", script: { command: "true", mode: "on" as "live" } },
    claims(),
  );
  assert.equal(badMode.ok ? "" : badMode.message, 'script.mode must be "shadow" or "live"');

  const created = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "check", script: { command: "./check.sh", credentials: ["gh"] } },
    claims(),
  );
  assert.ok(created.ok);
  assert.deepEqual(created.cron.script, { command: "./check.sh", mode: "shadow", credentials: ["gh"] });

  const live = await control.patchCron(created.cron.id, { script: { command: "./check.sh", mode: "live" } }, claims());
  assert.ok(live.ok);
  assert.deepEqual(live.cron.script, { command: "./check.sh", mode: "live" });

  const removed = await control.patchCron(created.cron.id, { script: null }, claims());
  assert.ok(removed.ok);
  assert.equal(removed.cron.script, undefined);

  await control.patchCron(created.cron.id, { script: { command: "./check.sh" } }, claims());
  const relayed = await control.patchCron(created.cron.id, { text: "standup!" }, claims());
  assert.ok(relayed.ok);
  assert.equal(relayed.cron.script, undefined);
});
