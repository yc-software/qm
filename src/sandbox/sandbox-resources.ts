import { tenantSandboxChoice } from "./tenant-sandbox-shape.ts";
import { perTenant } from "../tenants/cache.ts";
import { withLiveTurnMembership } from "../resolution/scope-membership.ts";
import { personOrOwningBot } from "../auth/capability-token.ts";
import { samePerson } from "../directory/person.ts";
import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import {
  parseScopeId,
  personalScope,
  type CommandPolicy,
  type EgressPolicy,
  type Principal,
  type Resolution,
  type ScopeId,
} from "../types.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { IsCurrentSharedScopeMember } from "../resolution/scope-membership.ts";
import { intersectEgressPolicies } from "../resolution/egress-policy.ts";
import { isOpenScopeMember } from "../resolution/sharing-access.ts";
import { NoDefaultSandboxError, type SandboxBackendName } from "./sandbox-routing.ts";
import type { Sandbox, AgentComputerSpec, ProvisionOptions, ComputerStatus, EgressEnforcement } from "./sandbox.ts";
import { JOB_COMPUTER_SCOPE_PREFIX } from "./home-snapshot.ts";
import { claimThenBind } from "../tenants/claim.ts";
import type { LoadSample } from "./load-probe.ts";
import type { SwarmService } from "../swarms/swarm-service.ts";
import { msOf } from "../sessions/items.ts";

export interface SandboxResource {
  id: string;
  backend: SandboxBackendName;
  ownerScopeId: ScopeId;
  backingScopeId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  legacy: boolean;
  state: "unverified" | "provisioning" | "ready" | "failed" | "retired";
  availableActions?: string[];
  cleanupPending?: boolean;
  holders?: string[];
  spec?: AgentComputerSpec;
  error?: string;
  jobOnly?: boolean;
  memoryGb?: number;
  swarmId?: string;
  personUsed?: true;
}

export interface SandboxAccessPlan {
  readonly resource: SandboxResource;
  readonly crossScope: boolean;
  readonly egress: EgressPolicy;
  readonly commandPolicy: CommandPolicy | null;
  readonly credentialScopeId?: ScopeId;
}

export interface SandboxDefault {
  sandboxId: string | null;
}

export const CLEAR_BOT_SET_DEFAULTS_MIGRATION = {
  id: "sessions/store/0063-clear-bot-set-defaults",
  statements: [
    `DO $$
    BEGIN
      IF to_regclass('items') IS NULL OR to_regclass('runs') IS NULL OR to_regclass('sessions') IS NULL
         OR to_regclass('audit_log') IS NULL OR to_regclass('sandbox_defaults') IS NULL
         OR to_regclass('sandbox_resources') IS NULL OR to_regclass('environment_attachments') IS NULL THEN
        RETURN;
      END IF;
      WITH tool_sets AS MATERIALIZED (
        SELECT c.tenant_id, c.session_id, ${msOf("res.created_at")} AS at, c.body ->> 'sandbox_id' AS sandbox_id,
               r.id AS run_id, r.session_id AS thread_ref,
               CASE WHEN pg_input_is_valid(r.request, 'jsonb') THEN r.request::jsonb ->> 'botActor' = 'true' END AS bot
          FROM items c
          JOIN items res ON res.tenant_id = c.tenant_id AND res.session_id = c.session_id AND res.kind = 'ToolResult'
                        AND md5(res.call_id) = md5(c.call_id) AND res.call_id = c.call_id
          LEFT JOIN runs r ON r.tenant_id = c.tenant_id AND r.id = c.turn_id::text
         WHERE c.kind = 'ToolCall' AND c.tool = 'sandbox' AND c.body ->> 'action' = 'set_default'
           AND res.is_error IS NOT TRUE
      ), events AS (
        SELECT t.tenant_id, COALESCE(sr.json ->> 'ownerScopeId', ea.environment_id, s.scope_id) AS scope, t.at,
               t.sandbox_id, t.bot, t.run_id, t.thread_ref
          FROM tool_sets t
          JOIN sessions s ON s.tenant_id = t.tenant_id AND s.id = t.session_id
          LEFT JOIN sandbox_resources sr ON sr.tenant_id = t.tenant_id AND sr.id = t.sandbox_id
          LEFT JOIN environment_attachments ea ON ea.tenant_id = t.tenant_id AND ea.scope_id = s.scope_id
                                               AND ea.attached_at <= t.at
        UNION ALL
        SELECT tenant_id, scope_label, at, NULLIF(resource, 'null'), false, NULL, NULL
          FROM audit_log WHERE action = 'sandbox.default'
      ), latest AS (
        SELECT DISTINCT ON (d.tenant_id, d.id) d.tenant_id, d.id, d.json ->> 'sandboxId' AS sandbox_id,
               e.sandbox_id AS set_id, e.bot, e.run_id, e.thread_ref
          FROM sandbox_defaults d JOIN events e ON e.tenant_id = d.tenant_id AND e.scope = d.id
         ORDER BY d.tenant_id, d.id, e.at DESC, e.bot IS TRUE
      ), cleared AS (
        UPDATE sandbox_defaults d SET json = '{"sandboxId": null}'::jsonb
          FROM latest l WHERE l.bot AND l.set_id = l.sandbox_id AND d.tenant_id = l.tenant_id AND d.id = l.id
           AND d.json ->> 'sandboxId' = l.set_id
        RETURNING l.tenant_id, l.id, l.sandbox_id, l.run_id, l.thread_ref
      ), versions AS (
        UPDATE durable_map_versions SET v = v + 1
         WHERE tbl = 'sandbox_defaults' AND tenant_id IN (SELECT tenant_id FROM cleared)
      )
      INSERT INTO audit_log (tenant_id, at, principal_id, action, resource, scope_label, detail)
      SELECT tenant_id, ${msOf("now()")}, 'system:migration', 'sandbox.default', 'null', id,
             jsonb_build_object('runId', run_id, 'threadRef', thread_ref, 'previousSandboxId', sandbox_id,
                                'botActor', true)::text
        FROM cleared;
    END $$`,
  ],
};

