import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopClientForTurn } from "../src/core/turn-origin.ts";

test("desktop execution requires a human web turn with a live desktop binding", () => {
  const human = { origin: { kind: "human" as const }, surface: "web", desktopClientId: "desktop-turn" };
  assert.equal(desktopClientForTurn(human), "desktop-turn");
  for (const kind of ["direct", "ambient", "automation"] as const)
    assert.equal(desktopClientForTurn({ ...human, origin: { kind } }), undefined);
  for (const patch of [
    { desktopClientId: undefined },
    { surface: "slack" },
    { proactiveOpener: true },
    { spawned: true },
    { botActor: true },
    { origin: undefined },
    { attempt: 2 },
  ])
    assert.equal(desktopClientForTurn({ ...human, ...patch }), undefined);
});
