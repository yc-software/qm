import assert from "node:assert/strict";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { createTurnToolState, type TurnToolStateInit } from "../../src/harness/turn-tool-state.ts";
import { createMemoryRunSignalStore, waitForClientResult } from "../../src/runs/run-signal-store.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import type { ClientToolDeclaration } from "../../src/types.ts";
import { itemFields, type Item, type NewItem } from "../../src/sessions/items.ts";

function fakeToolContextPart1(sink?: {
  lastExecOpts?: Parameters<ToolContext["execute"]>[1];
}): Pick<
  ToolContext,
  | "execute"
  | "attach"
  | "restartComputer"
  | "computerStatus"
  | "listSkills"
  | "skill"
  | "read"
  | "write"
  | "publish"
  | "setDeploymentPublic"
  | "memorySearch"
  | "memoryRead"
  | "memoryAdd"
  | "memoryEdit"
  | "memoryDelete"
  | "history"
  | "historyOpen"
  | "backgroundStart"
  | "backgroundPoll"
  | "backgroundStop"
  | "backgroundWrite"
  | "backgroundList"
  | "backgroundWatch"
  | "backgroundUnwatch"
> {
  return {
    async execute(command, opts) {
      if (sink) sink.lastExecOpts = opts;
      return { stdout: `ran ${command}`, stderr: "", code: 0, timedOut: false };
    },
    async attach(files) {
      return {
        ok: true,
        files: files.map((name) => ({
          name: typeof name === "string" ? name : name.file_id,
          mimetype: "text/plain",
          sizeBytes: 1,
        })),
        staged: files.length,
      };
    },
    async restartComputer() {},
    async computerStatus() {
      return { machine: "healthy", guestResponsive: true };
    },
    async listSkills() {
      return { sourceScopeId: null, skills: [] };
    },
    async skill() {
      return { content: null, sourceScopeId: null };
    },
    async read(path) {
      return path === "a.txt"
        ? { content: "data", sourceScopeId: "personal:U1" }
        : { content: null, sourceScopeId: null };
    },
    async write() {},
    async publish(input) {
      return {
        id: "dep-1",
        ...(input.name ? { name: input.name } : {}),
        version: 1,
        url: `/d/${input.name ?? "dep-1"}/`,
      };
    },
    async setDeploymentPublic(id, isPublic) {
      return { id, name: id, public: isPublic };
    },
    async memorySearch(q) {
      return q.includes("billing") ? ["(2026-05-31) Owns the billing service"] : [];
    },
    async memoryRead() {
      return "# Memory\n- (2026-05-31) Owns the billing service\n";
    },
    async memoryAdd(facts) {
      return facts.length;
    },
    async memoryEdit() {
      return true;
    },
    async memoryDelete() {
      return true;
    },
    async history(q) {
      return q.includes("budget") ? ["user#3 (2026-06-01T00:00:00.000Z): the budget doc is in shared/q2.md"] : [];
    },
    async historyOpen(seq) {
      return seq === 3 ? "user#3 (2026-06-01T00:00:00.000Z): the budget doc is in shared/q2.md — full text" : null;
    },
    async backgroundStart(command) {
      return {
        processId: "bg-1",
        output: `started ${command}`,
        cursor: 7,
        status: { state: "running" },
        reattached: false,
      };
    },
    async backgroundPoll(processId) {
      return {
        processId,
        chunks: "more output",
        cursor: 18,
        status: { state: "exited", code: 0 },
      };
    },
    async backgroundStop(processId) {
      return { processId, status: { state: "exited", code: 0 }, stopped: true };
    },
    async backgroundWrite(processId, data) {
      return { processId, bytes: data.length, status: { state: "running" } };
    },
    async backgroundList() {
      return [
        {
          processId: "bg-1",
          command: "bg: npm test",
          status: { state: "running" },
          registryStatus: "running",
          startedAt: 0,
        },
      ];
    },
    async backgroundWatch(processId) {
      return { monitorId: "mon-1", processId, reattached: false, expiresAt: 0 };
    },
    async backgroundUnwatch(monitorId) {
      return { monitorId, removed: true };
    },
  };
}

