import { randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { currentTenant } from "../tenants/context.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { scopeId, type ScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import { createKeyedQueue } from "../util/async.ts";

const PROJECT_GROUP_PREFIX = "web-project-";

interface ProjectSlackChannel {
  channelId: string;
  channelName: string;
  linkedBy: string;
  linkedAt: number;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  channelMemberIds?: string[];
  slackChannel?: ProjectSlackChannel;
  createdAt: number;
  updatedAt: number;
}

type ProjectMutation =
  | { status: "ok"; project: Project; changed: boolean }
  | { status: "not_found" | "forbidden" | "invalid_member" | "invalid_name" };

type ProjectMutationEffect = (result: Extract<ProjectMutation, { status: "ok" }>) => Promise<void>;

export interface ProjectStore {
  create(input: { name: string; ownerId: string }): Promise<Project>;
  get(id: string): Promise<Project | null>;
  listForMember(principalId: string): Promise<Project[]>;
  addMember(id: string, actorId: string, memberId: string, effect?: ProjectMutationEffect): Promise<ProjectMutation>;
  removeMember(id: string, actorId: string, memberId: string, effect?: ProjectMutationEffect): Promise<ProjectMutation>;
  rename(id: string, ownerId: string, name: string, effect?: ProjectMutationEffect): Promise<ProjectMutation>;
  setSlackChannel(
    id: string,
    actorId: string,
    link: { channelId: string; channelName: string } | null,
    effect?: ProjectMutationEffect,
  ): Promise<ProjectMutation>;
  syncChannelMembers(
    id: string,
    memberIds: readonly string[],
    channelName?: string,
    effect?: ProjectMutationEffect,
  ): Promise<ProjectMutation>;
  listLinked(): Promise<Project[]>;
  slackChannel(groupRef: string): Promise<ProjectSlackChannel | undefined>;
  recognizes(groupRef: string): boolean;
  membership(groupRef: string, principalId: string): Promise<boolean | undefined>;
  members(groupRef: string): Promise<string[] | undefined>;
  version(groupRef: string): Promise<string | undefined>;
  withVersion<T>(groupRef: string, version: string | undefined, fn: () => Promise<T>): Promise<T | undefined>;
  name(groupRef: string): Promise<string | undefined>;
  withRosterLock<T>(id: string, fn: (project: Project) => Promise<T>): Promise<T | null>;
  close?(): Promise<void>;
}

interface ProjectRows {
  get(id: string): Promise<Project | null>;
  insert(project: Project): Promise<Project>;
  save(project: Project): Promise<void>;
  forMember(orgId: string, principalId: string): Promise<Project[]>;
  linked(orgId: string): Promise<Project[]>;
  close?(): Promise<void>;
}

interface ProjectStoreOptions {
  now?: () => number;
  id?: () => string;
  isActiveMember?: (principalId: string) => boolean;
  advisoryLock: AdvisoryLock;
}

export function projectGroupRef(id: string): string {
  return `${PROJECT_GROUP_PREFIX}${id}`;
}

export function projectScopeId(id: string): ScopeId {
  return scopeId("group", projectGroupRef(id));
}

export function projectIdFromGroupRef(ref: string): string | null {
  if (!isProjectGroupRef(ref)) return null;
  const id = ref.slice(PROJECT_GROUP_PREFIX.length);
  return id && !id.includes(":") ? id : null;
}

export function isProjectGroupRef(ref: string): boolean {
  return ref.startsWith(PROJECT_GROUP_PREFIX);
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 200);
}

function visible(project: Project): Project {
  return {
    ...project,
    memberIds: [...project.memberIds],
    ...(project.channelMemberIds ? { channelMemberIds: [...project.channelMemberIds] } : {}),
    ...(project.slackChannel ? { slackChannel: { ...project.slackChannel } } : {}),
  };
}

