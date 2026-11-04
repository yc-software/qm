import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopClientForTurn, introducesPerson } from "../src/core/turn-origin.ts";

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

test("only a person's own message introduces them to the roster", () => {
  assert.equal(introducesPerson({ kind: "direct" }, {}), true);
  assert.equal(introducesPerson({ kind: "human" }, {}), true);
  assert.equal(introducesPerson({ kind: "automation" }, {}), false);
  assert.equal(introducesPerson({ kind: "human" }, { botActor: true }), false);
  assert.equal(
    introducesPerson({ kind: "ambient", live: true }, {}),
    true,
    "a live reply in a thread QM follows counts",
  );
  assert.equal(introducesPerson({ kind: "ambient" }, {}), false);
  assert.equal(introducesPerson({ kind: "direct" }, { sessionSenderId: "s1" }), false);
  assert.equal(
    introducesPerson({ kind: "direct" }, { surfaceOrigin: { audience: "external" } as never }),
    false,
    "someone from another Slack workspace is not one of ours",
  );
});
