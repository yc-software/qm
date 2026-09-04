import { fakeSprites } from "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { createPiTools, type ToolContextRef } from "../src/harness/pi-tools.ts";
import { createToolContext, type ToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { scopeId, type TurnRequest, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { testConfig } from "./support/test-config.ts";

const scopedHandle: SandboxHandle = { id: "scoped-box", rootDir: "/workspace" };
const scratchHandle: SandboxHandle = { id: "scratch-box", rootDir: "/workspace", scratch: true };

function routingCtx(extra: Partial<ToolContextDeps> = {}) {
  const calls = { provision: 0, scratch: 0, ranOn: [] as string[] };
  const layers: WorkspaceLayer[] = [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }];
  const sandbox = {
    async run(handle: SandboxHandle) {
      calls.ranOn.push(handle.id);
      return { stdout: "ok", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  const ctx = createToolContext({
    sandbox,
    provision: async () => {
      calls.provision++;
      return scopedHandle;
    },
    provisionScratch: async () => {
      calls.scratch++;
      return scratchHandle;
    },
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    ...extra,
  });
  return { ctx, calls };
}

test("execute routes scratch:true to the scratch box and default to the scoped box", async () => {
  const { ctx, calls } = routingCtx();
  await ctx.execute("echo hi");
  assert.deepEqual({ ...calls }, { provision: 1, scratch: 0, ranOn: ["scoped-box"] });
  await ctx.execute("echo hi", { scratch: true });
  assert.deepEqual({ ...calls }, { provision: 1, scratch: 1, ranOn: ["scoped-box", "scratch-box"] });
});

test("execute scratch:true without a wired scratch path fails loudly, never silently scoped", async () => {
  const { ctx } = routingCtx({ provisionScratch: undefined });
  await assert.rejects(ctx.execute("echo hi", { scratch: true }), /scratch execution is not available/);
});

function sinkToolContext() {
  const seen: Array<{ command: string; opts: unknown }> = [];
  const tc = {
    async execute(command: string, opts?: unknown) {
      seen.push({ command, opts });
      return { stdout: `ran ${command}`, stderr: "", code: 0, timedOut: false };
    },
  } as unknown as ToolContext;
  return { tc, seen };
}

const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const call = (tool: ReturnType<typeof createPiTools>[number] | undefined, params: unknown) => {
  assert.ok(tool);
  return (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)("t", params);
};
const schemaProps = (tool: ReturnType<typeof createPiTools>[number]): string[] =>
  Object.keys((tool as unknown as { parameters: { properties: Record<string, unknown> } }).parameters.properties);
const schemaRequired = (tool: ReturnType<typeof createPiTools>[number]): string[] =>
  (tool as unknown as { parameters: { required?: string[] } }).parameters.required ?? [];

test("flag OFF: the execute surface is exactly the legacy one (no scope/durable, scoped box)", async () => {
  const { tc, seen } = sinkToolContext();
  const [execute] = createPiTools({ current: tc });
  assert.deepEqual(schemaProps(execute!), ["command", "computer", "purpose", "timeout_seconds"]);
  assert.deepEqual(schemaRequired(execute!), ["command", "purpose"]);
  await call(execute, { command: "echo hi" });
  assert.deepEqual(seen, [{ command: "echo hi", opts: undefined }]);
});

test("flag ON: scope defaults to the durable scoped box; scratch is an explicit opt-in", async () => {
  const { tc, seen } = sinkToolContext();
  const ref: ToolContextRef = { current: tc };
  const [execute] = createPiTools(ref, { scratchExec: true });
  assert.deepEqual(schemaProps(execute!), ["command", "computer", "purpose", "timeout_seconds", "scope", "durable"]);

  await call(execute, { command: "echo hi" });
  assert.deepEqual(
    seen.at(-1),
    { command: "echo hi", opts: undefined },
    "omitted scope = durable scoped (follow-ups must work)",
  );

  await call(execute, { command: "echo hi", scope: "scratch" });
  assert.deepEqual(seen.at(-1)!.opts, { scratch: true });

  await call(execute, { command: "echo hi", scope: "scoped" });
  assert.deepEqual(seen.at(-1)!.opts, undefined, "a scoped run carries no scratch opt (today's path)");

  await call(execute, { command: "echo hi", scope: "scoped", durable: true, timeout_seconds: 9 });
  assert.deepEqual(seen.at(-1)!.opts, { timeoutSeconds: 9 });
});

test("flag ON: unsupported scope/durable pairings return a crisp [error] without executing", async () => {
  const { tc, seen } = sinkToolContext();
  const [execute] = createPiTools({ current: tc }, { scratchExec: true });

  const e1 = textOf(await call(execute, { command: "echo hi", scope: "scratch", durable: true }));
  assert.match(e1, /\[error\] a scratch box cannot be made durable yet/);

  const e2 = textOf(await call(execute, { command: "echo hi", scope: "scoped", durable: false }));
  assert.match(e2, /\[error\] the scoped computer is always durable today/);

  assert.equal(seen.length, 0, "invalid pairings never reach the sandbox");
});

test("flag ON: the tool_call/tool_result entries record which box ran the command", async () => {
  const emitted: Array<{ type: string; payload: { tool?: string; scope?: string } }> = [];
  const { tc } = sinkToolContext();
  const ref: ToolContextRef = {
    current: tc,
    emit: (e) => {
      emitted.push(e as never);
    },
    scopeLabel: scopeId("personal", "U1"),
  };
  const [execute] = createPiTools(ref, { scratchExec: true });
  await call(execute, { command: "echo hi", scope: "scratch" });
  await call(execute, { command: "echo hi" });
  assert.deepEqual(
    emitted.map((e) => `${e.type}:${e.payload.scope}`),
    ["tool_call:scratch", "tool_result:scratch", "tool_call:scoped", "tool_result:scoped"],
  );
});

test("flag ON: the description advertises the routing policy truthfully", () => {
  const { tc } = sinkToolContext();
  const [legacy] = createPiTools({ current: tc });
  const [execute] = createPiTools({ current: tc }, { scratchExec: true });
  const desc = (execute as unknown as { description: string }).description;
  assert.match(desc, /"scoped" \(DEFAULT\)/);
  assert.match(desc, /reasonably confident/);
  assert.match(desc, /NO logins, NO credentials/);
  assert.match(desc, /NOTHING persists/);
  assert.match(desc, /re-run it with scope:"scoped"/);
  assert.doesNotMatch((legacy as unknown as { description: string }).description, /scratch/i);
});

function freshApp(extra: Partial<Config> = {}) {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-scratch-")),
    ...extra,
  });
  return buildApp(config);
}

const dm = (text: string): TurnRequest => ({
  surface: "test",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef: "dm:U1:t1" },
  text,
});

test("a scratch turn runs on a separate volumeless box with NO capability tokens in its env", async () => {
  const { app } = freshApp({ signingSecret: "s3cret", apiBaseUrl: "https://core.test" });

  const scoped = await app.turn(dm("!run printenv AGENT_API_TOKEN"));
  assert.equal(scoped.status, "ok");
  assert.ok(
    scoped.reply && scoped.reply.length > 0 && !scoped.reply.startsWith("(exit"),
    "the scoped box sees the capability token",
  );

  const scratch = await app.turn(dm("!scratch printenv AGENT_API_TOKEN"));
  assert.equal(scratch.status, "ok");
  assert.equal(scratch.reply, "(exit 1)", "the scratch box is credential-free — no capability token");

  assert.ok(
    fakeSprites.names().some((n) => n.startsWith("qm-personal-u1-")),
    "the scoped box is the scope's durable sprite",
  );
  assert.ok(
    fakeSprites.calls.some((c) => /\/sprites\/qm-scratch-[^/]+\/exec$/.test(c.path)),
    "the scratch run landed on a separate throwaway sprite",
  );
  assert.ok(
    !fakeSprites.names().some((n) => n.startsWith("qm-scratch-")),
    "the scratch sprite is destroyed at release",
  );
});

test("nothing on the scratch box survives the turn", async () => {
  const { app } = freshApp();
  const first = await app.turn(dm('!scratch sh -c "echo leak > leak.txt && cat leak.txt"'));
  assert.equal(first.reply, "leak");
  const second = await app.turn(dm('!scratch sh -c "cat leak.txt 2>/dev/null; echo clean"'));
  assert.equal(second.reply, "clean", "the release reset blanked the box between turns");
});

test("a deliverable produced in a scratch run still ships via $AGENT_OUTBOX", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    dm('!scratch sh -c "mkdir -p $AGENT_OUTBOX && printf hello > $AGENT_OUTBOX/from-scratch.txt && echo made"'),
  );
  assert.equal(res.status, "ok");
  assert.deepEqual(
    res.attachments?.map((a) => a.name),
    ["from-scratch.txt"],
    "outbox collection covers the scratch box too",
  );
});

