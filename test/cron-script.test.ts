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
import { createToolContext } from "../src/tools/primitives.ts";
import type { ExecResult, Sandbox } from "../src/sandbox/sandbox.ts";

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

const passes = async () => undefined;

async function fireOnce(script: CronScript) {
  const { built, control } = await setup();
  const created = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "post the new rows", script, session: false },
    claims(),
    passes,
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
    passes,
  );
  assert.deepEqual(relay, { ok: false, code: "bad_request", message: "script needs a cron with a task for the agent" });

  const created = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "check", script: { command: "./check.sh", credentials: ["gh"] } },
    claims(),
    passes,
  );
  assert.ok(created.ok);
  assert.deepEqual(created.cron.script, { command: "./check.sh", credentials: ["gh"] });

  const untried = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "check", script: { command: "./check.sh" } },
    claims(),
  );
  assert.deepEqual(
    untried.ok ? "" : untried.message,
    "set a cron's script with the cron tool, which runs it once first",
  );
  const elsewhere = await control.patchCron(
    created.cron.id,
    { script: { command: "./other.sh" } },
    { ...claims(), scopeId: scopeId("channel", "C9") },
    passes,
  );
  assert.match(elsewhere.ok ? "" : elsewhere.message, /scope the cron runs in/);
  const kept = await control.getCron(created.cron.id, claims());
  assert.deepEqual(kept.ok && kept.cron.script, { command: "./check.sh", credentials: ["gh"] });

  const removed = await control.patchCron(created.cron.id, { script: null }, claims());
  assert.ok(removed.ok);
  assert.equal(removed.cron.script, undefined);

  await control.patchCron(created.cron.id, { script: { command: "./check.sh" } }, claims(), passes);
  const relayed = await control.patchCron(created.cron.id, { text: "standup!" }, claims());
  assert.ok(relayed.ok);
  assert.equal(relayed.cron.script, undefined);
});

test("setting a script runs it once first and keeps it only when that run exits 0 or 1", async () => {
  const { built, control } = await setup();
  const ctx = createToolContext({
    sandbox: {} as unknown as Sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }),
    writableScopeId: HOME,
    readOnlyScopeIds: [],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: OWNER,
    control,
    controlClaims: claims(),
  });
  const ran: Array<{ command: string; credentials?: string[]; sandboxId?: string }> = [];
  const outcomes: Record<string, ExecResult | Error> = {
    "./quiet.sh": { stdout: "nothing new\n", stderr: "", code: 0, timedOut: false },
    "./found.sh": { stdout: "row 7\n", stderr: "", code: 1, timedOut: false },
    "./typo.sh": { stdout: "", stderr: "./typo.sh: not found\n", code: 127, timedOut: false },
    "./slow.sh": { stdout: "still going\n", stderr: "", code: 124, timedOut: true },
    "./denied.sh": new Error("unknown credential handle: gh"),
  };
  const tools = {
    ...ctx,
    execute: async (command: string, opts?: { credentials?: string[]; sandboxId?: string }) => {
      ran.push({ command, ...opts });
      const outcome = outcomes[command]!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  const create = (command: string) =>
    tools.cronCreate({
      schedule: { everyMs: 3_600_000 },
      action: "check",
      script: { command, credentials: ["gh"], sandboxId: "sb-1" },
    });

  const quiet = await create("./quiet.sh");
  assert.ok(!("unavailable" in quiet) && quiet.ok);
  assert.deepEqual(ran[0], { command: "./quiet.sh", credentials: ["gh"], sandboxId: "sb-1" });
  const found = await create("./found.sh");
  assert.ok(!("unavailable" in found) && found.ok);

  const refusal = async (command: string) => {
    const r = await create(command);
    assert.ok(!("unavailable" in r) && !r.ok);
    return r.message;
  };
  assert.equal(
    await refusal("./typo.sh"),
    "script not set: its trial run failed (exit 127); a cron script must exit 0 (handled) or 1 (wake the agent). Output:\n./typo.sh: not found",
  );
  assert.match(await refusal("./slow.sh"), /trial run failed \(timed out\);.*\nstill going$/s);
  assert.match(await refusal("./denied.sh"), /trial run failed \(could not run: unknown credential handle: gh\);/);

  const patched = await tools.cronPatch(quiet.cron.id, { script: { command: "./typo.sh" } });
  assert.ok(!("unavailable" in patched) && !patched.ok);
  assert.deepEqual((await built.app.getCron(quiet.cron.id))?.script, {
    command: "./quiet.sh",
    credentials: ["gh"],
    sandboxId: "sb-1",
  });
  const relay = await tools.cronCreate({ schedule: { everyMs: 3_600_000 }, text: "standup!" });
  assert.ok(relay.ok);
  const runs = ran.length;
  const onRelay = await tools.cronPatch(relay.cron.id, { script: { command: "./quiet.sh" } });
  assert.ok(!onRelay.ok);
  const badSchedule = await tools.cronCreate({
    schedule: { cron: "99 99 * * *", timezone: "UTC" },
    action: "check",
    script: { command: "./quiet.sh" },
  });
  assert.ok(!badSchedule.ok);
  assert.equal(ran.length, runs);
  assert.equal((await built.app.listCrons()).length, 3);
});
