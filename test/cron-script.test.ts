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
import { createToolContext } from "../src/tools/primitives.ts";
import type { ExecResult, Sandbox } from "../src/sandbox/sandbox.ts";

const OWNER = "U1";
const trusted = async () => undefined;
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
    trusted,
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
  const { fire, llmCalls } = await fireOnce({ command: "echo checked 40 rows; echo posted 3 rows" });
  assert.equal(fire.status, "silent");
  assert.equal(fire.note, "handled by script: posted 3 rows");
  assert.equal(fire.reply, undefined);
  assert.equal(llmCalls, 0);
});

test("a live script that exits non-zero escalates to the agent with its output", async () => {
  const { fire, llmCalls, prompt } = await fireOnce({ command: "echo row 7 has no owner; exit 1" });
  assert.equal(fire.status, "ok");
  assert.equal(fire.note, "escalated (exit 1): row 7 has no owner");
  assert.match(prompt, /exit 1/);
  assert.match(prompt, /row 7 has no owner/);
  assert.ok(llmCalls > 0);
});

test("a live script that cannot run escalates instead of hiding the fire", async () => {
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
    trusted,
  );
  assert.deepEqual(relay, { ok: false, code: "bad_request", message: "script needs a cron with a task for the agent" });

  const created = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "check", script: { command: "./check.sh", credentials: ["gh"] } },
    claims(),
    trusted,
  );
  assert.ok(created.ok);
  assert.deepEqual(created.cron.script, { command: "./check.sh", credentials: ["gh"] });

  const removed = await control.patchCron(created.cron.id, { script: null }, claims(), trusted);
  assert.ok(removed.ok);
  assert.equal(removed.cron.script, undefined);

  await control.patchCron(created.cron.id, { script: { command: "./check.sh" } }, claims(), trusted);
  const relayed = await control.patchCron(created.cron.id, { text: "standup!" }, claims(), trusted);
  assert.ok(relayed.ok);
  assert.equal(relayed.cron.script, undefined);
});

test("setting a script runs it once first and keeps it only when that run exits 0 or 1", async () => {
  const { built, control } = await setup();
  const ctx = createToolContext({
    sandbox: {} as unknown as Sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }),
    layers: [{ scopeId: HOME, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
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
  ctx.execute = async (command: string, opts?: { credentials?: string[]; sandboxId?: string }) => {
    ran.push({
      command,
      ...(opts?.credentials ? { credentials: opts.credentials } : {}),
      ...(opts?.sandboxId ? { sandboxId: opts.sandboxId } : {}),
    });
    const outcome = outcomes[command]!;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const create = (command: string) =>
    ctx.cronCreate({
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
    "script not set: its trial run exited 127; a cron script must exit 0 (handled) or 1 (wake the agent). Output:\n./typo.sh: not found",
  );
  assert.match(await refusal("./slow.sh"), /trial run timed out;.*\nstill going$/s);
  assert.match(await refusal("./denied.sh"), /trial run failed: unknown credential handle: gh;/);

  const patched = await ctx.cronPatch(quiet.cron.id, { script: { command: "./typo.sh" } });
  assert.ok(!("unavailable" in patched) && !patched.ok);
  assert.deepEqual((await built.app.getCron(quiet.cron.id))?.script, {
    command: "./quiet.sh",
    credentials: ["gh"],
    sandboxId: "sb-1",
  });
  assert.equal((await built.app.listCrons()).length, 2);

  const before = ran.length;
  const relay = await ctx.cronCreate({
    schedule: { everyMs: 3_600_000 },
    text: "hi",
    script: { command: "./quiet.sh" },
  });
  assert.ok(!("unavailable" in relay) && !relay.ok);
  const missing = await ctx.cronPatch("no-such-cron", { script: { command: "./quiet.sh" } });
  assert.ok(!("unavailable" in missing) && !missing.ok);
  assert.equal(ran.length, before, "a request refused for other reasons never runs the script");
});

test("a script is refused from a conversation other than the one that owns the cron", async () => {
  const { control } = await setup();
  const CHANNEL = scopeId("channel", "C");
  const trials: unknown[] = [];
  const r = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "check", scope: "personal", script: { command: "./check.sh" } },
    {
      ...claims(),
      scopeId: CHANNEL,
      destination: { type: "slack", target: "C", audienceScopeId: CHANNEL },
      destinations: [{ key: "k-c", type: "slack", target: "C", audienceScopeId: CHANNEL, label: "#eng" }],
      defaultDestinationKey: "k-c",
    },
    async (script) => void trials.push(script),
  );
  assert.equal(
    r.ok ? "" : r.message,
    "set a cron's script from the conversation that owns the cron, so its trial run uses the computer and credentials its fires will",
  );
  assert.deepEqual(trials, []);
});
