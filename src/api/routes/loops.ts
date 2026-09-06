import type { Loop, LoopState } from "../../types.ts";
import { scopeId, type ScopeId } from "../../types.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import type { LoopStore, CreateLoopInput, LoopPatch } from "../../loops/loop-store.ts";
import { DECISION_LEASE_MS, type LoopItemLedger } from "../../loops/item-ledger.ts";
import type { LoopOutputStore } from "../../loops/output-store.ts";
import type { ShipGrantStore } from "../../loops/ship-grant-store.ts";
import type { LoopFireService } from "../../loops/loop-fire.ts";
import { collectVitals } from "../../loops/governor.ts";
import { buildShipGrant } from "../../loops/ship-gate.ts";
import type { CronStore } from "../../cron/cron-store.ts";
import { DEFAULT_CRON_TIMEZONE, userScheduleFromBody, validateUserSchedule } from "../../cron/schedule.ts";
import type { ScopedConfigStore } from "../../resolution/config-store.ts";
import { consentRequiredRecipient } from "../../triggers/trigger-store.ts";
import { errMessage, swallow } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { isObj, resolveCapabilityDestination } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

export interface LoopServiceDeps {
  store: LoopStore;
  items: LoopItemLedger;
  outputs: LoopOutputStore;
  grants: ShipGrantStore;
  fire?: LoopFireService;
  crons?: CronStore;
  config: ScopedConfigStore;
}

export function loopDeps(ctx: ApiCtx): LoopServiceDeps | null {
  return ctx.deps.loops ?? null;
}

interface ActingPrincipal {
  actorId: string;
  scopeId?: ScopeId;
  capability?: CapabilityClaims;
  liveHuman: boolean;
}

export function actingPrincipal(ctx: ApiCtx): ActingPrincipal | null {
  if (ctx.capability) {
    return {
      actorId: ctx.capability.actorId,
      scopeId: ctx.capability.scopeId as ScopeId,
      capability: ctx.capability,
      liveHuman: ctx.actor?.p !== undefined || ctx.capability.liveActor === true,
    };
  }
  if (ctx.actor?.p) return { actorId: ctx.actor.p, liveHuman: true };
  const principalId = (ctx.url.searchParams.get("principalId") ?? "").trim();
  if (principalId) return { actorId: principalId, liveHuman: false };
  sendJson(ctx.res, 403, { error: "forbidden", message: "loops need an agent capability or a principalId" });
  return null;
}

function requireLiveHuman(ctx: ApiCtx, acting: ActingPrincipal): boolean {
  if (acting.liveHuman) return true;
  sendJson(ctx.res, 403, { error: "human_required", message: "this action requires a live human actor" });
  return false;
}

async function canAdministerLoop(ctx: ApiCtx, loop: Loop, acting: ActingPrincipal): Promise<boolean> {
  const { app } = ctx;
  if (await app.membershipControlsScope(loop.ownerScopeId)) {
    return app.managesScope(acting.actorId, loop.ownerScopeId);
  }
  const team = loop.runAs === "scopeFloor" || loop.runAs === "scopeShared";
  if (!team && (await app.samePerson(loop.owner, acting.actorId))) return true;
  if (team && acting.scopeId !== undefined && loop.ownerScopeId === acting.scopeId) return true;
  return app.managesScope(acting.actorId, loop.ownerScopeId);
}

export async function loadAdministrable(
  ctx: ApiCtx,
): Promise<{ deps: LoopServiceDeps; loop: Loop; acting: ActingPrincipal } | null> {
  const deps = loopDeps(ctx);
  if (!deps) {
    sendJson(ctx.res, 404, { error: "not_found", message: "loops are not wired on this deployment" });
    return null;
  }
  const acting = actingPrincipal(ctx);
  if (!acting) return null;
  const loop = await deps.store.get(ctx.params.id ?? "");
  if (!loop) {
    sendJson(ctx.res, 404, { error: "not_found", message: "no such loop" });
    return null;
  }
  if (!(await canAdministerLoop(ctx, loop, acting))) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "you may not administer this loop" });
    return null;
  }
  return { deps, loop, acting };
}

