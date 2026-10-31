import { randomUUID } from "node:crypto";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { currentTenant } from "../tenants/context.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { scopeId, type ScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import { createKeyedQueue } from "../util/async.ts";
import { pgTextSafe } from "../util/text.ts";

const PROJECT_GROUP_PREFIX = "web-project-";

interface ProjectSlackChannel {
  channelId: string;
  channelName: string;
  linkedBy: string;
  linkedAt: number;
}

export interface Project {
  id: string;
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
  forMember(principalId: string): Promise<Project[]>;
  linked(): Promise<Project[]>;
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
  const withLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const key = `${currentTenant()}:${id}`;
    return queue(key, () => advisoryLock.withLock(`project:${key}`, fn));
  };

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
    return project ?? undefined;
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
      return (await backing.forMember(principalId)).filter((project) => isActiveMember(project.ownerId)).map(visible);
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
      return (await backing.linked()).filter((project) => isActiveMember(project.ownerId)).map(visible);
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
        if (!project || String(project.updatedAt) !== version) return undefined;
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

const SLACK_LINK_COMPLETE = ["channelId", "channelName", "linkedBy", "linkedAt"]
  .map((field) => `json->'slackChannel'->>'${field}' IS NOT NULL`)
  .join(" AND ");

export const PROJECTS_MIGRATION = typedTableMigration({
  table: "projects",
  columns: [
    "id TEXT NOT NULL",
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
    name: "json->>'name'",
    owner_id: "json->>'ownerId'",
    member_ids:
      "CASE WHEN jsonb_typeof(json->'memberIds') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(json->'memberIds')) ELSE ARRAY[json->>'ownerId'] END",
    channel_member_ids:
      "CASE WHEN jsonb_typeof(json->'channelMemberIds') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(json->'channelMemberIds')) END",
    slack_channel_id: `CASE WHEN ${SLACK_LINK_COMPLETE} THEN json->'slackChannel'->>'channelId' END`,
    slack_channel_name: `CASE WHEN ${SLACK_LINK_COMPLETE} THEN json->'slackChannel'->>'channelName' END`,
    slack_linked_by: `CASE WHEN ${SLACK_LINK_COMPLETE} THEN json->'slackChannel'->>'linkedBy' END`,
    slack_linked_at: `CASE WHEN ${SLACK_LINK_COMPLETE} THEN round((json->'slackChannel'->>'linkedAt')::numeric)::bigint END`,
    created_at: "round(COALESCE(json->>'createdAt', json->>'updatedAt', '0')::numeric)::bigint",
    updated_at: "round(COALESCE(json->>'updatedAt', json->>'createdAt', '0')::numeric)::bigint",
  },
  where: `json->>'name' IS NOT NULL AND json->>'ownerId' IS NOT NULL
    AND json->>'orgId' = (SELECT json->>'orgId' FROM projects_kv WHERE json->>'orgId' IS NOT NULL
      GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1)`,
  indexes: [
    "CREATE INDEX projects_by_updated ON projects(tenant_id, updated_at DESC)",
    "CREATE INDEX projects_linked ON projects(tenant_id) WHERE slack_channel_id IS NOT NULL",
  ],
});

const PROJECT_COLUMNS = [
  "id",
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
    pgTextSafe(project.id),
    pgTextSafe(project.name),
    pgTextSafe(project.ownerId),
    project.memberIds.map(pgTextSafe),
    project.channelMemberIds?.map(pgTextSafe) ?? null,
    slack ? pgTextSafe(slack.channelId) : null,
    slack ? pgTextSafe(slack.channelName) : null,
    slack ? pgTextSafe(slack.linkedBy) : null,
    slack?.linkedAt ?? null,
    project.createdAt,
    project.updatedAt,
  ];
}

function projectFromRow(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
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
      forMember: (principalId) => select(`${MEMBERS} @> ARRAY[$1::text]`, [principalId]),
      linked: () => select("slack_channel_id IS NOT NULL", []),
      close,
    },
    opts,
  );
}