function projectStore(backing: ProjectRows, opts: ProjectStoreOptions): ProjectStore {
  const now = opts.now ?? Date.now;
  const nextId = opts.id ?? randomUUID;
  const isActiveMember = opts.isActiveMember ?? (() => true);
  const advisoryLock = opts.advisoryLock;
  const queue = createKeyedQueue<string>();
  const withLock = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
    queue(id, () => advisoryLock.withLock(`project:${id}`, fn));

  async function update(id: string, fn: (project: Project) => Project): Promise<Project | null> {
    const project = await backing.get(id);
    if (!project) return null;
    const next = fn(project);
    if (next !== project) await backing.save(next);
    return next;
  }

  async function projectForGroup(groupRef: string): Promise<Project | undefined> {
    const id = projectIdFromGroupRef(groupRef);
    if (!id) return undefined;
    const project = await backing.get(id);
    return project?.orgId === configOrgId() ? project : undefined;
  }

  function effectiveMemberIds(project: Project): string[] {
    return [...new Set([...project.memberIds, ...(project.channelMemberIds ?? [])])];
  }

  async function mutate(
    id: string,
    actorId: string,
    memberId: string,
    add: boolean,
    effect?: ProjectMutationEffect,
  ): Promise<ProjectMutation> {
    return withLock(id, async () => {
      if (!memberId) return { status: "invalid_member" };
      const outcome: { status: ProjectMutation["status"] } = { status: "not_found" };
      let changed = false;
      const updated = await update(id, (project) => {
        const canChangeRoster = add
          ? project.memberIds.some((member) => samePerson(member, actorId))
          : samePerson(project.ownerId, actorId);
        if (!canChangeRoster || !isActiveMember(project.ownerId) || !isActiveMember(actorId)) {
          outcome.status = "forbidden";
          return project;
        }
        if (samePerson(memberId, project.ownerId)) {
          outcome.status = "invalid_member";
          return project;
        }
        outcome.status = "ok";
        const memberIds = add
          ? [...new Set([...project.memberIds, memberId])]
          : project.memberIds.filter((member) => member !== memberId);
        if (
          memberIds.length === project.memberIds.length &&
          memberIds.every((member, i) => member === project.memberIds[i])
        )
          return project;
        changed = true;
        return { ...project, memberIds, updatedAt: Math.max(now(), project.updatedAt + 1) };
      });
      if (!updated) return { status: "not_found" };
      if (outcome.status !== "ok") return { status: outcome.status };
      const result = { status: "ok" as const, project: visible(updated), changed };
      await effect?.(result);
      return result;
    });
  }

  return {
    async create(input) {
      const name = cleanName(input.name);
      if (!name || !input.ownerId) throw new Error("project requires name and ownerId");
      const at = now();
      const project: Project = {
        id: nextId(),
        orgId: configOrgId(),
        name,
        ownerId: input.ownerId,
        memberIds: [input.ownerId],
        createdAt: at,
        updatedAt: at,
      };
      const stored = await backing.insert(project);
      if (stored.createdAt !== project.createdAt || stored.ownerId !== project.ownerId)
        throw new Error("project id collision");
      return visible(stored);
    },
    async get(id) {
      const project = await backing.get(id);
      return project ? visible(project) : null;
    },
    async listForMember(principalId) {
      if (!isActiveMember(principalId)) return [];
      return (await backing.forMember(configOrgId(), principalId))
        .filter((project) => isActiveMember(project.ownerId))
        .map(visible);
    },
    addMember: (id, ownerId, memberId, effect) => mutate(id, ownerId, memberId, true, effect),
    removeMember: (id, ownerId, memberId, effect) => mutate(id, ownerId, memberId, false, effect),
    async rename(id, ownerId, name, effect) {
      return withLock(id, async () => {
        const clean = cleanName(name);
        if (!clean) return { status: "invalid_name" };
        const outcome: { status: ProjectMutation["status"] } = { status: "not_found" };
        let changed = false;
        const updated = await update(id, (project) => {
          if (project.ownerId !== ownerId || !isActiveMember(ownerId)) {
            outcome.status = "forbidden";
            return project;
          }
          outcome.status = "ok";
          if (project.name === clean) return project;
          changed = true;
          return { ...project, name: clean };
        });
        if (!updated) return { status: "not_found" };
        if (outcome.status !== "ok") return { status: outcome.status };
        const result = { status: "ok" as const, project: visible(updated), changed };
        await effect?.(result);
        return result;
      });
    },
    async setSlackChannel(id, actorId, link, effect) {
      return withLock(id, async () => {
        const outcome: { status: ProjectMutation["status"] } = { status: "not_found" };
        let changed = false;
        const updated = await update(id, (project) => {
          const isMember = project.memberIds.some((member) => samePerson(member, actorId));
          if (!isMember || !isActiveMember(project.ownerId) || !isActiveMember(actorId)) {
            outcome.status = "forbidden";
            return project;
          }
          outcome.status = "ok";
          const current = project.slackChannel;
          if (!link) {
            if (!current) return project;
            changed = true;
            const { slackChannel: _dropped, channelMemberIds: _members, ...rest } = project;
            return rest;
          }
          if (current && current.channelId === link.channelId && current.channelName === link.channelName)
            return project;
          changed = true;
          return {
            ...project,
            slackChannel: {
              channelId: link.channelId,
              channelName: link.channelName,
              linkedBy: actorId,
              linkedAt: now(),
            },
          };
        });
        if (!updated) return { status: "not_found" };
        if (outcome.status !== "ok") return { status: outcome.status };
        const result = { status: "ok" as const, project: visible(updated), changed };
        await effect?.(result);
        return result;
      });
    },
    async syncChannelMembers(id, memberIds, channelName, effect) {
      return withLock(id, async () => {
        const outcome: { status: ProjectMutation["status"] } = { status: "not_found" };
        let changed = false;
        const next = [...new Set(memberIds)].sort();
        const updated = await update(id, (project) => {
          if (!project.slackChannel || !isActiveMember(project.ownerId)) {
            outcome.status = "forbidden";
            return project;
          }
          outcome.status = "ok";
          const current = [...(project.channelMemberIds ?? [])].sort();
          const sameMembers = current.length === next.length && current.every((m, i) => m === next[i]);
          const nextName = channelName ?? project.slackChannel.channelName;
          const sameName = nextName === project.slackChannel.channelName;
          if (sameMembers && sameName) return project;
          changed = true;
          return {
            ...project,
            channelMemberIds: next,
            slackChannel: { ...project.slackChannel, channelName: nextName },
            ...(sameMembers ? {} : { updatedAt: Math.max(now(), project.updatedAt + 1) }),
          };
        });
        if (!updated) return { status: "not_found" };
        if (outcome.status !== "ok") return { status: outcome.status };
        const result = { status: "ok" as const, project: visible(updated), changed };
        await effect?.(result);
        return result;
      });
    },
    async listLinked() {
      return (await backing.linked(configOrgId())).filter((project) => isActiveMember(project.ownerId)).map(visible);
    },
    async slackChannel(groupRef) {
      const project = await projectForGroup(groupRef);
      if (!project || !isActiveMember(project.ownerId) || !project.slackChannel) return undefined;
      return { ...project.slackChannel };
    },
    recognizes: isProjectGroupRef,
    async membership(groupRef, principalId) {
      const project = await projectForGroup(groupRef);
      return project
        ? isActiveMember(project.ownerId) &&
            isActiveMember(principalId) &&
            effectiveMemberIds(project).includes(principalId)
        : undefined;
    },
    async members(groupRef) {
      const project = await projectForGroup(groupRef);
      if (!project) return undefined;
      return isActiveMember(project.ownerId)
        ? effectiveMemberIds(project).filter((principalId) => isActiveMember(principalId))
        : [];
    },
    async version(groupRef) {
      const project = await projectForGroup(groupRef);
      return project ? String(project.updatedAt) : undefined;
    },
    async withVersion(groupRef, version, fn) {
      const id = projectIdFromGroupRef(groupRef);
      if (!id) return undefined;
      return withLock(id, async () => {
        const project = await backing.get(id);
        if (!project || project.orgId !== configOrgId() || String(project.updatedAt) !== version) return undefined;
        return fn();
      });
    },
    async name(groupRef) {
      const project = await projectForGroup(groupRef);
      return project && isActiveMember(project.ownerId) ? project.name : undefined;
    },
    async withRosterLock(id, fn) {
      return withLock(id, async () => {
        const project = await backing.get(id);
        return project ? fn(visible(project)) : null;
      });
    },
    ...(backing.close ? { close: backing.close } : {}),
  };
}

