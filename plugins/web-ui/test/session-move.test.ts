import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  beginSessionMoveDrag,
  endSessionMoveDrag,
  movableInto,
  projectDropHandlers,
  registerSessionMoveHost,
  runSessionMove,
  SESSION_DROP_OVER_CLASS,
  sessionsToMove,
} from "../src/session-move.ts";
import type { CoreSession } from "../src/core-bridge.ts";

const sessions = [
  { id: "a", scopeId: "personal:me", surface: "web" },
  { id: "b", scopeId: "personal:me", surface: "web" },
  { id: "c", scopeId: "group:project:launch", surface: "web" },
  { id: "busy", scopeId: "personal:me", surface: "web", working: true },
  { id: "slack", scopeId: "personal:me", surface: "slack" },
  { id: "parent", scopeId: "personal:me", surface: "web" },
  { id: "child", scopeId: "personal:me", surface: "web", parentSessionId: "parent" },
  { id: "channel", scopeId: "channel:C1", surface: "web" },
  { id: "other", scopeId: "group:project:other", surface: "web" },
  { id: "shared", scopeId: "personal:someone-else", surface: "web" },
  { id: "goal", scopeId: "personal:me", surface: "web", goal: { objective: "ship", activeMs: 0 } },
  { id: "cron", scopeId: "personal:me", surface: "web", crons: 1 },
] as CoreSession[];

test("dragging a selected row carries the whole selection; other rows move alone", () => {
  assert.deepEqual(sessionsToMove(new Set(["a", "b"]), "b"), ["a", "b"]);
  assert.deepEqual(sessionsToMove(new Set(["a", "b"]), "c"), ["c"]);
  assert.deepEqual(sessionsToMove(new Set(["a"]), "a"), ["a"]);
  assert.deepEqual(sessionsToMove(new Set(), "a"), ["a"]);
});

const movableFrom = (scopeId: string) => scopeId === "personal:me" || scopeId.startsWith("group:project:");

test("own web chats and project chats outside the project are offered; the server explains what it holds back", () => {
  const all = sessions.map((s) => s.id);
  assert.deepEqual(movableInto(sessions, [...all, "missing"], "group:project:launch", movableFrom), [
    "a",
    "b",
    "busy",
    "parent",
    "other",
    "goal",
    "cron",
  ]);
  assert.deepEqual(movableInto(sessions, ["c"], "group:project:launch", movableFrom), []);
});

function fixture() {
  const dom = new JSDOM('<section id="project"><div id="child"></div></section><div id="outside"></div>');
  const doc = dom.window.document;
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: doc });
  const target = doc.querySelector<HTMLElement>("#project")!;
  const child = doc.querySelector<HTMLElement>("#child")!;
  const outside = doc.querySelector<HTMLElement>("#outside")!;
  const moves: Array<{ ids: readonly string[]; scopeId: string }> = [];
  registerSessionMoveHost({
    sessions: () => sessions,
    movableFrom,
    move: async (ids, scopeId) => {
      moves.push({ ids, scopeId });
    },
  });
  const handlers = projectDropHandlers("group:project:launch");
  for (const type of ["dragenter", "dragover", "dragleave", "drop"] as const)
    target.addEventListener(type, (event) => handlers[type](event as unknown as DragEvent));
  const fire = (type: string, at: EventTarget = target, relatedTarget: EventTarget | null = null) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget });
    at.dispatchEvent(event);
    return event;
  };
  return { target, child, outside, moves, fire };
}

test("a project accepts dragged sessions, highlights while over, and moves them on drop", () => {
  const { target, child, outside, moves, fire } = fixture();
  beginSessionMoveDrag(["a", "b"]);
  assert.equal(fire("dragover").defaultPrevented, true, "dragover must be cancelled for the drop to fire");
  assert.ok(target.classList.contains(SESSION_DROP_OVER_CLASS));
  fire("dragleave", target, child);
  assert.ok(target.classList.contains(SESSION_DROP_OVER_CLASS), "moving onto a child keeps the highlight");
  fire("dragleave", target, outside);
  assert.ok(!target.classList.contains(SESSION_DROP_OVER_CLASS));
  fire("dragenter");
  fire("drop");
  assert.ok(!target.classList.contains(SESSION_DROP_OVER_CLASS));
  assert.deepEqual(moves, [{ ids: ["a", "b"], scopeId: "group:project:launch" }]);
  assert.equal(fire("dragover").defaultPrevented, false, "the drag is over once dropped");
});