const GATES = new Set(["auto", "hold"]);

function shipActionsFromBody(value: unknown): Loop["shipActions"] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: Loop["shipActions"] = [];
  for (const entry of value) {
    if (!isObj(entry) || typeof entry.action !== "string" || !entry.action.trim()) return null;
    const gate = entry.gate ?? "hold";
    if (typeof gate !== "string" || !GATES.has(gate)) return null;
    out.push({ action: entry.action.trim(), gate: gate as "auto" | "hold" });
  }
  return out;
}

type NumericBody<T> = { value?: T; invalidField?: string };

function governorFromBody(value: unknown): NumericBody<Loop["governor"]> {
  if (value === undefined) return {};
  if (!isObj(value)) return { invalidField: "governor" };
  const counts = ["maxConsecutiveFailedFires", "returnRateMinDecisions", "maxQueueDepth"] as const;
  const governor: NonNullable<Loop["governor"]> = {};
  for (const key of counts) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1)
      return { invalidField: key };
    governor[key] = raw;
  }
  for (const key of ["maxQueueAgeMs", "staleFireMs"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1)
      return { invalidField: key };
    governor[key] = raw;
  }
  const maxReturnRate = value.maxReturnRate;
  if (maxReturnRate !== undefined) {
    if (typeof maxReturnRate !== "number" || !Number.isFinite(maxReturnRate) || maxReturnRate <= 0 || maxReturnRate > 1)
      return { invalidField: "maxReturnRate" };
    governor.maxReturnRate = maxReturnRate;
  }
  return { value: governor };
}

function capsFromBody(value: unknown): NumericBody<Loop["caps"]> {
  if (value === undefined) return {};
  if (!isObj(value)) return { invalidField: "caps" };
  const numbers = ["maxItemsPerFire", "maxOpenOutputs", "maxItemAttempts"] as const;
  const caps: NonNullable<Loop["caps"]> = {};
  for (const key of numbers) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1)
      return { invalidField: key };
    caps[key] = raw;
  }
  return { value: caps };
}

