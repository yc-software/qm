import { test } from "node:test";
import assert from "node:assert/strict";
import { stepGapMs, decomposeGapPhases } from "../src/harness/pi-harness.ts";
import type { GapWork } from "../src/sessions/session-store.ts";

test("stepGapMs: null on the first step (no prior step to glue from)", () => {
  assert.equal(stepGapMs(undefined, 1000), null, "no prevStepEnd → null");
});

test("stepGapMs: the wall between the prior step's end and this step's stream start", () => {
  assert.equal(stepGapMs(1000, 1450), 450);
});

test("stepGapMs: never negative (clock skew is floored at 0)", () => {
  assert.equal(stepGapMs(1500, 1490), 0, "a backwards clock yields 0, not a negative gap");
});

test("stepGapMs: null when this step's stream start is unknown", () => {
  assert.equal(stepGapMs(1000, undefined), null);
});

test("decomposeGapPhases: serial phases sum to the gap with the rest as residual", () => {
  const work: GapWork[] = [
    { phase: "provision", start: 1000, end: 2939 },
    { phase: "recall", start: 2939, end: 2955 },
    { phase: "exec", start: 2955, end: 3073 },
    { phase: "model_dispatch", start: 3073, end: 13273 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 13765 }, work, 12765);
  assert.deepEqual(phases, { provision: 1939, recall: 16, exec: 118, model_dispatch: 10200, residual: 492 });
  const sum = phases!.provision! + phases!.recall! + phases!.exec! + phases!.model_dispatch! + phases!.residual!;
  assert.equal(sum, 12765, "phases + residual sum exactly to the gap");
});

test("decomposeGapPhases: overlapping (parallel-tool) ops of one phase are unioned, not summed", () => {
  const work: GapWork[] = [
    { phase: "exec", start: 1000, end: 1600 },
    { phase: "exec", start: 1300, end: 1900 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 2000 }, work, 1000);
  assert.equal(phases!.exec, 900, "overlap counted once (union), not 1200 (sum)");
  assert.equal(phases!.residual, 100, "residual = 1000 − 900");
});

test("decomposeGapPhases: clamps ops to the window and never reports a negative residual", () => {
  const work: GapWork[] = [{ phase: "exec", start: 500, end: 5000 }];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 2000 }, work, 1000);
  assert.equal(phases!.exec, 1000, "clamped to the 1000ms window");
  assert.equal(phases!.residual, 0, "no negative residual");
});

test("decomposeGapPhases: ops outside the step's window are ignored (belong to another step)", () => {
  const work: GapWork[] = [
    { phase: "provision", start: 0, end: 900 },
    { phase: "exec", start: 2100, end: 2500 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 2000 }, work, 1000);
  assert.deepEqual(phases, { residual: 1000 }, "nothing attributed; all gap is residual");
});

test("decomposeGapPhases: undefined when there is no gap window (first step) or no gap", () => {
  assert.equal(decomposeGapPhases({ gapEnd: 2000 }, [], 1000), undefined, "no gapStart → undefined");
  assert.equal(decomposeGapPhases(undefined, [], 1000), undefined, "no window → undefined");
  assert.equal(decomposeGapPhases({ gapStart: 1000, gapEnd: 2000 }, [], null), undefined, "no gap → undefined");
});

test("decomposeGapPhases: dispatch_glue + stream_open attribute the glue and zero the residual", () => {
  const work: GapWork[] = [
    { phase: "exec", start: 1100, end: 1300 },
    { phase: "model_dispatch", start: 2000, end: 9000 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 11000 }, work, 10000, {
    onPayload: 2000,
    onResponse: 9000,
    messageStart: 9200,
  });
  assert.equal(phases!.exec, 200);
  assert.equal(phases!.dispatch_glue, 800, "onPayload − gapStart − tool-before-onPayload");
  assert.equal(phases!.model_dispatch, 7000);
  assert.equal(phases!.stream_open, 200, "message_start − onResponse");
});

test("decomposeGapPhases: with marks anchored to the real boundaries the residual is ~0", () => {
  const work: GapWork[] = [{ phase: "model_dispatch", start: 3000, end: 10800 }];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 11000 }, work, 10000, {
    onPayload: 3000,
    onResponse: 10800,
    messageStart: 11000,
  });
  assert.equal(phases!.dispatch_glue, 2000);
  assert.equal(phases!.model_dispatch, 7800);
  assert.equal(phases!.stream_open, 200);
  assert.equal(phases!.residual, 0, "fully attributed");
});

