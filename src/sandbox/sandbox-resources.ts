import { canonicalJson } from "../../cli/src/canonical-json.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { artifactProvenance, mergeSourceProvenance, type SourceProvenance } from "../memory/facts.ts";
import { inheritContextSources, privateSourceAllowed, type PrivateContext } from "../sessions/private-context.ts";
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
  personalOnly?: true;
  sourceProvenance?: SourceProvenance;
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
  privateSandboxId?: string | null;
}

export const CLEAR_BOT_SET_DEFAULTS_MIGRATION = {
  id: "sessions/store/0063-clear-bot-set-defaults",
  statements: [
    `DO $$
    BEGIN
      IF to_regclass('items') IS NULL OR to_regclass('runs') IS NULL OR to_regclass('audit_log') IS NULL
         OR to_regclass('sandbox_defaults') IS NULL OR to_regclass('sandbox_resources') IS NULL THEN
        RETURN;
      END IF;
      WITH tool_sets AS MATERIALIZED (
        SELECT c.tenant_id, ${msOf("res.created_at")} AS at, c.body ->> 'sandbox_id' AS sandbox_id,
               r.id AS run_id, r.session_id AS thread_ref,
               CASE WHEN pg_input_is_valid(r.request, 'jsonb') THEN r.request::jsonb ->> 'botActor' = 'true' END AS bot
          FROM items c
          JOIN items res ON res.tenant_id = c.tenant_id AND res.session_id = c.session_id AND res.kind = 'ToolResult'
                        AND md5(res.call_id) = md5(c.call_id) AND res.call_id = c.call_id
          LEFT JOIN runs r ON r.tenant_id = c.tenant_id AND r.id = c.turn_id::text
         WHERE c.kind = 'ToolCall' AND c.tool = 'sandbox' AND c.body ->> 'action' = 'set_default'
           AND res.is_error IS NOT TRUE
      ), events AS (
        SELECT t.tenant_id, sr.json ->> 'ownerScopeId' AS scope, t.at, t.sandbox_id, t.bot, t.run_id, t.thread_ref
          FROM tool_sets t
          JOIN sandbox_resources sr ON sr.tenant_id = t.tenant_id AND sr.id = t.sandbox_id
        UNION ALL
        SELECT tenant_id, scope_label, at, resource, false, NULL, NULL
          FROM audit_log WHERE action = 'sandbox.default' AND resource <> 'null'
      ), latest AS (
        SELECT DISTINCT ON (tenant_id, scope) tenant_id, scope AS id, sandbox_id, bot, run_id, thread_ref
          FROM events
         ORDER BY tenant_id, scope, at DESC, bot IS TRUE
      ), cleared AS (
        UPDATE sandbox_defaults d SET json = '{"sandboxId": null}'::jsonb
          FROM latest l WHERE l.bot AND d.tenant_id = l.tenant_id AND d.id = l.id AND d.json ->> 'sandboxId' = l.sandbox_id
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

export interface SandboxPrivacyContext {
  current(): Promise<PrivateContext>;
  sessions: Pick<SessionStore, "recordContextProvenance">;
}

export interface SandboxResources {
  profiles(): SandboxProviderProfile[];
  forTurn(turn: {
    actorId: string;
    scopeId: ScopeId;
    isCurrent: () => Promise<boolean>;
    privacy?: SandboxPrivacyContext;
  }): SandboxResources;
  initialize(): Promise<void>;
  authorizeScratch(scopeId: ScopeId, personalOnly: boolean): Promise<void>;
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
  getMany(ids: readonly string[]): Promise<SandboxResource[]>;
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
  resources: Pick<SandboxResources, "get" | "resolve"> | undefined,
  scopeId: ScopeId,
  sandboxId: string | undefined,
  botMayUse: ((resource: SandboxResource) => Promise<boolean>) | undefined,
): Promise<SandboxResource | undefined> {
  if (!sandboxId && botMayUse) {
    return defaultComputer(resources, scopeId, botMayUse);
  }
  const resource = sandboxId ? await resources?.get(sandboxId) : await resources?.resolve(scopeId);
  if (resource && botMayUse && !(await botMayUse(resource))) throw new BotComputerRefusedError();
  return resource ?? undefined;
}

export const MARK_ADMIN_CREATED_COMPUTERS_MIGRATION = {
  id: "durable-map/sandbox_resources/0040-mark-admin-created",
  statements: [
    `DO $$
    BEGIN
      IF to_regclass('sandbox_resources') IS NOT NULL AND to_regclass('audit_log') IS NOT NULL THEN
        UPDATE durable_map_versions SET v = v + 1 WHERE tbl = 'sandbox_resources';
        UPDATE sandbox_resources r SET json = r.json || '{"personUsed": true}'::jsonb
        FROM audit_log a
        WHERE a.action = 'sandbox.create' AND a.tenant_id = r.tenant_id AND a.resource = r.id
          AND NOT r.json ? 'personUsed';
      END IF;
    END $$`,
  ],
};

export async function defaultComputer(
  resources: Pick<SandboxResources, "resolve"> | undefined,
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
  privacy?: SandboxPrivacyContext;
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
    const context = await opts.privacy?.current();
    if (context && (context.actorId !== actorId || (context.personalOnly && !privateSourceAllowed(context, scopeId))))
      throw new SandboxAccessError("Private computer access requires its owner's personal conversation.");
    if (!parseScopeId(scopeId).kind || !(await opts.canUseScope(actorId, scopeId)))
      throw new SandboxAccessError("sandbox access requires permission to use its owning scope");
  };
  const checkPrivacy = async (record: SandboxResource, actorId?: string): Promise<SandboxResource> => {
    const context = (await opts.privacy?.current()) ?? (actorId ? { actorId } : undefined);
    if (record.personalOnly) {
      if (!context) return record;
      if (!privateSourceAllowed(context, record.ownerScopeId))
        throw new SandboxAccessError("This computer is private to its owner's personal conversation.");
      if (opts.privacy) await inheritContextSources(opts.privacy.sessions, context, [record]);
    } else if (context?.personalOnly)
      throw new SandboxAccessError(
        "Private work requires a private computer. Select or create a private personal computer.",
      );
    return record;
  };
  const load = async (id: string): Promise<SandboxResource> => {
    await initialize();
    const record = await opts.records.get(id);
    if (!record) throw new SandboxAccessError(`sandbox not found: ${id}`);
    return record;
  };
  const get = async (id: string) => checkPrivacy(await load(id));
  const agentRecord = async (actorId: string, id: string): Promise<SandboxResource> => {
    const record = await checkPrivacy(await load(id), actorId);
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
      const context = await opts.privacy?.current();
      if (current.personalOnly && context?.sourceProvenance && opts.privacy) {
        const merged = mergeSourceProvenance([
          ...(current.sourceProvenance ? [current.sourceProvenance] : []),
          context.sourceProvenance,
        ]);
        if (canonicalJson(merged) !== canonicalJson(current.sourceProvenance)) {
          const updated = await opts.records.update(id, (record) => ({
            ...record,
            sourceProvenance: mergeSourceProvenance([
              ...(record.sourceProvenance ? [record.sourceProvenance] : []),
              merged,
            ]),
          }));
          if (!updated) throw new SandboxAccessError("The private computer no longer exists.");
          await inheritContextSources(opts.privacy.sessions, context, [updated]);
        }
      }
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
        upgrade: initialize,
        privacy: turn.privacy,
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
    async authorizeScratch(scopeId, personalOnly) {
      const context = await opts.privacy?.current();
      if (!context) return;
      await authorize(context.actorId, scopeId);
      if (!!context.personalOnly !== personalOnly || (personalOnly && !privateSourceAllowed(context, scopeId)))
        throw new SandboxAccessError("Disposable computer privacy no longer matches this conversation.");
    },
    get,
    async getMany(ids) {
      await initialize();
      return Promise.all((await opts.records.getMany(ids)).map((record) => checkPrivacy(record)));
    },
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
          if (selected?.sandboxId === id || selected?.privateSandboxId === id)
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
      const context = await opts.privacy?.current();
      if (context) await authorize(context.actorId, scopeId);
      const route = await opts.defaults.get(scopeId);
      const selected = context?.personalOnly ? route?.privateSandboxId : route?.sandboxId;
      return selected ? get(selected) : null;
    },
    async list(actorId, scopeId) {
      await authorize(actorId, scopeId);
      await initialize();
      const route = await opts.defaults.get(scopeId);
      const context = await opts.privacy?.current();
      const selected = context?.personalOnly ? route?.privateSandboxId : route?.sandboxId;
      const sandboxes: SandboxResource[] = [];
      for (const record of await opts.records.all()) {
        if (
          record.jobOnly ||
          (record.personalOnly && !privateSourceAllowed(context ?? { actorId }, record.ownerScopeId)) ||
          (context && !!record.personalOnly !== !!context.personalOnly) ||
          !(await opts.canUseScope(actorId, record.ownerScopeId))
        )
          continue;
        const backend = opts.backends[record.backend];
        let availableActions = actionsFor(backend).filter((action) => action !== "create");
        if (record.state === "retired")
          availableActions = (record.cleanupPending || record.error) && backend?.destroyScope ? ["retire"] : [];
        sandboxes.push({ ...record, holders: undefined, availableActions });
      }
      if (context && opts.privacy)
        await inheritContextSources(
          opts.privacy.sessions,
          context,
          sandboxes.filter((record) => record.personalOnly),
        );
      return {
        sandboxes,
        defaultSandboxId: selected ?? null,
        defaultMode: selected ? "selected" : "none",
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
      const context = await opts.privacy?.current();
      const record: SandboxResource = {
        ...(context?.personalOnly
          ? {
              personalOnly: true as const,
              sourceProvenance: mergeSourceProvenance([artifactProvenance(scopeId, context.sourceProvenance, true)]),
            }
          : {}),
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
          if (
            existing.ownerScopeId !== scopeId ||
            existing.backend !== backend ||
            !!existing.personalOnly !== !!record.personalOnly
          )
            throw new Error("sandbox reservation ownership mismatch");
          if (existing.state === "ready") return existing;
          if (existing.state === "retired") throw new Error("sandbox reservation is retired");
        }
        if (existing)
          await opts.records.update(id, (current) => ({
            ...current,
            ...record,
            createdBy: current.createdBy,
            error: undefined,
          }));
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
        let selectedPrivate = (await opts.privacy?.current())?.personalOnly === true;
        if (id !== null) {
          const record = await agentRecord(actorId, id);
          selectedPrivate ||= record.personalOnly === true;
          if (record.state === "retired") throw new Error("sandbox has been retired");
          if (record.ownerScopeId !== scopeId)
            throw new Error(
              "the default sandbox must belong to this scope; use sandbox_id for another authorized scope",
            );
        }
        await opts.beforeDefaultChange?.(scopeId);
        const current = (await opts.defaults.get(scopeId)) ?? { sandboxId: null };
        await opts.defaults.put(scopeId, {
          ...current,
          ...(selectedPrivate ? { privateSandboxId: id } : { sandboxId: id }),
        });
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
  privateContext?: () => Promise<PrivateContext>;
  botMayUse?: (resource: SandboxResource) => Promise<boolean>;
}) {
  const { deps, actor, resolution, scopeId, openResourceAccess, botMayUse } = ctx;
  const writableScopeId = resolution.writableScopeId;
  const canUseSandboxScope = async (target: ScopeId): Promise<boolean> => {
    const context = await ctx.privateContext?.();
    if (context?.personalOnly && !privateSourceAllowed(context, target)) return false;
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