interface SandboxProviderProfile {
  name: SandboxBackendName;
  spec?: AgentComputerSpec;
  egressEnforcement?: EgressEnforcement;
  sizesMemory?: boolean;
  actions: string[];
}

export interface SandboxResources {
  profiles(): SandboxProviderProfile[];
  forTurn(turn: { actorId: string; scopeId: ScopeId; isCurrent: () => Promise<boolean> }): SandboxResources;
  initialize(): Promise<void>;
  list(
    actorId: string,
    scopeId: ScopeId,
  ): Promise<{
    sandboxes: SandboxResource[];
    defaultSandboxId: string | null;
    defaultMode: "none" | "selected";
    providers: SandboxProviderProfile[];
  }>;
  create(
    actorId: string,
    scopeId: ScopeId,
    backend: string,
    name?: string,
    reservationId?: string,
    jobOnly?: boolean,
    memoryGb?: number,
    swarmId?: string,
    personUsed?: boolean,
  ): Promise<SandboxResource>;
  eachJobComputer(work: (computer: SandboxResource) => Promise<void>): Promise<void>;
  retireJobComputer(id: string, seenState: SandboxResource["state"]): Promise<void>;
  access(actorId: string, id: string): Promise<SandboxResource>;
  status(actorId: string, id: string): Promise<ComputerStatus>;
  restart(actorId: string, id: string, memoryGb?: number): Promise<void>;
  retire(actorId: string, id: string): Promise<void>;
  notePersonUse(id: string): Promise<SandboxResource>;
  use<T>(id: string, action: () => Promise<T>, exclusive?: boolean): Promise<T>;
  hold(id: string, runId: string): Promise<void>;
  recordLoad(id: string, sample: LoadSample): Promise<void>;
  load(id: string): Promise<LoadSample | null>;
  release(id: string, runId: string | undefined, isLive: (runId: string) => Promise<boolean>): Promise<boolean>;
  setDefault(actorId: string, scopeId: ScopeId, id: string | null): Promise<void>;
  resolve(scopeId: ScopeId): Promise<SandboxResource | null>;
  get(id: string): Promise<SandboxResource>;
  defaultBackend(): Promise<SandboxBackendName>;
}

export class SandboxAccessError extends Error {}

export class BotComputerRefusedError extends SandboxAccessError {
  constructor() {
    super("a Slack bot's turn can use only a computer it made that no person has used");
  }
}

