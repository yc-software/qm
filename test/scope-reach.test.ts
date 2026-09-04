import { fakeSprites } from "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { createPiTools, type ToolContextRef } from "../src/harness/pi-tools.ts";
import {
  createToolContext,
  type ToolContext,
  type ToolContextDeps,
  CommandDenied,
  NeedsApproval,
} from "../src/tools/primitives.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { resolveReachableChannel } from "../src/resolution/scope-reach.ts";
import { filterHistoryForAudience } from "../src/resolution/context-filter.ts";
import { scopeId, type Principal, type TurnRequest, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { AuditEvent, AuditLog } from "../src/audit/audit-log.ts";
import { testConfig } from "./support/test-config.ts";

test("resolveReachableChannel: a public channel is reachable by any internal member", async () => {
  const d = createDirectoryStore();
  await d.replaceChannels([{ channelId: "C-eng", name: "eng" }]);
  const r = await resolveReachableChannel("#eng", { directory: d, actorId: "U1" });
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.scopeId, scopeId("channel", "C-eng"));
    assert.equal(r.channelName, "eng");
    assert.equal(r.isPrivate, false);
  }
});

test("resolveReachableChannel: a private channel is ok for a member, denied for a non-member", async () => {
  const d = createDirectoryStore();
  await d.replace([
    { principalId: "U1", displayName: "User One", type: "internal" },
    { principalId: "U2", displayName: "User Two", type: "internal" },
  ]);
  await d.replaceChannels(
    [{ channelId: "C-sec", name: "secret", isPrivate: true }],
    [{ channelId: "C-sec", principalId: "U1" }],
  );
  assert.equal((await resolveReachableChannel("secret", { directory: d, actorId: "U1" })).kind, "ok");
  const denied = await resolveReachableChannel("secret", { directory: d, actorId: "U2" });
  assert.equal(denied.kind, "error");
  if (denied.kind === "error") assert.match(denied.message, /private and I can't confirm you're a member/);

  const ghost = await resolveReachableChannel("secret", { directory: d, actorId: "U-ghost" });
  assert.equal(ghost.kind, "error");
  if (ghost.kind === "error") assert.match(ghost.message, /can't confirm your identity/);
});

test("resolveReachableChannel: ambiguity lists candidate names; unknown says not synced / not in it", async () => {
  const d = createDirectoryStore();
  await d.replaceChannels([
    { channelId: "C1", name: "design-frontend" },
    { channelId: "C2", name: "design-backend" },
  ]);
  const amb = await resolveReachableChannel("design", { directory: d, actorId: "U1" });
  assert.equal(amb.kind, "error");
  if (amb.kind === "error") {
    assert.match(amb.message, /#design-frontend/);
    assert.match(amb.message, /#design-backend/);
  }
  const none = await resolveReachableChannel("nope", { directory: d, actorId: "U1" });
  assert.equal(none.kind, "error");
  if (none.kind === "error") assert.match(none.message, /hasn't synced yet|not in it/);
});

test("listChannelsFor: public channels ∪ private channels the principal is a member of", async () => {
  const d = createDirectoryStore();
  await d.replaceChannels(
    [
      { channelId: "C-pub", name: "general" },
      { channelId: "C-mine", name: "mine", isPrivate: true },
      { channelId: "C-theirs", name: "theirs", isPrivate: true },
    ],
    [
      { channelId: "C-mine", principalId: "U1" },
      { channelId: "C-theirs", principalId: "U2" },
    ],
  );
  assert.deepEqual((await d.listChannelsFor("U1")).map((c) => c.name).sort(), ["general", "mine"]);
  assert.deepEqual((await d.listChannelsFor("U2")).map((c) => c.name).sort(), ["general", "theirs"]);
});

const scopedHandle: SandboxHandle = { id: "scoped-box", rootDir: "/workspace" };
const reachHandle: SandboxHandle = { id: "reach-box", rootDir: "/workspace" };
const PH_SCOPE = scopeId("channel", "C-ph");

function collectingAudit(): { log: AuditLog; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    log: {
      record: (e) => void events.push(e),
      events: async () => events,
      tail: async ({ limit, scopeLabel }) =>
        events
          .filter((e) => !scopeLabel || e.scopeLabel === scopeLabel)
          .slice(-limit)
          .reverse(),
    },
  };
}

function reachCtx(extra: Partial<ToolContextDeps> = {}) {
  const calls = { provision: 0, reachProvision: [] as string[], ranOn: [] as string[], resolved: [] as string[] };
  const layers: WorkspaceLayer[] = [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }];
  const sandbox = {
    async run(handle: SandboxHandle) {
      calls.ranOn.push(handle.id);
      return { stdout: "ok", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  const reach = {
    async resolveChannel(q: string) {
      calls.resolved.push(q);
      if (q === "#missing") return { kind: "error" as const, message: 'I can\'t see a channel matching "#missing"' };
      return {
        kind: "ok" as const,
        scopeId: PH_SCOPE,
        channelId: "C-ph",
        channelName: "project-alpha",
        isPrivate: false,
      };
    },
    async provisionFor(s: string) {
      calls.reachProvision.push(s);
      return reachHandle;
    },
  };
  const ctx = createToolContext({
    sandbox,
    provision: async () => {
      calls.provision++;
      return scopedHandle;
    },
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    reach,
    ...extra,
  });
  return { ctx, calls };
}

test("execute(reachTarget) runs on the reach box, never the session box, and stamps provenance", async () => {
  const { ctx, calls } = reachCtx();
  const r = await ctx.execute("cat x", { reachTarget: "#project-alpha" });
  assert.deepEqual(calls.resolved, ["#project-alpha"]);
  assert.deepEqual(calls.reachProvision, [PH_SCOPE]);
  assert.deepEqual(calls.ranOn, ["reach-box"]);
  assert.equal(calls.provision, 0, "a reach never provisions this conversation's own box");
  assert.deepEqual(r.reached, { scopeId: PH_SCOPE, label: "#project-alpha" });
});

test("execute(reachTarget) records a reach_exec audit event labeled with the channel scope", async () => {
  const { log, events } = collectingAudit();
  const { ctx } = reachCtx({ auditLog: log });
  await ctx.execute("ls", { reachTarget: "#project-alpha" });
  const reach = events.find((e) => e.action === "reach_exec");
  assert.ok(reach, "a reach_exec event is recorded");
  assert.equal(reach!.scopeLabel, PH_SCOPE);
  assert.equal(reach!.resource, "ls");
  assert.equal(reach!.principalId, "U1");
});

test("execute(reachTarget) still applies command policy (deny / require-approval)", async () => {
  const denied = reachCtx({
    commandPolicy: () => ({
      mode: "denylist",
      rules: [{ pattern: "\\bmkfs\\b", decision: "deny", reason: "destructive" }],
    }),
  });
  await assert.rejects(denied.ctx.execute("mkfs /dev/sda", { reachTarget: "#project-alpha" }), CommandDenied);
  assert.deepEqual(denied.calls.ranOn, [], "a denied command never reaches the sandbox");

  const needs = reachCtx({
    commandPolicy: () => ({
      mode: "denylist",
      rules: [{ pattern: "danger", decision: "require_approval", reason: "needs ok" }],
    }),
  });
  await assert.rejects(needs.ctx.execute("danger", { reachTarget: "#project-alpha" }), NeedsApproval);
});

test("execute: a resolver error from reach surfaces as a plain Error (rendered as a tool error)", async () => {
  const { ctx } = reachCtx();
  await assert.rejects(ctx.execute("ls", { reachTarget: "#missing" }), /can't see a channel matching/);
});

test("execute: reachTarget + scratch is rejected; reachTarget with no reach dep is the DM-only message", async () => {
  const { ctx } = reachCtx();
  await assert.rejects(ctx.execute("ls", { reachTarget: "#project-alpha", scratch: true }), /one computer/);
  const noReach = reachCtx({ reach: undefined });
  await assert.rejects(noReach.ctx.execute("ls", { reachTarget: "#project-alpha" }), /works from a DM/);
});

function sinkToolContext() {
  const seen: Array<{ command: string; opts: unknown }> = [];
  const tc = {
    async execute(command: string, opts?: { reachTarget?: string }) {
      seen.push({ command, opts });
      const base = { stdout: `ran ${command}`, stderr: "", code: 0, timedOut: false };
      return opts?.reachTarget ? { ...base, reached: { scopeId: PH_SCOPE, label: opts.reachTarget } } : base;
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

test("reachExec OFF: the execute scope never accepts a room", () => {
  const ref: ToolContextRef = { current: null };
  const [legacy] = createPiTools(ref);
  assert.ok(!schemaProps(legacy!).includes("scope"), "legacy surface has no scope param");
  const [scratchOnly] = createPiTools(ref, { scratchExec: true });
  const scopeSchema = (scratchOnly as unknown as { parameters: { properties: { scope?: { anyOf?: unknown[] } } } })
    .parameters.properties.scope;
  assert.ok(
    Array.isArray(scopeSchema?.anyOf),
    "scratch-only scope is a closed union (scratch|scoped), not a free room string",
  );
});

test("reachExec ON (no scratch): scope is a free string; a room routes to reachTarget; default is scoped", async () => {
  const { tc, seen } = sinkToolContext();
  const [execute] = createPiTools({ current: tc }, { reachExec: true });
  assert.deepEqual(schemaProps(execute!), ["command", "computer", "purpose", "timeout_seconds", "scope"]);
  await call(execute, { command: "cat x", scope: "#project-alpha" });
  assert.deepEqual(seen.at(-1)!.opts, { reachTarget: "#project-alpha" });
  await call(execute, { command: "echo hi" });
  assert.deepEqual(seen.at(-1)!.opts, undefined, "omitted scope = the scoped box");
  await call(execute, { command: "echo hi", scope: "scoped" });
  assert.deepEqual(seen.at(-1)!.opts, undefined);
  const err = textOf(await call(execute, { command: "x", scope: "scratch" }));
  assert.match(err, /scratch box isn't available here/);
});

test("reachExec ON + scratchExec ON: scope accepts scoped, scratch, AND a room", async () => {
  const { tc, seen } = sinkToolContext();
  const [execute] = createPiTools({ current: tc }, { reachExec: true, scratchExec: true });
  assert.deepEqual(schemaProps(execute!), ["command", "computer", "purpose", "timeout_seconds", "scope", "durable"]);
  await call(execute, { command: "x", scope: "scratch" });
  assert.deepEqual(seen.at(-1)!.opts, { scratch: true });
  await call(execute, { command: "x", scope: "#ops" });
  assert.deepEqual(seen.at(-1)!.opts, { reachTarget: "#ops" });
  await call(execute, { command: "x" });
  assert.deepEqual(seen.at(-1)!.opts, undefined);
  const e = textOf(await call(execute, { command: "x", scope: "scratch", durable: true }));
  assert.match(e, /scratch box cannot be made durable/);
});

test("reachExec ON: the scoped/scratch keywords match case-insensitively, never routed as a room", async () => {
  const { tc, seen } = sinkToolContext();
  const [execute] = createPiTools({ current: tc }, { reachExec: true, scratchExec: true });
  await call(execute, { command: "x", scope: "Scoped" });
  assert.deepEqual(seen.at(-1)!.opts, undefined, '"Scoped" is the scoped box, not a reach target');
  await call(execute, { command: "x", scope: "SCRATCH" });
  assert.deepEqual(seen.at(-1)!.opts, { scratch: true }, '"SCRATCH" is the scratch box, not a reach target');
  await call(execute, { command: "x", scope: "#project-alpha" });
  assert.deepEqual(
    seen.at(-1)!.opts,
    { reachTarget: "#project-alpha" },
    "a room name passes through verbatim for the resolver to normalize",
  );
});

test("reachExec ON: the description advertises rooms and the 'other computers' pointer", () => {
  const { tc } = sinkToolContext();
  const [execute] = createPiTools({ current: tc }, { reachExec: true });
  const desc = (execute as unknown as { description: string }).description;
  assert.match(desc, /a room like "#project-alpha"/);
  assert.match(desc, /Other computers you can reach/);
  assert.doesNotMatch(desc, /"scratch":/, "scratch is not advertised when only reach is on");
});

test("Trap 1: a reach result prefixes provenance and keeps the SESSION scope label, not the channel", async () => {
  const emitted: Array<{ type: string; scopeLabel: string }> = [];
  const { tc } = sinkToolContext();
  const ref: ToolContextRef = {
    current: tc,
    emit: (e) => void emitted.push(e as never),
    scopeLabel: scopeId("personal", "U1"),
    orgScopeId: scopeId("org", "default-org"),
  };
  const [execute] = createPiTools(ref, { reachExec: true });
  const r = await call(execute, { command: "cat x", scope: "#project-alpha" });
  assert.match(textOf(r), /\[ran on #project-alpha's computer\]/);
  const toolResult = emitted.find((e) => e.type === "tool_result")!;
  assert.equal(
    toolResult.scopeLabel,
    scopeId("personal", "U1"),
    "the channel label would be filtered from the DM's own history (Trap 1)",
  );
});

function freshApp(extra: Partial<Config> = {}) {
  const config: Config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-reach-")),
    ...extra,
  });
  return buildApp(config);
}

const dm = (text: string): TurnRequest => ({
  surface: "test",
  actor: { externalId: "U1", displayName: "Alice" },
  conversation: { kind: "dm", threadRef: "dm:U1:t1" },
  text,
});

const channelTurn = (text: string): TurnRequest => ({
  surface: "test",
  actor: { externalId: "U1", displayName: "Alice" },
  conversation: {
    kind: "channel",
    threadRef: "ch:C-ph:t1",
    channelRef: "C-ph",
    channelName: "project-alpha",
    audience: [{ externalId: "U1" }],
  },
  text,
});

test("DM + directory + flag: execute(scope:#room) runs on that channel's own computer", async () => {
  const built = freshApp({ reachExecEnabled: true });
  await built.directory.replaceChannels([{ channelId: "C-ph", name: "project-alpha" }]);
  const res = await built.app.turn(
    dm("!reach #project-alpha sh -c \"echo 'still here' > smoke.txt && cat smoke.txt\""),
  );
  assert.equal(res.status, "ok");
  assert.equal(res.reply, "still here");
  assert.ok(
    fakeSprites.calls.some((c) => c.method === "POST" && /\/sprites\/qm-channel-c-ph-[^/]+\/exec$/.test(c.path)),
    "the command landed on the channel's computer",
  );
});

test("reach teardown destroys a visited room that has no computer of its own (no leaked box)", async () => {
  const built = freshApp({ reachExecEnabled: true });
  await built.directory.replaceChannels([{ channelId: "C-ph", name: "project-alpha" }]);
  await built.app.turn(dm("!reach #project-alpha echo hi"));
  assert.equal(
    fakeSprites.names().some((n) => n.startsWith("qm-channel-c-ph-")),
    false,
    "the visitor box is destroyed",
  );
});

test("reach teardown keeps (does not destroy) a room with its own computer", async () => {
  const built = freshApp({ reachExecEnabled: true });
  await built.directory.replaceChannels([{ channelId: "C-ph", name: "project-alpha" }]);
  await built.livenessCache.put({ scopeId: scopeId("channel", "C-ph"), checkedAt: 1, connectors: {} });
  await built.app.turn(dm("!reach #project-alpha echo hi"));
  assert.ok(
    fakeSprites.names().some((n) => n.startsWith("qm-channel-c-ph-")),
    "an operated room's computer is kept, not destroyed",
  );
});

test("Trap 1 e2e: the reach tool_result is labeled the session scope and survives the audience filter", async () => {
  const built = freshApp({ reachExecEnabled: true });
  await built.directory.replaceChannels([{ channelId: "C-ph", name: "project-alpha" }]);
  const res = await built.app.turn(dm("!reach #project-alpha echo hello"));
  assert.equal(res.reply, "hello");
  const entries = await built.sessions.getEntries(res.sessionId!);
  const toolResults = entries.filter((e) => e.type === "tool_result");
  assert.ok(toolResults.length >= 1, "a reach tool_result was recorded");
  for (const e of toolResults) assert.equal(e.scopeLabel, scopeId("personal", "U1"));
  const audience: Principal[] = [{ id: "U1", type: "internal" }];
  const kept = filterHistoryForAudience(entries, audience, scopeId("personal", "U1"), scopeId("org", "default-org"));
  assert.ok(
    kept.some((e) => e.type === "tool_result"),
    "the reach result is not dropped from the DM's own next turn",
  );
});

test("DM reach to a private channel the human isn't in is denied", async () => {
  const built = freshApp({ reachExecEnabled: true });
  await built.directory.replace([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "User Two", type: "internal" },
  ]);
  await built.directory.replaceChannels(
    [{ channelId: "C-sec", name: "secret", isPrivate: true }],
    [{ channelId: "C-sec", principalId: "U2" }],
  );
  const res = await built.app.turn(dm("!reach #secret cat x"));
  assert.match(res.reply!, /private and I can't confirm you're a member/);
});

test("reach is DM-only in v1: a channel turn has no reach wired", async () => {
  const built = freshApp({ reachExecEnabled: true });
  await built.directory.replaceChannels([{ channelId: "C-ph", name: "project-alpha" }]);
  const res = await built.app.turn(channelTurn("!reach #project-alpha echo hi"));
  assert.match(res.reply!, /works from a DM/);
});

test("flag off: a DM has neither a wired reach nor a roster block", async () => {
  const built = freshApp();
  await built.directory.replaceChannels([{ channelId: "C-ph", name: "project-alpha" }]);
  const reach = await built.app.turn(dm("!reach #project-alpha echo hi"));
  assert.match(reach.reply!, /works from a DM/);
  const sys = await built.app.turn(dm("!sysprompt"));
  assert.ok(!sys.reply!.includes("Other computers you can reach"));
});

test("roster: omitted when the actor shares no reachable channels", async () => {
  const built = freshApp({ reachExecEnabled: true });
  const res = await built.app.turn(dm("!sysprompt"));
  assert.ok(!res.reply!.includes("Other computers you can reach"));
});

test("roster: lists shared rooms and caps at 30 with a '…and N more' marker", async () => {
  const built = freshApp({ reachExecEnabled: true });
  await built.directory.replaceChannels(
    Array.from({ length: 31 }, (_, i) => ({ channelId: `C${i}`, name: `room-${String(i).padStart(2, "0")}` })),
  );
  const res = await built.app.turn(dm("!sysprompt"));
  assert.ok(res.reply!.includes("Other computers you can reach"));
  assert.match(res.reply!, /…and 1 more — name one to check/);
});

test("roster: the directory read is cached per instance across turns (off the hot path)", async () => {
  const built = freshApp({ reachExecEnabled: true });
  await built.directory.replaceChannels([{ channelId: "C-ph", name: "project-alpha" }]);
  let calls = 0;
  const real = built.directory.listChannelsFor.bind(built.directory);
  built.directory.listChannelsFor = async (p) => {
    calls++;
    return real(p);
  };
  await built.app.turn(dm("!sysprompt"));
  await built.app.turn(dm("!sysprompt"));
  assert.equal(calls, 1, "the second turn is served from the per-instance TTL cache");
});
