import { orgId as configOrgId } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";

export interface Environment {
  id: string;
  orgId: string;
  name: string | null;
  ownerActorId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentAttachment {
  scopeId: ScopeId;
  environmentId: string;
  attachedBy: string;
  attachedAt: number;
}

interface CreateEnvironmentInput {
  id: string;
  name?: string | null;
  ownerActorId?: string | null;
}

export interface EnvironmentStore {
  create(input: CreateEnvironmentInput): Promise<Environment>;
  get(id: string): Promise<Environment | null>;
  list(): Promise<Environment[]>;
  attach(scopeId: ScopeId, environmentId: string, attachedBy: string): Promise<void>;
  getAttachment(scopeId: ScopeId): Promise<EnvironmentAttachment | null>;
  attachmentsFor(environmentId: string): Promise<EnvironmentAttachment[]>;
}

export async function resolveEnvironmentId(store: EnvironmentStore | undefined, scopeId: ScopeId): Promise<string> {
  if (!store) return scopeId;
  const attachment = await store.getAttachment(scopeId);
  return attachment ? attachment.environmentId : scopeId;
}

function rowToEnvironment(r: Record<string, unknown>): Environment {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    name: (r.name as string | null) ?? null,
    ownerActorId: (r.owner_actor_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToAttachment(r: Record<string, unknown>): EnvironmentAttachment {
  return {
    scopeId: r.scope_id as ScopeId,
    environmentId: r.environment_id as string,
    attachedBy: r.attached_by as string,
    attachedAt: Number(r.attached_at),
  };
}

export function createMemoryEnvironmentStore(opts: { now?: () => number } = {}): EnvironmentStore {
  const now = opts.now ?? (() => Date.now());
  const environments = new Map<string, Environment>();
  const attachments = new Map<ScopeId, EnvironmentAttachment>();
  return {
    async create(input): Promise<Environment> {
      const existing = environments.get(input.id);
      if (existing) return existing;
      const env: Environment = {
        id: input.id,
        orgId: configOrgId(),
        name: input.name ?? null,
        ownerActorId: input.ownerActorId ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      environments.set(env.id, env);
      return env;
    },
    async get(id): Promise<Environment | null> {
      return environments.get(id) ?? null;
    },
    async list(): Promise<Environment[]> {
      return [...environments.values()]
        .filter((e) => e.orgId === configOrgId())
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async attach(scopeId, environmentId, attachedBy): Promise<void> {
      attachments.set(scopeId, { scopeId, environmentId, attachedBy, attachedAt: now() });
    },
    async getAttachment(scopeId): Promise<EnvironmentAttachment | null> {
      return attachments.get(scopeId) ?? null;
    },
    async attachmentsFor(environmentId): Promise<EnvironmentAttachment[]> {
      return [...attachments.values()].filter((a) => a.environmentId === environmentId);
    },
  };
}

export function createPostgresEnvironmentStore(
  connectionString: string,
  opts: { now?: () => number } = {},
): EnvironmentStore {
  const now = opts.now ?? (() => Date.now());
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS environments(
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT, owner_actor_id TEXT,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
      )`,
    `CREATE TABLE IF NOT EXISTS environment_attachments(
        scope_id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL REFERENCES environments(id),
        attached_by TEXT NOT NULL, attached_at BIGINT NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS environment_attachments_by_env
        ON environment_attachments(environment_id)`,
  ]);
  return {
    async create(input): Promise<Environment> {
      const ts = now();
      await q(
        `INSERT INTO environments(id, org_id, name, owner_actor_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (id) DO NOTHING`,
        [input.id, configOrgId(), input.name ?? null, input.ownerActorId ?? null, ts],
      );
      const rows = await q("SELECT * FROM environments WHERE id = $1", [input.id]);
      return rowToEnvironment(rows[0]!);
    },
    async get(id): Promise<Environment | null> {
      const rows = await q("SELECT * FROM environments WHERE id = $1", [id]);
      return rows[0] ? rowToEnvironment(rows[0]) : null;
    },
    async list(): Promise<Environment[]> {
      const rows = await q("SELECT * FROM environments WHERE org_id = $1 ORDER BY updated_at DESC", [configOrgId()]);
      return rows.map(rowToEnvironment);
    },
    async attach(scopeId, environmentId, attachedBy): Promise<void> {
      await q(
        `INSERT INTO environment_attachments(scope_id, environment_id, attached_by, attached_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (scope_id) DO UPDATE SET environment_id = EXCLUDED.environment_id,
           attached_by = EXCLUDED.attached_by, attached_at = EXCLUDED.attached_at`,
        [scopeId, environmentId, attachedBy, now()],
      );
    },
    async getAttachment(scopeId): Promise<EnvironmentAttachment | null> {
      const rows = await q("SELECT * FROM environment_attachments WHERE scope_id = $1", [scopeId]);
      return rows[0] ? rowToAttachment(rows[0]) : null;
    },
    async attachmentsFor(environmentId): Promise<EnvironmentAttachment[]> {
      const rows = await q("SELECT * FROM environment_attachments WHERE environment_id = $1", [environmentId]);
      return rows.map(rowToAttachment);
    },
  };
}