async function createLoop(ctx: ApiCtx): Promise<void> {
  const deps = loopDeps(ctx);
  if (!deps) return sendJson(ctx.res, 404, { error: "not_found", message: "loops are not wired on this deployment" });
  const acting = actingPrincipal(ctx);
  if (!acting) return;
  const b = isObj(ctx.body) ? ctx.body : {};
  if (typeof b.name !== "string" || !b.name.trim())
    return sendJson(ctx.res, 400, { error: "bad_request", message: "name required" });
  if (typeof b.playbook !== "string" || !b.playbook.trim())
    return sendJson(ctx.res, 400, { error: "bad_request", message: "playbook required" });
  if (typeof b.successCondition !== "string" || !b.successCondition.trim())
    return sendJson(ctx.res, 400, { error: "bad_request", message: "successCondition required" });
  const shipActions = shipActionsFromBody(b.shipActions);
  if (shipActions === null)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: 'shipActions must be [{action, gate: "auto"|"hold"}]',
    });
  if (shipActions.some((policy) => policy.gate === "auto") && !requireLiveHuman(ctx, acting)) return;
  const capsResult = capsFromBody(b.caps);
  if (capsResult.invalidField)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `${capsResult.invalidField} must be a finite positive integer`,
    });
  const caps = capsResult.value;
  const governorResult = governorFromBody(b.governor);
  if (governorResult.invalidField)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `${governorResult.invalidField} has an invalid operational value`,
    });
  const governor = governorResult.value;
  let schedule;
  if (b.schedule !== undefined) {
    const defaultTimezone =
      typeof ctx.capability?.timezone === "string" && ctx.capability.timezone.trim()
        ? ctx.capability.timezone
        : DEFAULT_CRON_TIMEZONE;
    schedule = userScheduleFromBody(b.schedule, defaultTimezone);
    if (!schedule)
      return sendJson(ctx.res, 400, { error: "bad_request", message: "schedule must be a valid schedule object" });
    try {
      validateUserSchedule(schedule);
    } catch (e) {
      return sendJson(ctx.res, 400, { error: "bad_request", message: errMessage(e) });
    }
  }
  let destination;
  let recipientConsent;
  if (b.destinationKey !== undefined) {
    if (typeof b.destinationKey !== "string")
      return sendJson(ctx.res, 400, { error: "bad_request", message: "destinationKey must be a string" });
    if (!ctx.capability)
      return sendJson(ctx.res, 400, { error: "bad_request", message: "destinationKey requires an agent capability" });
    const resolved = resolveCapabilityDestination(ctx.capability, b.destinationKey);
    if (!resolved.ok || !resolved.destination)
      return sendJson(ctx.res, 400, { error: "bad_request", message: "destinationKey is not available" });
    if (!requireLiveHuman(ctx, acting)) return;
    destination = resolved.destination;
    const recipientId = consentRequiredRecipient({ owner: acting.actorId, standing: true, destination });
    if (recipientId) recipientConsent = { recipientId, status: "pending" as const };
  }
  const runAs = b.runAs === "owner" || b.runAs === "scopeFloor" || b.runAs === "scopeShared" ? b.runAs : undefined;
  if ((runAs === "scopeFloor" || runAs === "scopeShared") && acting.scopeId === undefined)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "team loops must be created through an agent capability",
    });
  const ownerScopeId: ScopeId =
    runAs === "scopeFloor" || runAs === "scopeShared" ? acting.scopeId! : scopeId("personal", acting.actorId);
  const input: CreateLoopInput = {
    owner: acting.actorId,
    createdBy: acting.actorId,
    ownerScopeId,
    name: b.name,
    playbook: b.playbook,
    successCondition: b.successCondition,
    shipActions,
    ...(typeof b.purpose === "string" && b.purpose.trim() ? { purpose: b.purpose.trim() } : {}),
    ...(Array.isArray(b.successChecks)
      ? { successChecks: b.successChecks.filter((c): c is string => typeof c === "string" && c.trim() !== "") }
      : {}),
    ...(caps && Object.keys(caps).length > 0 ? { caps } : {}),
    ...(governor && Object.keys(governor).length > 0 ? { governor } : {}),
    ...(runAs ? { runAs } : {}),
    ...(schedule ? { schedule } : {}),
    ...(destination ? { destination } : {}),
    ...(recipientConsent ? { recipientConsent } : {}),
  };
  let loop: Loop;
  let created: boolean;
  try {
    ({ loop, created } = await deps.store.create(input));
  } catch (e) {
    return sendJson(ctx.res, 400, { error: "loop_create_failed", message: errMessage(e) });
  }
  if (created && schedule && deps.crons) {
    let cronId: string | undefined;
    try {
      const cron = await deps.crons.create({
        owner: loop.owner,
        createdBy: loop.createdBy,
        ownerScopeId: loop.ownerScopeId,
        schedule,
        title: `Loop: ${loop.name}`,
        action: `fire loop ${loop.id}`,
        loopId: loop.id,
        ...(loop.runAs ? { runAs: loop.runAs } : {}),
        ownerConsentedAt: Date.now(),
      });
      cronId = cron.id;
      loop = (await deps.store.update(loop.id, { cronId: cron.id })) ?? loop;
    } catch (e) {
      if (cronId) await deps.crons.delete(cronId).catch((error: unknown) => swallow("loop cron rollback", error));
      await deps.store.delete(loop.id);
      return sendJson(ctx.res, 400, { error: "loop_schedule_failed", message: errMessage(e) });
    }
  }
  return sendJson(ctx.res, 200, { loop, created });
}

async function listLoops(ctx: ApiCtx): Promise<void> {
  const deps = loopDeps(ctx);
  if (!deps) return sendJson(ctx.res, 404, { error: "not_found", message: "loops are not wired on this deployment" });
  const acting = actingPrincipal(ctx);
  if (!acting) return;
  const all = await deps.store.list();
  const visible: Loop[] = [];
  for (const loop of all) {
    if (await canAdministerLoop(ctx, loop, acting)) visible.push(loop);
  }
  return sendJson(ctx.res, 200, { loops: visible });
}