test("decomposeGapPhases: dispatch_glue subtracts tagged tool work in [gapStart, onPayload]", () => {
  const work: GapWork[] = [{ phase: "exec", start: 1000, end: 4000 }];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 11000 }, work, 10000, { onPayload: 4500 });
  assert.equal(phases!.exec, 3000);
  assert.equal(phases!.dispatch_glue, 500, "glue excludes the exec wall");
});

test("decomposeGapPhases: no dispatch marks → behaves as before (only tagged phases + residual)", () => {
  const work: GapWork[] = [{ phase: "exec", start: 1100, end: 1300 }];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 2000 }, work, 1000);
  assert.deepEqual(phases, { exec: 200, residual: 800 }, "no dispatch_glue/stream_open without marks");
});

test("decomposeGapPhases: first step (no gapStart) yields no dispatch_glue even with marks", () => {
  assert.equal(
    decomposeGapPhases({ gapEnd: 2000 }, [], 1000, { onPayload: 1500, onResponse: 1800, messageStart: 2000 }),
    undefined,
    "no gapStart → undefined (first step has no gap to decompose)",
  );
});

test("no-op transformContext hook returns the messages reference unchanged", async () => {
  const ref: { pendingTransformContext?: number } = {};
  const priorTransform: undefined = undefined;
  const transformContext = async (messages: unknown, signal?: unknown): Promise<unknown> => {
    ref.pendingTransformContext = Date.now();
    return priorTransform ? await (priorTransform as (m: unknown, s?: unknown) => unknown)(messages, signal) : messages;
  };
  const input = [{ role: "user", content: "hi" }];
  const out = await transformContext(input);
  assert.equal(out, input, "returns the SAME array reference (no copy, no mutation)");
  assert.equal(typeof ref.pendingTransformContext, "number", "stamped as a side effect");
});

test("no-op prepareNextTurn hook returns undefined so the SDK applies no snapshot", async () => {
  const ref: { pendingPrepareNextTurn?: number } = {};
  const priorPrepare: undefined = undefined;
  const prepareNextTurn = async (signal?: unknown): Promise<unknown> => {
    ref.pendingPrepareNextTurn = Date.now();
    return priorPrepare ? await (priorPrepare as (s?: unknown) => unknown)(signal) : undefined;
  };
  const out = await prepareNextTurn();
  assert.equal(out, undefined, "falsy return → SDK leaves context/config untouched");
  assert.equal(typeof ref.pendingPrepareNextTurn, "number", "stamped as a side effect");
});

test("decomposeGapPhases: hook stamps split dispatch_glue into loop_reentry + context_assemble + glue_other", () => {
  const work: GapWork[] = [{ phase: "model_dispatch", start: 10000, end: 18000 }];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 21000 }, work, 20000, {
    onPayload: 10000,
    onResponse: 18000,
    messageStart: 21000,
    prepareNextTurn: 2500,
    transformContext: 4000,
  });
  assert.equal(phases!.dispatch_glue, 9000);
  assert.equal(phases!.loop_reentry, 1500, "gapStart → prepareNextTurn");
  assert.equal(phases!.context_assemble, 6000, "transformContext → onPayload");
  assert.equal(phases!.glue_other, 1500, "remainder of dispatch_glue");
  assert.equal(
    phases!.loop_reentry! + phases!.context_assemble! + phases!.glue_other!,
    phases!.dispatch_glue,
    "sub-phases sum exactly to dispatch_glue",
  );
  assert.equal(phases!.model_dispatch, 8000);
  assert.equal(phases!.stream_open, 3000);
  assert.equal(phases!.residual, 0, "residual unaffected by the sub-phase labels");
});

test("decomposeGapPhases: loop_reentry subtracts tagged tool work before prepareNextTurn", () => {
  const work: GapWork[] = [{ phase: "exec", start: 1000, end: 3000 }];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 11000 }, work, 10000, {
    onPayload: 6000,
    prepareNextTurn: 3500,
    transformContext: 4000,
  });
  assert.equal(phases!.dispatch_glue, 3000);
  assert.equal(phases!.loop_reentry, 500, "excludes the exec wall before prepareNextTurn");
  assert.equal(phases!.context_assemble, 2000);
  assert.equal(phases!.glue_other, 500);
  assert.equal(phases!.loop_reentry! + phases!.context_assemble! + phases!.glue_other!, 3000);
});

test("decomposeGapPhases: missing hook stamps → all dispatch_glue falls into glue_other", () => {
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 11000 }, [], 10000, { onPayload: 4000 });
  assert.equal(phases!.dispatch_glue, 3000);
  assert.equal(phases!.loop_reentry, undefined, "no loop_reentry without prepareNextTurn");
  assert.equal(phases!.context_assemble, undefined, "no context_assemble without transformContext");
  assert.equal(phases!.glue_other, 3000, "entire dispatch_glue is the remainder");
});

