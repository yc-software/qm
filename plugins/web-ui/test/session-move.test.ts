import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  beginSessionMoveDrag,
  endSessionMoveDrag,
  movableInto,
  projectDropHandlers,
  registerSessionMoveHost,
  SESSION_DROP_OVER_CLASS,
  sessionsToMove,
} from "../src/session-move.ts";
import type { CoreSession } from "../src/core-bridge.ts";

const sessions = [
  { id: "a", scopeId: "personal:me" },
  { id: "b", scopeId: "personal:me" },
  { id: "c", scopeId: "group:project:launch" },
] as CoreSession[];

test("dragging a selected row carries the whole selection; other rows move alone", () => {
  assert.deepEqual(sessionsToMove(new Set(["a", "b"]), "b"), ["a", "b"]);
  assert.deepEqual(sessionsToMove(new Set(["a", "b"]), "c"), ["c"]);
  assert.deepEqual(sessionsToMove(new Set(["a"]), "a"), ["a"]);
  assert.deepEqual(sessionsToMove(new Set(), "a"), ["a"]);
});

test("only sessions outside the target project are movable", () => {
  assert.deepEqual(movableInto(sessions, ["a", "c", "missing"], "group:project:launch"), ["a"]);
  assert.deepEqual(movableInto(sessions, ["c"], "group:project:launch"), []);
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

test("a project ignores drags that are not sessions or are already there", () => {
  const { target, moves, fire } = fixture();
  endSessionMoveDrag();
  assert.equal(fire("dragover").defaultPrevented, false);
  beginSessionMoveDrag(["c"]);
  assert.equal(fire("dragover").defaultPrevented, false);
  fire("drop");
  assert.ok(!target.classList.contains(SESSION_DROP_OVER_CLASS));
  assert.deepEqual(moves, []);
  beginSessionMoveDrag(["a"]);
  fire("dragover");
  endSessionMoveDrag();
  assert.ok(!target.classList.contains(SESSION_DROP_OVER_CLASS), "ending the drag clears every highlight");
});