async function getLoop(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop } = loaded;
  const [items, outputs, grants, vitals] = await Promise.all([
    deps.items.byLoop(loop.id),
    deps.outputs.byLoop(loop.id),
    deps.grants.byLoop(loop.id),
    collectVitals(loop, { items: deps.items, outputs: deps.outputs }, Date.now()),
  ]);
  return sendJson(ctx.res, 200, { loop, items, outputs, grants, vitals });
}

const STATES = new Set<LoopState>(["enabled", "paused", "quarantined", "archived"]);

async function patchLoop(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop, acting } = loaded;
  const b = isObj(ctx.body) ? ctx.body : {};
  const patch: LoopPatch = {};
  if (typeof b.playbook === "string" && b.playbook.trim()) {
    patch.playbookEdit = {
      playbook: b.playbook,
      by: acting.actorId,
      ...(typeof b.note === "string" && b.note.trim() ? { note: b.note.trim() } : {}),
    };
  } else if (b.playbook !== undefined) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "playbook must be a non-empty string" });
  }
  if (typeof b.state === "string") {
    if (!STATES.has(b.state as LoopState))
      return sendJson(ctx.res, 400, {
        error: "bad_request",
        message: "state must be enabled|paused|quarantined|archived",
      });
    patch.state = b.state as LoopState;
    if (patch.state === "enabled" && (loop.state === "quarantined" || loop.state === "archived")) {
      if (!requireLiveHuman(ctx, acting)) return;
      if (loop.state === "quarantined") {
        patch.quarantineClearedBy = acting.actorId;
        patch.quarantineClearedAt = Date.now();
      }
    }
  } else if (b.state !== undefined) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "state must be a string" });
  }
  Object.assign(patch, {
    ...(typeof b.name === "string" && b.name.trim() ? { name: b.name } : {}),
    ...(typeof b.purpose === "string" ? { purpose: b.purpose } : {}),
    ...(typeof b.successCondition === "string" && b.successCondition.trim()
      ? { successCondition: b.successCondition }
      : {}),
    ...(Array.isArray(b.successChecks)
      ? { successChecks: b.successChecks.filter((c): c is string => typeof c === "string") }
      : {}),
  });
  const governorResult = governorFromBody(b.governor);
  if (governorResult.invalidField)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `${governorResult.invalidField} has an invalid operational value`,
    });
  const governorPatch = governorResult.value;
  if (governorPatch !== undefined) patch.governor = governorPatch;
  const shipActions = b.shipActions === undefined ? [] : shipActionsFromBody(b.shipActions);
  if (shipActions === null)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: 'shipActions must be [{action, gate: "auto"|"hold"}]',
    });
  const existingGates = new Map(loop.shipActions.map((policy) => [policy.action, policy.gate]));
  if (
    shipActions.some((policy) => policy.gate === "auto" && existingGates.get(policy.action) !== "auto") &&
    !requireLiveHuman(ctx, acting)
  )
    return;
  if (b.shipActions !== undefined) patch.shipActions = shipActions;
  const capsResult = capsFromBody(b.caps);
  if (capsResult.invalidField)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `${capsResult.invalidField} must be a finite positive integer`,
    });
  const caps = capsResult.value;
  if (caps !== undefined) patch.caps = caps;
  if (b.destinationKey !== undefined) {
    if (b.destinationKey !== null && typeof b.destinationKey !== "string")
      return sendJson(ctx.res, 400, { error: "bad_request", message: "destinationKey must be a string or null" });
    if (!ctx.capability)
      return sendJson(ctx.res, 400, { error: "bad_request", message: "destinationKey requires an agent capability" });
    if (!requireLiveHuman(ctx, acting)) return;
    if (b.destinationKey === null) {
      patch.destination = null;
      patch.recipientConsent = null;
    } else {
      const resolved = resolveCapabilityDestination(ctx.capability, b.destinationKey);
      if (!resolved.ok || !resolved.destination)
        return sendJson(ctx.res, 400, { error: "bad_request", message: "destinationKey is not available" });
      patch.destination = resolved.destination;
      const recipientId = consentRequiredRecipient({
        owner: loop.owner,
        standing: true,
        destination: resolved.destination,
      });
      patch.recipientConsent = recipientId ? { recipientId, status: "pending" } : null;
    }
  }
  const updated = Object.keys(patch).length > 0 ? await deps.store.update(loop.id, patch) : loop;
  if (!updated) return sendJson(ctx.res, 404, { error: "not_found", message: "no such loop" });
  if (patch.state !== undefined && loop.cronId && deps.crons) {
    try {
      await deps.crons.setEnabled(loop.cronId, patch.state === "enabled");
    } catch (e) {
      await deps.store.update(loop.id, { restore: loop });
      return sendJson(ctx.res, 502, { error: "loop_schedule_failed", message: errMessage(e) });
    }
  }
  return sendJson(ctx.res, 200, { loop: updated ?? (await deps.store.get(loop.id)) });
}