function memoryProjectRows(): ProjectRows {
  const tenants = new Map<string, DurableMap<Project>>();
  const projects = (): DurableMap<Project> => {
    const tenant = currentTenant();
    const map = tenants.get(tenant) ?? createMemoryMap<Project>();
    tenants.set(tenant, map);
    return map;
  };
  const where = async (keep: (project: Project) => boolean) =>
    (await projects().all()).filter(keep).sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    get: (id) => projects().get(id),
    insert: (project) => projects().putIfAbsent(project.id, project),
    save: (project) => projects().put(project.id, project),
    forMember: (orgId, principalId) =>
      where(
        (p) => p.orgId === orgId && (p.memberIds.includes(principalId) || !!p.channelMemberIds?.includes(principalId)),
      ),
    linked: (orgId) => where((p) => p.orgId === orgId && p.slackChannel !== undefined),
  };
}

export function createProjectStore(opts: ProjectStoreOptions): ProjectStore {
  return projectStore(memoryProjectRows(), opts);
}

export const PROJECTS_MIGRATION = typedTableMigration({
  table: "projects",
  columns: [
    "id TEXT NOT NULL",
    "org_id TEXT NOT NULL",
    "name TEXT NOT NULL",
    "owner_id TEXT NOT NULL",
    "member_ids TEXT[] NOT NULL",
    "channel_member_ids TEXT[]",
    "slack_channel_id TEXT",
    "slack_channel_name TEXT",
    "slack_linked_by TEXT",
    "slack_linked_at BIGINT",
    "created_at BIGINT NOT NULL",
    "updated_at BIGINT NOT NULL",
  ],
  constraints: [
    `CHECK ((slack_channel_id IS NULL) = (slack_channel_name IS NULL)
       AND (slack_channel_id IS NULL) = (slack_linked_by IS NULL)
       AND (slack_channel_id IS NULL) = (slack_linked_at IS NULL))`,
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    org_id: "json->>'orgId'",
    name: "json->>'name'",
    owner_id: "json->>'ownerId'",
    member_ids: "ARRAY(SELECT jsonb_array_elements_text(json->'memberIds'))",
    channel_member_ids:
      "CASE WHEN jsonb_typeof(json->'channelMemberIds') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(json->'channelMemberIds')) END",
    slack_channel_id: "json->'slackChannel'->>'channelId'",
    slack_channel_name: "json->'slackChannel'->>'channelName'",
    slack_linked_by: "json->'slackChannel'->>'linkedBy'",
    slack_linked_at: "round((json->'slackChannel'->>'linkedAt')::numeric)::bigint",
    created_at: "round((json->>'createdAt')::numeric)::bigint",
    updated_at: "round((json->>'updatedAt')::numeric)::bigint",
  },
  where: [
    "json->>'orgId' IS NOT NULL",
    "json->>'name' IS NOT NULL",
    "json->>'ownerId' IS NOT NULL",
    "jsonb_typeof(json->'memberIds') = 'array'",
    "json->>'createdAt' IS NOT NULL",
    "json->>'updatedAt' IS NOT NULL",
    `(json->'slackChannel' IS NULL OR (json->'slackChannel'->>'channelId' IS NOT NULL
      AND json->'slackChannel'->>'channelName' IS NOT NULL AND json->'slackChannel'->>'linkedBy' IS NOT NULL
      AND json->'slackChannel'->>'linkedAt' IS NOT NULL))`,
  ].join(" AND "),
  indexes: [
    "CREATE INDEX projects_by_org ON projects(tenant_id, org_id, updated_at DESC)",
    "CREATE INDEX projects_linked ON projects(tenant_id, org_id) WHERE slack_channel_id IS NOT NULL",
    "CREATE INDEX projects_by_member ON projects USING GIN ((member_ids || COALESCE(channel_member_ids, '{}'::text[])))",
  ],
});