function fakeToolContextPart4(): Pick<ToolContext, "cronCreate"> {
  return {
    async cronCreate(req) {
      return {
        ok: true,
        cron: {
          id: "cron-1",
          ownerScopeId: "personal:U1",
          owner: "U1",
          createdBy: "U1",
          enabled: true,
          createdAt: 0,
          schedule: req.schedule,
          ...(req.title ? { title: req.title } : {}),
          ...(req.action ? { action: req.action } : {}),
          ...(req.text ? { message: req.text } : {}),
        },
        ...(req.recipient ? { recipient: { principalId: "U2", displayName: req.recipient } } : {}),
        ...(req.channel ? { channel: { channelId: "C2", name: req.channel } } : {}),
      };
    },
  };
}

function fakeToolContextPart2(): Pick<
  ToolContext,
  | "cronList"
  | "cronGet"
  | "cronRuns"
  | "cronPatch"
  | "cronNote"
  | "cronDelete"
  | "cronSetEnabled"
  | "cronRun"
  | "webhookCreate"
  | "webhookList"
  | "webhookUpdate"
> {
  return {
    async cronList() {
      return {
        crons: [
          {
            id: "cron-1",
            ownerScopeId: "personal:U1",
            owner: "U1",
            createdBy: "U1",
            enabled: true,
            createdAt: 0,
            schedule: { everyMs: 3_600_000 },
            title: "Gmail digest",
            action: "check gmail",
          },
        ],
        visible: [],
      };
    },
    async cronGet(id) {
      return {
        ok: true,
        cron: {
          id,
          ownerScopeId: "personal:U1",
          owner: "U1",
          createdBy: "U1",
          enabled: true,
          createdAt: 0,
          schedule: { everyMs: 3_600_000 },
          title: "Gmail digest",
        },
      };
    },
    async cronRuns(id) {
      return {
        ok: true,
        cron: {
          id,
          ownerScopeId: "personal:U1",
          owner: "U1",
          createdBy: "U1",
          enabled: true,
          createdAt: 0,
          schedule: { everyMs: 3_600_000 },
          title: "Gmail digest",
        },
        total: 1,
        runs: [
          {
            fireKey: "cron-1:fire",
            threadRef: "cron:cron-1:fire:abc",
            firedAt: 1,
            status: "ok",
            reply: "checked inbox",
          },
        ],
      };
    },
    async cronPatch(id) {
      return {
        ok: true,
        cron: {
          id,
          ownerScopeId: "personal:U1",
          owner: "U1",
          createdBy: "U1",
          enabled: true,
          createdAt: 0,
          schedule: { everyMs: 3_600_000 },
          title: "renamed",
        },
      };
    },
    async cronNote() {
      return { ok: true, applied: true };
    },
    async cronDelete() {
      return { ok: true };
    },
    async cronSetEnabled(id, enabled) {
      return {
        ok: true,
        cron: {
          id,
          ownerScopeId: "personal:U1",
          owner: "U1",
          createdBy: "U1",
          enabled,
          createdAt: 0,
          schedule: { everyMs: 3_600_000 },
        },
      };
    },
    async cronRun() {
      return { ok: true, fireKey: "cron:c1:manual:test" };
    },
    async webhookCreate(req) {
      return {
        ok: true,
        webhook: {
          id: "wh-1",
          ownerScopeId: "personal:U1",
          owner: "U1",
          createdBy: "U1",
          enabled: true,
          createdAt: 0,
          action: req.action,
          verification: req.verification,
        },
        url: "https://portal.example/v1/webhooks/incoming/wh-1",
        ...(req.verification.secret ? { secret: req.verification.secret } : {}),
      };
    },
    async webhookList() {
      return [
        {
          id: "wh-1",
          ownerScopeId: "personal:U1",
          owner: "U1",
          createdBy: "U1",
          enabled: true,
          createdAt: 0,
          action: "do a thing",
          verification: { scheme: "github", secret: "***" },
        },
      ];
    },
    async webhookUpdate() {
      return { ok: false as const, code: "not_found" as const, message: "x" };
    },
  };
}

function fakeToolContextPart3(): Pick<
  ToolContext,
  | "webhookDisable"
  | "instructionsRead"
  | "instructionsWrite"
  | "shareArtifact"
  | "post"
  | "reach"
  | "react"
  | "edit"
  | "delete"
  | "readThread"
  | "whatsNew"
  | "search"
  | "readMembers"
  | "readFile"
  | "getChannelBehavior"
  | "setChannelBehavior"
  | "callMcpTool"
  | "mcpToolNeedsApproval"
  | "awaitClientResult"