async function deleteLoop(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop } = loaded;
  if (loop.cronId && deps.crons)
    await deps.crons.delete(loop.cronId).catch((e: unknown) => swallow("loop cron delete", e));
  await deps.grants.deleteByLoop(loop.id);
  await deps.items.deleteByLoop(loop.id);
  await deps.outputs.deleteByLoop(loop.id);
  await deps.store.delete(loop.id);
  return sendJson(ctx.res, 200, { ok: true });
}

async function fireLoopNow(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop } = loaded;
  if (!deps.fire) return sendJson(ctx.res, 404, { error: "not_found", message: "loop firing is not wired" });
  const fireKey = `loop:${loop.id}:manual:${Date.now()}`;
  void deps.fire.fire(loop.id, fireKey).catch((e: unknown) => swallow(`manual fire of loop ${loop.id}`, e));
  return sendJson(ctx.res, 200, { ok: true, fireKey });
}

async function decideOutput(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop, acting } = loaded;
  if (!requireLiveHuman(ctx, acting)) return;
  if (!deps.fire) return sendJson(ctx.res, 404, { error: "not_found", message: "loop firing is not wired" });
  const b = isObj(ctx.body) ? ctx.body : {};
  const outputId = ctx.params.outputId ?? "";
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : undefined;
  const decisionMissing = async () => {
    const output = await deps.outputs.get(outputId);
    const item = output ? await deps.items.get(output.itemId) : null;
    if (item?.decisionToken && (item.decisionAt ?? 0) + DECISION_LEASE_MS > Date.now())
      return sendJson(ctx.res, 409, { error: "decision_in_progress" });
    return sendJson(ctx.res, 404, { error: "not_found", message: "no such ready output" });
  };
  if (b.decision === "ship" || b.decision === "shipped") {
    try {
      const shipped = await deps.fire.shipOutput(loop.id, outputId, acting.actorId, note);
      if (!shipped) return decisionMissing();
      return sendJson(ctx.res, 200, { output: shipped });
    } catch (e) {
      return sendJson(ctx.res, 502, { error: "ship_failed", message: errMessage(e) });
    }
  }
  if (b.decision === "return" || b.decision === "returned") {
    if (!note)
      return sendJson(ctx.res, 400, { error: "bad_request", message: "a return needs a note for the next attempt" });
    const returned = await deps.fire.returnOutput(loop.id, outputId, acting.actorId, note);
    if (!returned) return decisionMissing();
    return sendJson(ctx.res, 200, { output: returned });
  }
  return sendJson(ctx.res, 400, { error: "bad_request", message: 'decision must be "shipped" or "returned"' });
}

async function graduateShipAction(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop, acting } = loaded;
  if (!requireLiveHuman(ctx, acting)) return;
  const b = isObj(ctx.body) ? ctx.body : {};
  if (typeof b.shipAction !== "string" || !b.shipAction.trim())
    return sendJson(ctx.res, 400, { error: "bad_request", message: "shipAction required" });
  if (!loop.shipActions.some((policy) => policy.action === b.shipAction))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "shipAction is not declared by this loop" });
  try {
    const modes = await deps.config.getApprovalGrantModesDurable(loop.ownerScopeId);
    const grant = await deps.grants.put(
      buildShipGrant({
        loopId: loop.id,
        shipAction: b.shipAction.trim(),
        actorId: acting.actorId,
        policyVersion: loop.policyVersion ?? 1,
        modes,
        ...(typeof b.label === "string" && b.label.trim() ? { label: b.label.trim() } : {}),
      }),
    );
    return sendJson(ctx.res, 200, { grant });
  } catch (e) {
    return sendJson(ctx.res, 403, { error: "grant_refused", message: errMessage(e) });
  }
}

