import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  beginSessionMoveDrag,
  endSessionMoveDrag,
  movableInto,
  moveConfirmation,
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

test("every dragged chat outside the project is offered to the server, which decides and explains", () => {
  const all = sessions.map((s) => s.id);
  assert.deepEqual(
    movableInto(sessions, [...all, "missing"], "group:project:launch"),
    all.filter((id) => id !== "c"),
  );
  assert.deepEqual(movableInto(sessions, ["c"], "group:project:launch"), []);
});

test("the confirmation names the chat, the project, and everyone who gains access", () => {
  assert.equal(
    moveConfirmation(["Launch plan"], "Launch", ["Ada"]),
    'Move "Launch plan" to Launch? Ada will be able to read it, including its earlier messages.',
  );
  assert.equal(
    moveConfirmation(["One", "Two"], "Launch", ["Ada", "Grace"]),
    "Move 2 chats to Launch? Ada and Grace will be able to read them, including their earlier messages.",
  );
  assert.equal(
    moveConfirmation(["One"], "Launch", ["A", "B", "C", "D", "E", "F", "G", "H"]),
    'Move "One" to Launch? A, B, C, D, E, F, G and H will be able to read it, including its earlier messages.',
  );
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

function io(opts: { gains?: Record<string, string[]>; refuse?: Record<string, string>; confirm?: boolean }) {
  const asked: string[] = [];
  const moved: Array<{ id: string; audience: readonly string[] }> = [];
  const names: Record<string, string> = { ada: "Ada", grace: "Grace" };
  return {
    asked,
    moved,
    io: {
      project: "Launch",
      title: (id: string) => `Chat ${id}`,
      preview: async (id: string) => {
        if (opts.refuse?.[id]) throw new Error(opts.refuse[id]);
        return { gains: (opts.gains?.[id] ?? []).map((p) => ({ principalId: p, displayName: names[p]! })) };
      },
      move: async (id: string, audience: readonly string[]) => {
        moved.push({ id, audience });
        return { id, scopeId: "group:project:launch" } as CoreSession;
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
  assert.deepEqual(t.moved, [{ id: "a", audience: [] }]);
  assert.equal(out.toast, "Moved to Launch");
});

test("a multi-select drag asks once for everyone who gains access, and moves with that audience", async () => {
  const t = io({ gains: { a: ["ada"], b: ["ada", "grace"] } });
  const out = await runSessionMove(["a", "b"], t.io);
  assert.deepEqual(t.asked, [
    "Move 2 chats to Launch? Ada and Grace will be able to read them, including their earlier messages.",
  ]);
  assert.deepEqual(t.moved, [
    { id: "a", audience: ["ada", "grace"] },
    { id: "b", audience: ["ada", "grace"] },
  ]);
  assert.equal(out.toast, "Moved 2 chats to Launch");
});

test("cancelling the confirmation moves nothing", async () => {
  const t = io({ gains: { a: ["ada"] }, confirm: false });
  const out = await runSessionMove(["a", "b"], t.io);
  assert.equal(t.asked.length, 1);
  assert.deepEqual(t.moved, []);
  assert.equal(out.toast, null);
});

test("refused chats are named in the toast while the rest still move", async () => {
  const wait = "Wait for the agent to finish before moving this chat.";
  const t = io({ refuse: { busy: wait } });
  const out = await runSessionMove(["a", "busy"], t.io);
  assert.deepEqual(
    t.moved.map((m) => m.id),
    ["a"],
  );
  assert.equal(out.toast, `Moved 1 of 2 chats to Launch. "Chat busy" wasn't moved: ${wait}`);
  const alone = io({ refuse: { busy: wait } });
  assert.equal((await runSessionMove(["busy"], alone.io)).toast, wait, "a single refusal says why and nothing else");
});
