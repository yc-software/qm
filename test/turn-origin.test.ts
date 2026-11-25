import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopClientForTurn, introducesUser, mayDriveDesktop, sessionTurnOrigin } from "../src/core/turn-origin.ts";

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

test("only messages a person sent may drive their desktop, from any client", () => {
  assert.equal(mayDriveDesktop({ origin: { kind: "human" } }), true);
  for (const kind of ["direct", "ambient", "automation"] as const)
    assert.equal(mayDriveDesktop({ origin: { kind } }), false);
  for (const patch of [{ botActor: true }, { proactiveOpener: true }, { surfaceOrigin: { audience: "external" } }])
    assert.equal(mayDriveDesktop({ origin: { kind: "human" }, ...patch } as never), false);
});

test("a session message from a fire does not carry the fire marker", () => {
  assert.deepEqual(sessionTurnOrigin({ kind: "automation", fire: true }, "hi"), {
    kind: "automation",
    screenData: "hi",
  });
});