async function setAutopilot(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop, acting } = loaded;
  const b = isObj(ctx.body) ? ctx.body : {};
  if (typeof b.enabled !== "boolean")
    return sendJson(ctx.res, 400, { error: "bad_request", message: "enabled must be a boolean" });
  if (b.enabled) {
    if (!requireLiveHuman(ctx, acting)) return;
    if (loop.state === "quarantined" || loop.state === "archived")
      return sendJson(ctx.res, 409, {
        error: "conflict",
        message: `cannot enable autopilot while loop is ${loop.state}`,
      });
    try {
      const modes = await deps.config.getApprovalGrantModesDurable(loop.ownerScopeId);
      const gatesChange = loop.shipActions.some((policy) => policy.gate !== "auto");
      const policyVersion = (loop.policyVersion ?? 1) + (gatesChange ? 1 : 0);
      const desiredGrants = loop.shipActions.map((policy) =>
        buildShipGrant({
          loopId: loop.id,
          shipAction: policy.action,
          actorId: acting.actorId,
          policyVersion,
          modes,
        }),
      );

      const existing = await deps.grants.byLoop(loop.id);
      for (const grant of desiredGrants) {
        if (!existing.some((candidate) => candidate.id === grant.id && candidate.revokedAt === undefined))
          await deps.grants.put(grant);
      }
      const updated = !gatesChange
        ? loop
        : ((await deps.store.update(loop.id, {
            shipActions: loop.shipActions.map((policy) => ({ ...policy, gate: "auto" })),
          })) ?? loop);
      return sendJson(ctx.res, 200, { loop: updated, grants: await deps.grants.byLoop(loop.id) });
    } catch (e) {
      return sendJson(ctx.res, 403, { error: "grant_refused", message: errMessage(e) });
    }
  }
  const updated = loop.shipActions.every((policy) => policy.gate === "hold")
    ? loop
    : ((await deps.store.update(loop.id, {
        shipActions: loop.shipActions.map((policy) => ({ ...policy, gate: "hold" })),
      })) ?? loop);
  const grants = await deps.grants.byLoop(loop.id);
  for (const grant of grants) {
    if (grant.revokedAt === undefined) await deps.grants.revoke(grant.id, acting.actorId);
  }
  return sendJson(ctx.res, 200, { loop: updated, grants: await deps.grants.byLoop(loop.id) });
}

async function revokeShipGrant(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop, acting } = loaded;
  if (!requireLiveHuman(ctx, acting)) return;
  const grantId = ctx.params.grantId ?? "";
  const grant = await deps.grants.get(grantId);
  if (!grant || grant.loopId !== loop.id)
    return sendJson(ctx.res, 404, { error: "not_found", message: "no such ship grant" });
  const revoked = await deps.grants.revoke(grantId, acting.actorId);
  return sendJson(ctx.res, 200, { grant: revoked });
}

export const loopRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/loops", auth: "either", handle: createLoop },
  { method: "GET", path: "/v1/loops", auth: "either", handle: listLoops },
  { method: "GET", path: "/v1/loops/:id", auth: "either", handle: getLoop },
  { method: "PATCH", path: "/v1/loops/:id", auth: "either", handle: patchLoop },
  { method: "DELETE", path: "/v1/loops/:id", auth: "either", handle: deleteLoop },
  { method: "POST", path: "/v1/loops/:id/fire", auth: "either", handle: fireLoopNow },
  { method: "POST", path: "/v1/loops/:id/outputs/:outputId/decide", auth: "either", handle: decideOutput },
  { method: "POST", path: "/v1/loops/:id/grants", auth: "either", handle: graduateShipAction },
  { method: "POST", path: "/v1/loops/:id/autopilot", auth: "either", handle: setAutopilot },
  { method: "DELETE", path: "/v1/loops/:id/grants/:grantId", auth: "either", handle: revokeShipGrant },
];