test("decomposeGapPhases: only context_assemble present (transformContext mark, no prepareNextTurn)", () => {
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 11000 }, [], 10000, {
    onPayload: 5000,
    transformContext: 3500,
  });
  assert.equal(phases!.dispatch_glue, 4000);
  assert.equal(phases!.loop_reentry, undefined);
  assert.equal(phases!.context_assemble, 1500, "onPayload − transformContext");
  assert.equal(phases!.glue_other, 2500, "the rest");
  assert.equal(phases!.context_assemble! + phases!.glue_other!, 4000);
});

test("decomposeGapPhases: first step (no gapStart) yields no dispatch_glue sub-phases even with hook stamps", () => {
  assert.equal(
    decomposeGapPhases({ gapEnd: 2000 }, [], 1000, { onPayload: 1500, prepareNextTurn: 1100, transformContext: 1300 }),
    undefined,
  );
});

test("decomposeGapPhases: hook stamps outside [gapStart, onPayload] are ignored (no negative, clamped to glue)", () => {
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 11000 }, [], 10000, {
    onPayload: 4000,
    prepareNextTurn: 500,
    transformContext: 5000,
  });
  assert.equal(phases!.dispatch_glue, 3000);
  assert.equal(phases!.loop_reentry, undefined);
  assert.equal(phases!.context_assemble, undefined);
  assert.equal(phases!.glue_other, 3000);
});

test("decomposeGapPhases: tool_body splits loop_reentry into pre_tool/in_tool_untagged/post_tool", () => {
  const work: GapWork[] = [
    { phase: "tool_body", start: 1500, end: 7000 },
    { phase: "exec", start: 2000, end: 2135 },
    { phase: "model_dispatch", start: 10000, end: 18000 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 21000 }, work, 20000, {
    onPayload: 10000,
    onResponse: 18000,
    messageStart: 21000,
    prepareNextTurn: 8000,
    transformContext: 9000,
  });
  assert.equal(phases!.loop_reentry, 6865, "gapStart → prepareNextTurn minus tagged exec");
  assert.equal(phases!.pre_tool, 500, "gapStart → first tool ENTRY");
  assert.equal(phases!.in_tool_untagged, 5365, "tool_body union − tagged exec inside it");
  assert.equal(phases!.post_tool, 1000, "last tool EXIT → prepareNextTurn");
  assert.equal(
    phases!.pre_tool! + phases!.in_tool_untagged! + phases!.post_tool!,
    phases!.loop_reentry,
    "sub-phases sum exactly to loop_reentry",
  );
  assert.equal((phases as Record<string, number>).tool_body, undefined, "tool_body not emitted as a phase");
  assert.equal(phases!.residual, 0, "residual unaffected by the loop_reentry sub-labels");
});

test("decomposeGapPhases: the live ls turn — in_tool_untagged dominates loop_reentry", () => {
  const work: GapWork[] = [
    { phase: "tool_body", start: 1000, end: 6121 },
    { phase: "exec", start: 5900, end: 6035 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 20000 }, work, 19000, {
    onPayload: 15000,
    prepareNextTurn: 6126,
  });
  assert.equal(phases!.pre_tool, undefined, "tool entry == gapStart → no pre_tool");
  assert.equal(phases!.in_tool_untagged, 4986, "5121 body − 135 exec");
  assert.equal(phases!.post_tool, 5);
  assert.equal(phases!.in_tool_untagged! + phases!.post_tool!, phases!.loop_reentry);
});

test("decomposeGapPhases: post-provision warm-up phases are subtracted from in_tool_untagged", () => {
  const work: GapWork[] = [
    { phase: "tool_body", start: 1000, end: 8000 },
    { phase: "proc_reconcile", start: 1100, end: 3100 },
    { phase: "auth_probe", start: 4100, end: 5100 },
    { phase: "skills_materialize", start: 5100, end: 7100 },
    { phase: "exec", start: 7100, end: 7200 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 20000 }, work, 19000, {
    onPayload: 15000,
    prepareNextTurn: 8000,
  });
  assert.equal(phases!.in_tool_untagged, 1900, "body 7000 − tagged warm-up+exec 5100");
  assert.equal(phases!.proc_reconcile, 2000);
  assert.equal(phases!.skills_materialize, 2000);
});