> {
  return {
    async webhookDisable() {
      return { ok: true };
    },
    instructionsRead() {
      return { effectiveInstructions: "Org policy.\n\nBe terse.", instructions: "Be terse.", instructionsVersion: 3 };
    },
    async instructionsWrite() {
      return { ok: true, version: 4 };
    },
    async shareArtifact() {
      return {
        ok: true,
        verb: "share",
        type: "file",
        id: "F1",
        target: { scope: "channel:C1", label: "#avery-jordan" },
        permission: "read",
      };
    },
    async post() {
      return { ok: true };
    },
    async reach() {
      return { ok: true, matched: "#somewhere" };
    },
    async react() {
      return { ok: true };
    },
    async edit() {
      return { ok: true };
    },
    async delete() {
      return { ok: true };
    },
    async readThread() {
      return { ok: true, messages: [] };
    },
    async whatsNew() {
      return { ok: true, hereNew: 3, activeSubConversations: 2, latest: "1712345678.9" };
    },
    async search(query) {
      return query.includes("budget")
        ? {
            ok: true,
            source: "live",
            hits: [
              {
                ref: "1712.5",
                author: "Bob",
                when: "2026-06-01T00:00:00.000Z",
                snippet: "the budget doc is in shared/q2.md",
              },
            ],
          }
        : { ok: true, source: "cache", hits: [] };
    },
    async readMembers() {
      return { ok: true, members: [{ displayName: "Ada" }, { displayName: "Bob" }] };
    },
    async readFile(ref, offset) {
      if (ref === "dddddddddddddddddddddddddddddddd")
        return offset
          ? { ok: true, content: "page two", sizeBytes: 30 }
          : { ok: true, content: "page one", sizeBytes: 30, nextOffset: 8, totalChars: 16 };
      if (ref === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        return { ok: true, content: "hello from the file", sizeBytes: 19 };
      if (ref === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        return { ok: true, sizeBytes: 1024, contentType: "application/octet-stream" };
      return { ok: false, message: "I can't find that file — it may have expired." };
    },
    async getChannelBehavior() {
      return { ok: false, message: "channel settings apply only inside a channel." };
    },
    async setChannelBehavior() {
      return { ok: false, message: "channel settings apply only inside a channel." };
    },
    async callMcpTool() {
      return "";
    },
    async mcpToolNeedsApproval() {
      return false;
    },
    async awaitClientResult() {
      return "timeout" as const;
    },
  };
}

export function fakeToolContext(sink?: { lastExecOpts?: Parameters<ToolContext["execute"]>[1] }): ToolContext {
  return {
    ...fakeToolContextPart1(sink),
    ...fakeToolContextPart2(),
    ...fakeToolContextPart3(),
    ...fakeToolContextPart4(),
  };
}

export type Emitted = NewItem & { fields: any };
export const emittedItem = (e: NewItem): Emitted => ({ ...e, fields: itemFields(e as Item) });
export const call = (tool: ReturnType<typeof createAgentTools>[number] | undefined, params: unknown) => {
  assert.ok(tool);
  return (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)("t", params);
};

export const surfaceTool = (ref: TurnToolStateInit, name = "slack") => {
  const t = createAgentTools(createTurnToolState(ref), {
    surfaceTools: true,
    ...(name !== "slack" ? { surfaceName: name } : {}),
  }).find((x) => x.name === name);
  assert.ok(t, `the surface tool registers as \`${name}\``);
  return t;
};

export const callWith = (
  tool: ReturnType<typeof createAgentTools>[number] | undefined,
  id: string,
  params: unknown,
) => {
  assert.ok(tool);
  return (tool.execute as unknown as (i: string, p: unknown) => Promise<unknown>)(id, params);
};

export const tool = (name: string, tc = fakeToolContext()) => {
  const t = createAgentTools(createTurnToolState({ current: tc }), { controlTools: true }).find((x) => x.name === name);
  assert.ok(t, `${name} tool exists`);
  return t;
};
export const textOut = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

export const clientTool = (name: string, timeoutMs?: number): ClientToolDeclaration => ({
  name,
  description: `Page tool ${name}`,
  inputSchema: { type: "object", properties: { note: { type: "string" } } },
  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
});

export function clientToolRef(store = createMemoryRunSignalStore()) {
  const emitted: Emitted[] = [];
  const cancel = new AbortController();
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      awaitClientResult: (callId, timeoutMs, signal) =>
        waitForClientResult(store, "run-1", callId, { timeoutMs, ...(signal ? { signal } : {}) }),
    },
    abortSignal: cancel.signal,
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  return { store, emitted, cancel, ref };
}
