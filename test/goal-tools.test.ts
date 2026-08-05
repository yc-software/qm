import test from "node:test";
import assert from "node:assert/strict";
import { createPiTools, type ToolContextRef } from "../src/harness/pi-tools.ts";
import { createGrindMeter } from "../src/harness/grind.ts";
import { GOAL_BLOCKED_MIN_ROUNDS } from "../src/harness/goal.ts";
import type { ScopeId } from "../src/types.ts";

function toolbox() {
  const ref: ToolContextRef = {
    current: null,
    scopeLabel: { kind: "org", id: "test" } as unknown as ScopeId,
    emit: async () => undefined,
    goalMeter: createGrindMeter(),
  };
  const tools = createPiTools(ref);
  type Res = { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const by = (name: string) => {
    const tool = tools.find((t) => t.name === name)!;
    return {
      execute: (id: string, params: unknown) =>
        (tool.execute as unknown as (id: string, p: unknown) => Promise<Res>)(id, params),
    };
  };
  return { ref, create: by("create_goal"), get: by("get_goal"), update: by("update_goal") };
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

test("create_goal registers once; a second active goal is refused", async () => {
  const { ref, create } = toolbox();
  const first = await create.execute("c1", { objective: "make the suite green" });
  assert.match(textOf(first as never), /registered and now enforced/);
  assert.equal(ref.goal?.status, "active");
  const second = (await create.execute("c2", { objective: "another" })) as { isError?: boolean };
  assert.match(textOf(second as never), /already active/);
});

test("create_goal validates the objective", async () => {
  const { ref, create } = toolbox();
  const bad = await create.execute("c1", { objective: "   " });
  assert.match(textOf(bad as never), /non-empty/);
  assert.equal(ref.goal ?? null, null);
});

test("get_goal reports the record or its absence", async () => {
  const { create, get } = toolbox();
  assert.match(textOf((await get.execute("g0", {})) as never), /No goal registered/);
  await create.execute("c1", { objective: "obj" });
  assert.match(textOf((await get.execute("g1", {})) as never), /"objective": "obj"/);
});

test("update_goal complete: floor must be met first", async () => {
  const { ref, create, update } = toolbox();
  await create.execute("c1", { objective: "work a while", floor: { minTurns: 2 } });
  const early = await update.execute("u1", { status: "complete" });
  assert.match(textOf(early as never), /floor is not met/);
  assert.equal(ref.goal?.status, "active");
  ref.goalMeter!.turns = 5;
  const done = await update.execute("u2", { status: "complete", note: "did it" });
  assert.match(textOf(done as never), /marked complete/);
  assert.equal(ref.goal?.status, "complete");
  assert.equal(ref.goal?.completionNote, "did it");
});

test("update_goal blocked: needs a reason and three claims in distinct rounds", async () => {
  const { ref, create, update } = toolbox();
  await create.execute("c1", { objective: "hopeless" });
  const noReason = await update.execute("u0", { status: "blocked" });
  assert.match(textOf(noReason as never), /requires a note/);
  // same round: repeated claims don't stack
  await update.execute("u1", { status: "blocked", note: "api is down" });
  await update.execute("u2", { status: "blocked", note: "api is down" });
  assert.equal(ref.goal?.blockedStreak, 1, "one claim per round");
  ref.goalRound = 1;
  await update.execute("u3", { status: "blocked", note: "api is down" });
  assert.equal(ref.goal?.blockedStreak, 2);
  assert.equal(ref.goal?.status, "active", "still not accepted");
  ref.goalRound = 2;
  const final = await update.execute("u4", { status: "blocked", note: "api is down" });
  assert.equal(ref.goal?.blockedStreak, GOAL_BLOCKED_MIN_ROUNDS);
  assert.match(textOf(final as never), /marked blocked/);
  assert.equal(ref.goal?.status, "blocked");
});

test("update_goal with no active goal errors cleanly", async () => {
  const { update } = toolbox();
  const res = await update.execute("u1", { status: "complete" });
  assert.match(textOf(res as never), /No active goal/);
});