const JOB_ONLY_REFUSAL =
  "this computer belongs to a background job that uses private credentials; only that job's own controls can reach it";

export async function preferredBackend(resources: SandboxResources, scopeId: ScopeId): Promise<SandboxBackendName> {
  return (await resources.resolve(scopeId))?.backend ?? (await resources.defaultBackend());
}

export function botMayUseComputers(
  swarms: Pick<SwarmService, "botMayUseComputer"> | undefined,
  turn: { actorId: string; threadRef: string; sessionId: string },
): (computer: SandboxResource) => Promise<boolean> {
  return async (computer) =>
    computer.swarmId
      ? !!swarms && (await swarms.botMayUseComputer(computer, turn))
      : personOrOwningBot(
          { actorId: turn.actorId, botActor: true },
          async () => !computer.personUsed && samePerson(computer.createdBy, turn.actorId),
        );
}

export async function accessConversationSandbox(
  resources: SandboxResources | undefined,
  actorId: string,
  id: string,
  canUseScope: (scope: ScopeId) => boolean | Promise<boolean>,
  botMayUse?: (resource: SandboxResource) => Promise<boolean>,
): Promise<SandboxResource> {
  if (!id.trim()) throw new SandboxAccessError("sandbox_id must be a non-empty sandbox ID");
  const resource = await resources?.access(actorId, id);
  if (!resource || resource.state === "retired" || !(await canUseScope(resource.ownerScopeId)))
    throw new SandboxAccessError("sandbox access is no longer authorized in this conversation");
  if (botMayUse && !(await botMayUse(resource))) throw new BotComputerRefusedError();
  return resource;
}

export async function assertBotMayUseComputer(
  resources: SandboxResources | undefined,
  scopeId: ScopeId,
  sandboxId: string | undefined,
  botMayUse: ((resource: SandboxResource) => Promise<boolean>) | undefined,
): Promise<void> {
  if (!botMayUse) return;
  if (!sandboxId) {
    await defaultComputer(resources, scopeId, botMayUse);
    return;
  }
  const resource = await resources?.get(sandboxId);
  if (resource && !(await botMayUse(resource))) throw new BotComputerRefusedError();
}

export async function defaultComputer(
  resources: SandboxResources | undefined,
  scopeId: ScopeId,
  botMayUse: ((resource: SandboxResource) => Promise<boolean>) | undefined,
): Promise<SandboxResource | undefined> {
  if (!resources) return;
  const resource = await resources.resolve(scopeId);
  if (!resource) throw new NoDefaultSandboxError();
  if (botMayUse && !(await botMayUse(resource))) throw new BotComputerRefusedError();
  return resource;
}

