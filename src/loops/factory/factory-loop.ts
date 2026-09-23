import type { Loop, ScopeId } from "../../types.ts";
import type { CronStore } from "../../cron/cron-store.ts";
import type { LoopStore } from "../loop-store.ts";
import { FACTORY_LOOP_SURFACE, isFactoryLoop } from "./effects.ts";

const FACTORY_LOOP_NAME = "Software factory";

const FACTORY_LOOP_FIRE_EVERY_MS = 5 * 60 * 1000;

const FACTORY_LOOP_PURPOSE = "Tickets from the configured Linear team, worked to a verified pull request.";

export const FACTORY_DEFAULT_PLAYBOOK = `These rules apply to every agent the factory runs, in every stage of every ticket.

FACTORY TEST SCOPE — minimal killing set. A test exists to catch ONE plausible bug: one edit a
maintainer could really make to the changed code. Every test must name the one bug it catches,
in its title, or in its first comment line when the title cannot carry it. A test is EXCESS when
another test in the same file already catches its named bug, or when the named bug is not an
edit a maintainer would make. There is no cap on test count and no cap on test length. The
default shape is one test per acceptance criterion in the ticket. Security, authorization,
money, sends, and destructive actions still require their distinct allowed, denied, or safe
outcomes.

Keep every solution as simple as possible.`;

const FACTORY_SUCCESS_CONDITION =
  "Every ticket the factory picked up ends in a pull request that passes the configured verification, or is closed as already fixed.";

export async function findFactoryLoop(store: LoopStore, orgScopeId: ScopeId): Promise<Loop | null> {
  const loops = await store.list();
  return loops.find((loop) => loop.ownerScopeId === orgScopeId && isFactoryLoop(loop)) ?? null;
}

export async function ensureFactoryLoop(
  store: LoopStore,
  input: { owner: string; orgScopeId: ScopeId },
): Promise<Loop> {
  const existing = await findFactoryLoop(store, input.orgScopeId);
  if (existing) return existing;
  const { loop } = await store.create({
    owner: input.owner,
    createdBy: input.owner,
    ownerScopeId: input.orgScopeId,
    name: FACTORY_LOOP_NAME,
    surface: FACTORY_LOOP_SURFACE,
    purpose: FACTORY_LOOP_PURPOSE,
    playbook: FACTORY_DEFAULT_PLAYBOOK,
    successCondition: FACTORY_SUCCESS_CONDITION,
    shipActions: [
      { action: "open_pr", gate: "auto" },
      { action: "close_already_fixed", gate: "auto" },
    ],
  });
  return loop;
}

export async function ensureFactoryLoopCron(
  deps: { store: LoopStore; crons?: CronStore },
  loop: Loop,
): Promise<Loop> {
  if (!deps.crons || loop.cronId) return loop;
  const cron = await deps.crons.create({
    owner: loop.owner,
    createdBy: loop.createdBy,
    ownerScopeId: loop.ownerScopeId,
    schedule: { everyMs: FACTORY_LOOP_FIRE_EVERY_MS },
    title: `Loop: ${FACTORY_LOOP_NAME}`,
    action: `fire loop ${loop.id}`,
    loopId: loop.id,
    ownerConsentedAt: Date.now(),
  });
  return (await deps.store.update(loop.id, { cronId: cron.id })) ?? loop;
}
