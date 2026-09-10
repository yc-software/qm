import type { Loop, ScopeId } from "../../types.ts";
import type { LoopStore } from "../loop-store.ts";
import { FACTORY_LOOP_SURFACE, isFactoryLoop } from "./effects.ts";

const FACTORY_LOOP_NAME = "Software factory";

const FACTORY_LOOP_PURPOSE = "Tickets from the configured Linear team, worked to a verified pull request.";

const FACTORY_LOOP_PLAYBOOK =
  "Take each ticket the configured Linear team has ready, work it in the factory sandbox against the configured repository, verify it with the configured test and lint commands, and open a pull request for review.";

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
    playbook: FACTORY_LOOP_PLAYBOOK,
    successCondition: FACTORY_SUCCESS_CONDITION,
    shipActions: [
      { action: "open_pr", gate: "auto" },
      { action: "close_already_fixed", gate: "auto" },
    ],
  });
  return loop;
}