export function createSandboxResources(opts: {
  upgrade?: () => Promise<void>;
  records: DurableMap<SandboxResource>;
  loads: DurableMap<LoadSample>;
  defaults: DurableMap<SandboxDefault>;
  backends: Partial<Record<SandboxBackendName, Sandbox>>;
  defaultBackend: SandboxBackendName;
  provisionOptions?: (scopeId: string) => Promise<ProvisionOptions>;
  beforeDefaultChange?: (scopeId: string) => Promise<void>;
  beforeRetire?: (record: SandboxResource) => Promise<void>;
  lock: AdvisoryLock;
  canUseScope(actorId: string, scopeId: ScopeId): Promise<boolean>;
}): SandboxResources {
  const upgraded = perTenant<{ done?: Promise<void> }>(() => ({}));
  const initialize = async (): Promise<void> => {
    if (!opts.upgrade) return;
    const state = upgraded();
    state.done ??= opts.upgrade().catch((error: unknown) => {
      state.done = undefined;
      throw error;
    });
    await state.done;
  };
  const actionsFor = (backend: Sandbox | undefined): string[] => {
    if (!backend) return [];
    return [
      "create",
      ...(backend.computerStatus ? ["status"] : []),
      ...(backend.restartComputer ? ["restart"] : []),
      ...(backend.destroyScope ? ["retire"] : []),
    ];
  };
  const authorize = async (actorId: string, scopeId: ScopeId): Promise<void> => {
    if (!parseScopeId(scopeId).kind || !(await opts.canUseScope(actorId, scopeId)))
      throw new SandboxAccessError("sandbox access requires permission to use its owning scope");
  };
  const get = async (id: string): Promise<SandboxResource> => {
    await initialize();
    const record = await opts.records.get(id);
    if (!record) throw new SandboxAccessError(`sandbox not found: ${id}`);
    return record;
  };
  const agentRecord = async (actorId: string, id: string): Promise<SandboxResource> => {
    const record = await get(id);
    if (record.jobOnly) throw new SandboxAccessError(JOB_ONLY_REFUSAL);
    await authorize(actorId, record.ownerScopeId);
    return record;
  };
  const destroy = async (current: SandboxResource): Promise<void> => {
    const backend = opts.backends[current.backend];
    if (!backend?.destroyScope) throw new Error(`sandbox retirement unavailable: ${current.backend}`);
    const retiring = { ...current, state: "retired" as const, cleanupPending: true };
    await opts.records.put(current.id, retiring);
    try {
      await backend.destroyScope(current.backingScopeId);
      await opts.records.put(current.id, { ...retiring, cleanupPending: false, error: undefined });
    } catch (error) {
      await opts.records.put(current.id, { ...retiring, error: String(error) });
      throw error;
    }
  };
  const use = async <T>(id: string, action: () => Promise<T>, exclusive = false): Promise<T> => {
    const guarded = async (): Promise<T> => {
      const current = await get(id);
      if (current.state === "retired") throw new Error("sandbox has been retired");
      return action();
    };
    return exclusive ? opts.lock.withLock(`sandbox-resource:${id}`, guarded) : guarded();
  };
  const profiles = (): SandboxProviderProfile[] =>
    (Object.entries(opts.backends) as Array<[SandboxBackendName, Sandbox]>)
      .filter(([, backend]) => !!backend)
      .map(([name, backend]) => ({
        name,
        ...(backend.profile.spec ? { spec: backend.profile.spec } : {}),
        ...(backend.profile.egressEnforcement ? { egressEnforcement: backend.profile.egressEnforcement } : {}),
        ...(backend.profile.sizesMemory ? { sizesMemory: true } : {}),
        actions: actionsFor(backend),
      }));
  const checkMemory = (backend: Sandbox, memoryGb: number | undefined): void => {
    if (memoryGb === undefined) return;
    if (!backend.profile.sizesMemory) throw new Error(`${backend.profile.backend} computers take no memory size`);
  };
  return {
    profiles,
    forTurn: (turn) =>
      createSandboxResources({
        ...opts,
        canUseScope: async (actorId, scopeId) =>
          withLiveTurnMembership(opts.canUseScope, { ...turn, verified: await turn.isCurrent() })(actorId, scopeId),
      }),
    async defaultBackend() {
      const { backend } = await tenantSandboxChoice({ backend: opts.defaultBackend, scopeBackends: {} });
      if (!opts.backends[backend])
        throw new Error(`sandbox backend unavailable: ${backend}; this deployment does not run it`);
      return backend;
    },
    initialize,
    get,
    use,
    recordLoad: (id, sample) => opts.loads.put(id, sample),
    load: (id) => opts.loads.get(id),
    async hold(id, runId) {
      await opts.records.update(id, (current) =>
        current.holders?.includes(runId) ? current : { ...current, holders: [...(current.holders ?? []), runId] },
      );
    },
    async release(id, runId, isLive) {
      const record = runId
        ? await opts.records.update(id, (current) => ({
            ...current,
            holders: (current.holders ?? []).filter((holder) => holder !== runId),
          }))
        : await opts.records.get(id);
      const others = record?.holders ?? [];
      const live = await Promise.all(others.map(isLive));
      const ended = others.filter((_, index) => !live[index]);
      if (ended.length)
        await opts.records.update(id, (current) => ({
          ...current,
          holders: (current.holders ?? []).filter((holder) => !ended.includes(holder)),
        }));
      return live.includes(true);
    },
    async retire(actorId, id) {
      await initialize();
      const record = await agentRecord(actorId, id);
      await opts.lock.withLock(`sandbox-resource:${id}`, () =>
        opts.lock.withLock(`sandbox-default:${record.ownerScopeId}`, async () => {
          const current = await get(id);
          if (current.state === "retired" && !current.cleanupPending && !current.error) return;
          const selected = await opts.defaults.get(current.ownerScopeId);
          if (selected?.sandboxId === id)
            throw new Error("unset or change this scope's default before retiring its computer");
          await opts.beforeRetire?.(current);
          await destroy(current);
        }),
      );
    },
    async notePersonUse(id) {
      const record = await get(id);
      if (record.personUsed) return record;
      return (await opts.records.update(id, (current) => ({ ...current, personUsed: true }))) ?? record;
    },
    async eachJobComputer(work) {
      await claimThenBind(opts.records.claimTenants, async () => {
        await initialize();
        for (const record of await opts.records.all()) if (record.jobOnly) await work(record);
      });
    },
    async retireJobComputer(id, seenState) {
      await opts.lock.withLock(`sandbox-resource:${id}`, async () => {
        const current = await get(id);
        if (!current.jobOnly || current.state !== seenState) return;
        await destroy(current);
        await Promise.all([opts.records.delete(id), opts.loads.delete(id)]);
      });
    },
    access: agentRecord,
    async status(actorId, id) {
      const record = await agentRecord(actorId, id);
      const backend = opts.backends[record.backend];
      if (!backend?.computerStatus) throw new Error(`sandbox status unavailable: ${record.backend}`);
      return use(id, () => backend.computerStatus!(record.backingScopeId));
    },
    async restart(actorId, id, memoryGb) {
      await initialize();
      const record = await agentRecord(actorId, id);
      if (record.state === "retired") throw new Error("sandbox has been retired");
      const backend = opts.backends[record.backend];
      if (!backend?.restartComputer) throw new Error(`sandbox restart unavailable: ${record.backend}`);
      checkMemory(backend, memoryGb);
      await use(
        id,
        async () => {
          await backend.restartComputer!(record.backingScopeId, memoryGb ?? record.memoryGb);
          if (memoryGb !== undefined) await opts.records.update(id, (current) => ({ ...current, memoryGb }));
        },
        true,
      );
    },
    async resolve(scopeId) {
      await initialize();
      const route = await opts.defaults.get(scopeId);
      return route?.sandboxId ? get(route.sandboxId) : null;
    },
    async list(actorId, scopeId) {
      await authorize(actorId, scopeId);
      await initialize();
      const route = await opts.defaults.get(scopeId);
      const sandboxes: SandboxResource[] = [];
      for (const record of await opts.records.all()) {
        if (record.jobOnly || !(await opts.canUseScope(actorId, record.ownerScopeId))) continue;
        const backend = opts.backends[record.backend];
        let availableActions = actionsFor(backend).filter((action) => action !== "create");
        if (record.state === "retired")
          availableActions = (record.cleanupPending || record.error) && backend?.destroyScope ? ["retire"] : [];
        sandboxes.push({ ...record, holders: undefined, availableActions });
      }
      return {
        sandboxes,
        defaultSandboxId: route?.sandboxId ?? null,
        defaultMode: route?.sandboxId ? "selected" : "none",
        providers: profiles(),
      };
    },
    async create(actorId, scopeId, backend, name, reservationId, jobOnly, memoryGb, swarmId, personUsed) {
      await initialize();
      await authorize(actorId, scopeId);
      if (!Object.hasOwn(opts.backends, backend) || !opts.backends[backend as SandboxBackendName])
        throw new Error(`sandbox backend unavailable: ${backend}`);
      checkMemory(opts.backends[backend as SandboxBackendName]!, memoryGb);
      if (jobOnly && !opts.backends[backend as SandboxBackendName]?.destroyScope)
        throw new Error(
          `background jobs with private credentials need a computer that ${backend} can retire; run the command in the foreground`,
        );
      const id = reservationId ?? randomUUID();
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("invalid sandbox reservation");
      const record: SandboxResource = {
        id,
        backend: backend as SandboxBackendName,
        ownerScopeId: scopeId,
        backingScopeId: jobOnly ? `${JOB_COMPUTER_SCOPE_PREFIX}${id}` : `sandbox-${id}`,
        name: name?.trim().slice(0, 120) || backend,
        createdBy: actorId,
        createdAt: new Date().toISOString(),
        legacy: false,
        state: "provisioning",
        ...(jobOnly ? { jobOnly } : {}),
        ...(memoryGb ? { memoryGb } : {}),
        ...(swarmId ? { swarmId } : {}),
        ...(personUsed ? { personUsed } : {}),
      };
      return opts.lock.withLock(`sandbox-resource:${id}`, async () => {
        const existing = await opts.records.get(id);
        if (existing) {
          if (existing.ownerScopeId !== scopeId || existing.backend !== backend)
            throw new Error("sandbox reservation ownership mismatch");
          if (existing.state === "ready") return existing;
          if (existing.state === "retired") throw new Error("sandbox reservation is retired");
        }
        if (existing) await opts.records.update(id, (current) => ({ ...current, ...record, error: undefined }));
        else await opts.records.put(id, record);
        const sandbox = opts.backends[record.backend]!;
        try {
          await sandbox.provision(record.backingScopeId, {
            ...(await opts.provisionOptions?.(scopeId)),
            ...(memoryGb ? { memoryGb } : {}),
          });
          return (await opts.records.update(id, (current) => ({
            ...current,
            state: "ready",
            spec: sandbox.profile.spec,
          })))!;
        } catch (error) {
          await opts.records.update(id, (current) => ({
            ...current,
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          }));
          throw error;
        }
      });
    },
    async setDefault(actorId, scopeId, id) {
      await initialize();
      await authorize(actorId, scopeId);
      await opts.lock.withLock(`sandbox-default:${scopeId}`, async () => {
        if (id !== null) {
          const record = await agentRecord(actorId, id);
          if (record.state === "retired") throw new Error("sandbox has been retired");
          if (record.ownerScopeId !== scopeId)
            throw new Error(
              "the default sandbox must belong to this scope; use sandbox_id for another authorized scope",
            );
        }
        await opts.beforeDefaultChange?.(scopeId);
        await opts.defaults.put(scopeId, { sandboxId: id });
      });
    },
  };
}

