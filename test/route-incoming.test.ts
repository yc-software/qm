import { test } from "node:test";
import assert from "node:assert/strict";
import { isHalt, routeIncoming, type Incoming, type LiveTurn } from "../src/wake/route-incoming.ts";

const person: Incoming = {
  origin: "human",
  person: true,
  text: "make it green",
  hasFiles: false,
  actorId: "U1",
  modelAccount: "company",
  routed: false,
};
const live: LiveTurn = {
  kind: "run",
  origin: "human",
  actorId: "U1",
  modelAccount: "company",
  handlesThisMessage: false,
};
const steer = { midTurn: "steer" } as const;

test("a message already routed once, or from automation or a direct caller, is always its own turn", () => {
  assert.deepEqual(routeIncoming({ ...person, routed: true }, live, steer), { kind: "turn", reason: "not-mid-turn" });
  for (const origin of ["automation", "direct"] as const)
    assert.deepEqual(routeIncoming({ ...person, origin }, live, steer), { kind: "turn", reason: "not-mid-turn" });
});

test("a different model account queues; a personal account steers only its owner's turn", () => {
  const personal = { ...live, modelAccount: "openai" };
  assert.equal(routeIncoming({ ...person, modelAccount: "openai" }, live, steer).kind, "turn");
  assert.equal(routeIncoming({ ...person, modelAccount: "openai" }, personal, steer).kind, "steer");
  assert.deepEqual(routeIncoming({ ...person, actorId: "U2", modelAccount: "openai" }, personal, steer), {
    kind: "turn",
    reason: "account",
  });
  assert.equal(routeIncoming({ ...person, actorId: "U2" }, live, steer).kind, "steer");
});

test("the turn already handling this very message takes it past the origin gates and the Queue preference", () => {
  const worker = { ...live, origin: "automation" as const, handlesThisMessage: true };
  assert.deepEqual(routeIncoming(person, worker, { midTurn: "queue" }), { kind: "steer" });
  assert.deepEqual(routeIncoming(person, { ...worker, handlesThisMessage: false }, { midTurn: "queue" }), {
    kind: "turn",
    reason: "automation-live",
  });
});

test("an explicit Steer reaches a live automation turn; a message without that choice still runs as its own turn", () => {
  const automation = { ...live, origin: "automation" as const };
  assert.deepEqual(routeIncoming(person, automation, steer), { kind: "steer" });
  assert.deepEqual(routeIncoming(person, automation, {}), { kind: "turn", reason: "automation-live" });
  assert.deepEqual(routeIncoming(person, live, {}), { kind: "steer" });
});

test("an unprompted batch, or the turn already handling the message, still joins a bot's live turn", () => {
  const bot = { ...live, bot: true };
  assert.equal(routeIncoming({ ...person, origin: "ambient", person: false }, bot, {}).kind, "steer");
  assert.equal(routeIncoming(person, { ...bot, handlesThisMessage: true }, {}).kind, "steer");
});

test("when only a conversation's subagents are running, a bare stop stops them and anything else is a new turn", () => {
  const descendants: LiveTurn = { kind: "descendants", actorIds: ["U1"] };
  assert.deepEqual(routeIncoming({ ...person, text: "stop" }, descendants, steer), { kind: "abort" });
  assert.deepEqual(routeIncoming(person, descendants, steer), { kind: "turn", reason: "only-subagents-live" });
});

test("isHalt matches a bare stop, optionally after the agent's own handle, and nothing wordier", () => {
  for (const s of ["stop", "STOP", "Stop.", "stop!", "  stop  "]) assert.ok(isHalt(s), s);
  for (const s of ["stop the build", "please stop", "stopwatch", "stop?", ""]) assert.ok(!isHalt(s), s);
  for (const s of ["@qm stop", "@qm Stop!"]) assert.ok(isHalt(s, "qm"), s);
  for (const s of ["@qm stop it", "@qmstop", "@alice stop", "@here stop"]) assert.ok(!isHalt(s, "qm"), s);
});

test("an un-mentioned bare stop stops a run or its subagents only when their starter sends it", () => {
  const overheardStop: Incoming = { ...person, origin: "ambient", person: true, text: "stop" };
  const descendants: LiveTurn = { kind: "descendants", actorIds: ["U1"] };
  assert.deepEqual(routeIncoming(overheardStop, live, steer), { kind: "abort" });
  assert.deepEqual(routeIncoming(overheardStop, descendants, steer), { kind: "abort" });
  assert.deepEqual(routeIncoming({ ...overheardStop, actorId: "U2" }, live, steer), { kind: "steer" });
  assert.deepEqual(routeIncoming({ ...overheardStop, actorId: "U2" }, descendants, steer), {
    kind: "turn",
    reason: "only-subagents-live",
  });
});

test("an empty message is dropped before any reason to run it as its own turn", () => {
  assert.deepEqual(routeIncoming({ ...person, text: " ", modelAccount: "openai" }, live, steer), {
    kind: "drop",
    reason: "empty",
  });
});