test("a project accepts working chats so the refusal can be explained, and ignores ones already there", () => {
  const { target, moves, fire } = fixture();
  endSessionMoveDrag();
  assert.equal(fire("dragover").defaultPrevented, false);
  beginSessionMoveDrag(["c"]);
  assert.equal(fire("dragover").defaultPrevented, false, "a chat already in the project is not a drop");
  beginSessionMoveDrag(["c", "busy"]);
  assert.equal(fire("dragover").defaultPrevented, true);
  fire("drop");
  assert.ok(!target.classList.contains(SESSION_DROP_OVER_CLASS));
  assert.deepEqual(moves, [{ ids: ["busy"], scopeId: "group:project:launch" }]);
  beginSessionMoveDrag(["a"]);
  fire("dragover");
  endSessionMoveDrag();
  assert.ok(!target.classList.contains(SESSION_DROP_OVER_CLASS), "ending the drag clears every highlight");
});

function io(opts: { gains?: string[]; refuse?: Record<string, string>; confirm?: boolean; fail?: string }) {
  const asked: string[] = [];
  const moved: Array<{ ids: readonly string[]; audience: readonly string[] }> = [];
  const names: Record<string, string> = { ada: "Ada", grace: "Grace" };
  return {
    asked,
    moved,
    io: {
      project: "Launch",
      title: (id: string) => `Chat ${id}`,
      move: async (ids: readonly string[], audience: readonly string[]) => {
        if (opts.fail) throw new Error(opts.fail);
        const held = ids.flatMap((id) => (opts.refuse?.[id] ? [{ sessionId: id, message: opts.refuse[id] }] : []));
        const gains = opts.gains ?? [];
        if (gains.some((p) => !audience.includes(p)))
          return {
            confirm: gains.map((p) => ({ principalId: p, displayName: names[p]! })),
            question: `Let ${gains.map((p) => names[p]).join(" and ")} read ${ids.length} chats?`,
            held,
          };
        const ready = ids.filter((id) => !opts.refuse?.[id]);
        moved.push({ ids: ready, audience });
        return { sessions: ready.map((id) => ({ id, scopeId: "group:project:launch" }) as CoreSession), held };
      },
      confirm: (question: string) => {
        asked.push(question);
        return opts.confirm ?? true;
      },
      reason: (error: unknown) => (error as Error).message,
    },
  };
}

test("a move that gives nobody new access goes ahead without asking", async () => {
  const t = io({});
  const out = await runSessionMove(["a"], t.io);
  assert.deepEqual(t.asked, []);
  assert.deepEqual(t.moved, [{ ids: ["a"], audience: [] }]);
  assert.equal(out.toast, "Moved to Launch");
});

test("a multi-select drag shows the server's question once, then moves with that audience", async () => {
  const t = io({ gains: ["ada", "grace"] });
  const out = await runSessionMove(["a", "b"], t.io);
  assert.deepEqual(t.asked, ["Let Ada and Grace read 2 chats?"]);
  assert.deepEqual(t.moved, [{ ids: ["a", "b"], audience: ["ada", "grace"] }]);
  assert.equal(out.toast, "Moved 2 chats to Launch");
});

test("cancelling the confirmation moves nothing", async () => {
  const t = io({ gains: ["ada"], confirm: false });
  const out = await runSessionMove(["a", "b"], t.io);
  assert.equal(t.asked.length, 1);
  assert.deepEqual(t.moved, []);
  assert.equal(out.toast, null);
});

test("held chats are named in the toast while the rest still move", async () => {
  const wait = "Wait for the agent to finish before moving this chat.";
  const t = io({ refuse: { busy: wait } });
  const out = await runSessionMove(["a", "busy"], t.io);
  assert.deepEqual(t.moved, [{ ids: ["a"], audience: [] }]);
  assert.equal(out.toast, `Moved 1 of 2 chats to Launch. "Chat busy" wasn't moved: ${wait}`);
  const alone = io({ refuse: { busy: wait } });
  assert.equal((await runSessionMove(["busy"], alone.io)).toast, wait, "a single refusal says why and nothing else");
  const failed = io({ fail: "That project isn't available." });
  assert.equal((await runSessionMove(["a"], failed.io)).toast, "That project isn't available.");
});
