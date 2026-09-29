import { randomUUID } from "node:crypto";
import { createCronStore } from "../../src/cron/cron-store.ts";
import { createScheduler, cronFireReadsNotes } from "../../src/cron/scheduler.ts";
import type { DirectoryMember } from "../../src/directory/directory-store.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import type { Cron } from "../../src/types.ts";
import {
  nativeShapeReply,
  nativeTaskText,
  nativeTurn,
  validateNativeShapes,
  type NativeShape,
} from "./workload-native.ts";
import { workloadCheck } from "./workload-provider.ts";

export interface CronPlan {
  definition: Cron;
  directoryMembers: DirectoryMember[];
  occurrences: Array<{ id: string; shape: string }>;
}

export async function renderCronPlanTask(plan: CronPlan): Promise<string> {
  const cron = plan.definition;
  const backing = createMemoryMap<Cron>();
  await backing.put(cron.id, { ...structuredClone(cron), enabled: true, archived: false });
  let task: string | undefined;
  const scheduler = createScheduler({
    crons: createCronStore(backing),
    deliveries: {
      enqueue: async () => {
        throw new Error("Cron template cannot deliver");
      },
    } as never,
    idempotency: createIdempotencyStore(),
    identity: { refresh: async () => {}, classify: () => ({ type: "internal" }) } as never,
    currentScopeMembers: async () => [{ id: cron.owner, type: "internal" }, ...(cron.members ?? [])],
    isOpenScopeMember: async () => true,
    directory: {
      list: async () => plan.directoryMembers,
      get: async (id) => plan.directoryMembers.find((member) => member.principalId === id) ?? null,
      channelMember: async () => false,
      groupMember: async () => false,
    },
    run: async (request) => {
      workloadCheck(task === undefined, "One native cron template required");
      task = request.text;
      return { status: "silent" };
    },
  });
  try {
    const fired = await scheduler.runNow(cron.id);
    workloadCheck(fired.started, "Native cron template did not start");
    await fired.settled;
    workloadCheck(
      typeof task === "string" && task.startsWith("[Cron runtime context]\n"),
      "Native cron task wrapper required",
    );
    return task;
  } finally {
    await scheduler.stop();
  }
}

export async function createCronResponder(plans: CronPlan[], shapes: NativeShape[], fixtureId: string) {
  workloadCheck(Array.isArray(plans) && plans.length > 0 && plans.length <= 128, "Bounded cron plans required");
  validateNativeShapes(shapes);
  const instanceId = randomUUID();
  const ids = new Set<string>();
  const tasks = new Map<string, number>();
  const states = [] as Array<{ occurrence: number; step: number; active: boolean; origin?: string }>;
  let failed = false;
  for (const [index, plan] of plans.entries()) {
    const cron = plan.definition;
    const fixtureMatch = /^perf-cron-(0|[1-9]\d*)$/.exec(cron.id);
    workloadCheck(
      (/^(?:[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(cron.id) ||
        (fixtureMatch !== null && fixtureMatch[0] === cron.id && Number(fixtureMatch[1]) <= 1_000_000)) &&
        !ids.has(cron.id),
      "Unique native cron ID required",
    );
    ids.add(cron.id);
    workloadCheck(cron.message === undefined && cronFireReadsNotes(cron), "Ordinary recurring cron task required");
    const markers = [...cron.action!.matchAll(/\[qm-perf-cron:([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)\]/g)];
    workloadCheck(
      markers.length === 1 && markers[0]![1] === fixtureId && markers[0]![2] === cron.id,
      "One fixed fixture and definition task marker required",
    );
    workloadCheck(
      Array.isArray(plan.directoryMembers) &&
        plan.directoryMembers.length <= 100_000 &&
        new Set(plan.directoryMembers.map((member) => member.principalId)).size === plan.directoryMembers.length,
      "Bounded explicit directory snapshot required",
    );
    workloadCheck(plan.occurrences.length > 0 && plan.occurrences.length <= 1000, "Finite cron occurrences required");
    const occurrences = new Set<string>();
    for (const occurrence of plan.occurrences) {
      workloadCheck(
        /^[A-Za-z0-9_.-]+$/.test(occurrence.id) && !occurrences.has(occurrence.id),
        "Unique cron occurrence ID required",
      );
      occurrences.add(occurrence.id);
      workloadCheck(
        shapes.some((shape) => shape.name === occurrence.shape && shape.terminal === "reply" && !shape.recovery),
        "Declared native cron shape required",
      );
    }
    const task = await renderCronPlanTask(plan);
    workloadCheck(Buffer.byteLength(task) <= 1_000_000 && !tasks.has(task), "Unambiguous bounded cron task required");
    tasks.set(task, index);
    states.push({ occurrence: 0, step: 0, active: false });
  }
  return {
    begin(body: Record<string, unknown>) {
      try {
        const turn = nativeTurn(body);
        if (!turn) return null;
        if (!turn.origin.startsWith("[Cron runtime context]") && !turn.origin.includes("[qm-perf-cron:")) return null;
        workloadCheck(!failed, "Cron plan poisoned by an unsuccessful request");
        const index = tasks.get(nativeTaskText(turn.origin));
        workloadCheck(index !== undefined, "Unknown or changed native cron task");
        const plan = plans[index]!;
        const state = states[index]!;
        const occurrence = plan.occurrences[state.occurrence];
        workloadCheck(occurrence && !state.active, "Exhausted or concurrent native cron occurrence");
        workloadCheck(turn.pairs.length === state.step, "Duplicate or skipped native cron continuation");
        workloadCheck(
          state.origin === undefined || state.origin === turn.origin,
          "Native cron origin changed within turn",
        );
        const shape = shapes.find((candidate) => candidate.name === occurrence.shape)!;
        const nonce = `${instanceId}.${index}.${state.occurrence}`;
        const reply = nativeShapeReply(body, turn, shape, nonce, undefined, { fixtureId, shapes });
        state.active = true;
        state.origin = turn.origin;
        const cron = {
          cronId: plan.definition.id,
          occurrenceId: occurrence.id,
          occurrenceIndex: state.occurrence,
          provisional: true,
        };
        let finished = false;
        return {
          reply: { ...reply, cron },
          finish(success: boolean) {
            if (finished) return;
            finished = true;
            state.active = false;
            if (!success) {
              failed = true;
              return;
            }
            state.step++;
            if (reply.native.terminal) {
              state.step = 0;
              state.origin = undefined;
              state.occurrence++;
            }
          },
        };
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    snapshot: () => ({
      instanceId,
      failed,
      provisional: true,
      complete: !failed && states.every((state, index) => state.occurrence === plans[index]!.occurrences.length),
      states: states.map((state, index) => ({ ...state, origin: undefined, cronId: plans[index]!.definition.id })),
    }),
  };
}