test("$AGENT_OUTBOX is absolute, so a file delivered after cd'ing away from the workspace still attaches", async () => {
  const { app } = freshApp();
  const env = await app.turn(dm("!run printenv AGENT_OUTBOX"));
  assert.equal(env.status, "ok");
  assert.match(
    env.reply ?? "",
    /^\/.*\/\.agent-turn\/[a-f0-9]{24}\/[a-z0-9]+-[a-f0-9]{24}\/outbox$/,
    "AGENT_OUTBOX is an absolute, turn-private outbox path",
  );
  const res = await app.turn(
    dm('!run sh -c "cd /tmp && mkdir -p $AGENT_OUTBOX && printf hi > $AGENT_OUTBOX/from-tmp.txt && echo sent"'),
  );
  assert.equal(res.status, "ok");
  assert.deepEqual(
    res.attachments?.map((a) => a.name),
    ["from-tmp.txt"],
    "a file copied to $AGENT_OUTBOX from /tmp is still collected",
  );
});

test("a scratch-only turn still reclaims its box (reset + suspend) when the turn ends", async () => {
  const { app, sandbox } = freshApp();
  let toreDown = 0;
  const realTeardown = sandbox.teardown.bind(sandbox);
  sandbox.teardown = async (handle, opts) => {
    if (handle.scratch) toreDown++;
    return realTeardown(handle, opts);
  };
  await app.turn(dm("!scratch echo hi"));
  assert.equal(toreDown, 1, "the scratch box is released exactly once per turn");
});