test("decomposeGapPhases: parallel tool bodies are unioned, not summed", () => {
  const work: GapWork[] = [
    { phase: "tool_body", start: 1000, end: 3000 },
    { phase: "tool_body", start: 2000, end: 4000 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 21000 }, work, 20000, {
    onPayload: 10000,
    prepareNextTurn: 4000,
  });
  assert.equal(phases!.in_tool_untagged, 3000, "overlap counted once");
  assert.equal(phases!.pre_tool, undefined);
  assert.equal(phases!.post_tool, undefined);
  assert.equal(phases!.in_tool_untagged, phases!.loop_reentry);
});

test("decomposeGapPhases: no tool_body span → loop_reentry stays unsplit (no sub-phases)", () => {
  const work: GapWork[] = [{ phase: "exec", start: 1000, end: 1200 }];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 11000 }, work, 10000, {
    onPayload: 6000,
    prepareNextTurn: 3500,
  });
  assert.ok(phases!.loop_reentry! > 0, "loop_reentry present");
  assert.equal(phases!.pre_tool, undefined);
  assert.equal(phases!.in_tool_untagged, undefined);
  assert.equal(phases!.post_tool, undefined);
});

test("decomposeGapPhases: first step (no gapStart) yields no loop_reentry sub-phases even with tool_body", () => {
  const work: GapWork[] = [{ phase: "tool_body", start: 1100, end: 1900 }];
  assert.equal(decomposeGapPhases({ gapEnd: 2000 }, work, 1000, { onPayload: 1950, prepareNextTurn: 1950 }), undefined);
});

test("decomposeGapPhases: never negative — onPayload before gapStart or backwards marks floor at 0", () => {
  const phases = decomposeGapPhases({ gapStart: 2000, gapEnd: 3000 }, [], 1000, {
    onPayload: 1500,
    onResponse: 2900,
    messageStart: 2800,
  });
  assert.equal(phases!.dispatch_glue, undefined, "onPayload ≤ gapStart → no glue (no negative)");
  assert.equal(phases!.stream_open, undefined, "message_start < onResponse → no stream_open (no negative)");
  assert.equal(phases!.residual, 1000);
});

test("decomposeGapPhases: named tool_body spans surface flat tool_body.<name> keys when untagged time exists", () => {
  const work: GapWork[] = [
    { phase: "tool_body", tool: "browse", start: 1500, end: 6000 },
    { phase: "tool_body", tool: "execute", start: 6200, end: 7000 },
    { phase: "exec", start: 2000, end: 2135 },
    { phase: "model_dispatch", start: 10000, end: 18000 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 21000 }, work, 20000, {
    onPayload: 10000,
    onResponse: 18000,
    messageStart: 21000,
    prepareNextTurn: 8000,
    transformContext: 9000,
  });
  assert.ok(phases!.in_tool_untagged! > 0);
  assert.equal(phases!["tool_body.browse"], 4500);
  assert.equal(phases!["tool_body.execute"], 800);
});

test("decomposeGapPhases: per-tool keys are absent when the body is fully tagged", () => {
  const work: GapWork[] = [
    { phase: "tool_body", tool: "execute", start: 1500, end: 7000 },
    { phase: "exec", start: 1500, end: 7000 },
    { phase: "model_dispatch", start: 10000, end: 18000 },
  ];
  const phases = decomposeGapPhases({ gapStart: 1000, gapEnd: 21000 }, work, 20000, {
    onPayload: 10000,
    onResponse: 18000,
    messageStart: 21000,
    prepareNextTurn: 8000,
    transformContext: 9000,
  });
  assert.equal(phases!.in_tool_untagged, undefined);
  assert.equal(phases!["tool_body.execute"], undefined);
});

test("decomposeGapPhases: persist is a lookup — reported but never attributed, partitions unchanged", () => {
  const base: GapWork[] = [
    { phase: "exec", start: 2000, end: 5000 },
    { phase: "model_dispatch", start: 10000, end: 18000 },
  ];
  const withPersist: GapWork[] = [...base, { phase: "persist", start: 4000, end: 6000 }];
  const marks = {
    onPayload: 10000,
    onResponse: 18000,
    messageStart: 21000,
    prepareNextTurn: 8000,
    transformContext: 9000,
  };
  const without = decomposeGapPhases({ gapStart: 1000, gapEnd: 21000 }, base, 20000, marks)!;
  const withP = decomposeGapPhases({ gapStart: 1000, gapEnd: 21000 }, withPersist, 20000, marks)!;
  assert.equal(withP.persist, 2000);
  const { persist: _persist, ...rest } = withP;
  assert.deepEqual(rest, without, "persist must not change any other phase or the residual");
});