const PROJECT_COLUMNS = [
  "id",
  "org_id",
  "name",
  "owner_id",
  "member_ids",
  "channel_member_ids",
  "slack_channel_id",
  "slack_channel_name",
  "slack_linked_by",
  "slack_linked_at",
  "created_at",
  "updated_at",
];

function projectRow(project: Project): unknown[] {
  const slack = project.slackChannel;
  return [
    project.id,
    project.orgId,
    project.name,
    project.ownerId,
    project.memberIds,
    project.channelMemberIds ?? null,
    slack?.channelId ?? null,
    slack?.channelName ?? null,
    slack?.linkedBy ?? null,
    slack?.linkedAt ?? null,
    project.createdAt,
    project.updatedAt,
  ];
}

function projectFromRow(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    name: String(row.name),
    ownerId: String(row.owner_id),
    memberIds: row.member_ids as string[],
    ...(row.channel_member_ids != null ? { channelMemberIds: row.channel_member_ids as string[] } : {}),
    ...(row.slack_channel_id != null
      ? {
          slackChannel: {
            channelId: String(row.slack_channel_id),
            channelName: String(row.slack_channel_name),
            linkedBy: String(row.slack_linked_by),
            linkedAt: Number(row.slack_linked_at),
          },
        }
      : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const MEMBERS = "(member_ids || COALESCE(channel_member_ids, '{}'::text[]))";

export function createPostgresProjectStore(connectionString: string, opts: ProjectStoreOptions): ProjectStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, PROJECTS_MIGRATION]);
  const select = async (where: string, params: unknown[]): Promise<Project[]> =>
    (
      await q(`SELECT * FROM projects WHERE tenant_id = ${TENANT} AND ${where} ORDER BY updated_at DESC, id`, params)
    ).map(projectFromRow);
  const placeholders = PROJECT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  return projectStore(
    {
      async get(id) {
        return (await select("id = $1", [id]))[0] ?? null;
      },
      async insert(project) {
        await q(
          `INSERT INTO projects(${PROJECT_COLUMNS.join(", ")}) VALUES (${placeholders}) ON CONFLICT (tenant_id, id) DO NOTHING`,
          projectRow(project),
        );
        return (await select("id = $1", [project.id]))[0]!;
      },
      async save(project) {
        await q(
          `UPDATE projects SET ${PROJECT_COLUMNS.slice(1)
            .map((column, i) => `${column} = $${i + 2}`)
            .join(", ")} WHERE tenant_id = ${TENANT} AND id = $1`,
          projectRow(project),
        );
      },
      forMember: (orgId, principalId) => select(`org_id = $1 AND ${MEMBERS} @> ARRAY[$2::text]`, [orgId, principalId]),
      linked: (orgId) => select("org_id = $1 AND slack_channel_id IS NOT NULL", [orgId]),
      close,
    },
    opts,
  );
}
