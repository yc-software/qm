import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopClientForTurn, introducesUser } from "../src/core/turn-origin.ts";

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
  assert.equal(introducesUser({ kind: "direct" }, {}), true);
  assert.equal(introducesUser({ kind: "human" }, {}), true);
  assert.equal(introducesUser({ kind: "automation" }, {}), false);
  assert.equal(introducesUser({ kind: "ambient", live: true }, {}), true, "a live reply in a thread QM follows counts");
  assert.equal(introducesUser({ kind: "ambient" }, {}), false);
  assert.equal(introducesUser({ kind: "direct" }, { sessionSenderId: "s1" }), false);
  assert.equal(
    introducesUser({ kind: "direct" }, { surfaceOrigin: { audience: "external" } as never }),
    false,
    "someone from another Slack workspace is not one of ours",
  );
});