export function createTurnSandboxAccess(ctx: {
  deps: {
    sandboxResources?: SandboxResources;
    config?: ScopedConfigStore;
    isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
  };
  actor: Principal;
  resolution: Resolution;
  scopeId: ScopeId;
  openResourceAccess?: boolean;
  botMayUse?: (resource: SandboxResource) => Promise<boolean>;
}) {
  const { deps, actor, resolution, scopeId, openResourceAccess, botMayUse } = ctx;
  const writableScopeId = resolution.writableScopeId;
  const canUseSandboxScope = async (target: ScopeId): Promise<boolean> => {
    if (target === writableScopeId || target === scopeId) return true;
    if (!openResourceAccess || actor.type !== "internal" || !deps.config || !deps.isCurrentSharedScopeMember)
      return false;
    const personal = personalScope(actor.id);
    for (const scope of new Set([scopeId, target])) {
      if (scope === personal) {
        if ((await deps.config.resolveSharingPostureDurable(personal, scope)) !== "open") return false;
      } else if (
        !(await isOpenScopeMember({
          actorId: actor.id,
          scope,
          config: deps.config,
          isCurrentSharedScopeMember: deps.isCurrentSharedScopeMember,
        }))
      )
        return false;
    }
    return true;
  };
  const accessResource = async (id: string): Promise<SandboxAccessPlan> => {
    const resource = await accessConversationSandbox(
      deps.sandboxResources,
      actor.id,
      id,
      canUseSandboxScope,
      botMayUse,
    );
    const crossScope = resource.ownerScopeId !== writableScopeId && resource.ownerScopeId !== scopeId;
    if (!crossScope) return { resource, crossScope: false, egress: resolution.egress, commandPolicy: null };
    await deps.config!.refreshSecurity([resource.ownerScopeId]);
    const credentialScopeId = resource.ownerScopeId === personalScope(actor.id) ? resource.ownerScopeId : undefined;
    return {
      resource,
      crossScope: true,
      egress: intersectEgressPolicies(resolution.egress, deps.config!.getEgress(resource.ownerScopeId)),
      commandPolicy: deps.config!.getCommandPolicy(resource.ownerScopeId),
      ...(credentialScopeId ? { credentialScopeId } : {}),
    };
  };
  const jobComputerPlan = async (resource: SandboxResource): Promise<SandboxAccessPlan> => {
    if (botMayUse && !(await botMayUse(resource))) throw new BotComputerRefusedError();
    return { resource, crossScope: false, egress: resolution.egress, commandPolicy: null };
  };
  return { accessResource, jobComputerPlan };
}
