import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { createControlService } from "../src/api/control-service.ts";
import type { CronScript } from "../src/triggers/types.ts";
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
  const control = createControlService(built.app, built.scheduler);
  return { built, control };
}

async function fireOnce(script: CronScript) {
  const { built, control } = await setup();
  const created = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "post the new rows", script: { command: "true" }, session: false },
    claims(),
  );
  assert.ok(created.ok, created.ok ? "" : created.message);
  await built.crons.update(created.cron.id, { script });
  await runNowSettled(built.scheduler, created.cron.id);
  const [fire] = (await built.crons.listFires(created.cron.id)).runs;
  assert.ok(fire);
  const llmCalls = fire.sessionId ? (await built.sessions.listLlmRequests(fire.sessionId)).length : 0;
  const items = fire.sessionId ? await built.sessions.getItems(fire.sessionId) : [];
  const prompt = items.find(isUserItem)?.text ?? "";
  return { fire, llmCalls, prompt };
}

test("a script that exits 0 handles the fire without waking the agent", async () => {
  const { fire, llmCalls } = await fireOnce({ command: "echo checked 40 rows; echo posted 3 rows" });
  assert.equal(fire.status, "silent");
  assert.equal(fire.note, "handled by script: posted 3 rows");
  assert.equal(fire.reply, undefined);
  assert.equal(llmCalls, 0);
});

test("a script that exits non-zero escalates to the agent with its output", async () => {
  const { fire, llmCalls, prompt } = await fireOnce({ command: "echo row 7 has no owner; exit 1" });
  assert.equal(fire.status, "ok");
  assert.equal(fire.note, "escalated (exit 1): row 7 has no owner");
  assert.match(prompt, /exit 1/);
  assert.match(prompt, /row 7 has no owner/);
  assert.ok(llmCalls > 0);
});

test("a script that cannot run escalates instead of hiding the fire", async () => {
  const { fire, prompt } = await fireOnce({ command: "echo hi", credentials: ["no-such-credential"] });
  assert.equal(fire.status, "ok");
  assert.match(fire.note ?? "", /^escalated \(could not run: .+\)$/);
  assert.match(prompt, /could not run: /);
});

test("a script needs a task cron and is removed by patch null or a switch to text", async () => {
  const { control } = await setup();
  const relay = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, text: "standup!", script: { command: "true" } },
    claims(),
  );
  assert.deepEqual(relay, { ok: false, code: "bad_request", message: "script needs a cron with a task for the agent" });

  const created = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "check", script: { command: "true" } },
    claims(),
  );
  assert.ok(created.ok);
  const removed = await control.patchCron(created.cron.id, { script: null }, claims());
  assert.ok(removed.ok);
  assert.equal(removed.cron.script, undefined);

  await control.patchCron(created.cron.id, { script: { command: "true" } }, claims());
  const relayed = await control.patchCron(created.cron.id, { text: "standup!" }, claims());
  assert.ok(relayed.ok);
  assert.equal(relayed.cron.script, undefined);
});

test("a script's trial runs in the cron's scope from any room and keeps it only on exit 0 or 1", async () => {
  const { built, control } = await setup();
  const elsewhere = { ...claims(), scopeId: scopeId("channel", "C9"), destination: undefined, destinations: [] };
  const create = (command: string, from = claims()) =>
    control.createCron(
      { schedule: { everyMs: 3_600_000 }, action: "check", scope: "personal", script: { command } },
      from,
    );
  const refusal = async (command: string, from = claims()) => {
    const r = await create(command, from);
    assert.ok(!r.ok);
    return r.message;
  };
  const failing = "echo ./typo.sh: not found >&2; exit 127";
  const refused =
    "script not set: its trial run failed (exit 127); a cron script must exit 0 (handled) or 1 (wake the agent)";
  assert.equal(await refusal(failing), `${refused}. Output:\n./typo.sh: not found`);
  assert.equal(await refusal(failing, elsewhere), refused);

  const found = await create("echo row 7; exit 1", elsewhere);
  assert.ok(found.ok);
  assert.equal(found.cron.ownerScopeId, HOME);
  const patched = await control.patchCron(found.cron.id, { script: { command: failing } }, elsewhere);
  assert.ok(!patched.ok);
  assert.deepEqual((await built.app.getCron(found.cron.id))?.script, { command: "echo row 7; exit 1" });
  const trials = (await built.sessions.listByScope(HOME)).filter((s) => s.threadRef.startsWith("cron:trial-"));
  assert.equal(trials.length, 4);
});
