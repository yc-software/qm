import { randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { scopeId, type ScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import { createKeyedQueue } from "../util/async.ts";

const PROJECT_GROUP_PREFIX = "web-project-";

export interface Project {
  id: string;
  orgId: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  themePreset?: ProjectThemePreset;
  themeMode?: ProjectThemeMode;
  createdAt: number;
  updatedAt: number;
}

export type ProjectThemePreset = "graphite" | "sinora" | "grove" | "ocean" | "ember" | "orchid";
export type ProjectThemeMode = "light" | "dark";

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
  updateTheme(
    id: string,
    ownerId: string,
    themePreset: ProjectThemePreset,
    themeMode?: ProjectThemeMode,
    effect?: ProjectMutationEffect,
  ): Promise<ProjectMutation>;
  recognizes(groupRef: string): boolean;
  membership(groupRef: string, principalId: string): Promise<boolean | undefined>;
  members(groupRef: string): Promise<string[] | undefined>;
  version(groupRef: string): Promise<string | undefined>;
  withVersion<T>(groupRef: string, version: string | undefined, fn: () => Promise<T>): Promise<T | undefined>;
  name(groupRef: string): Promise<string | undefined>;
  withRosterLock<T>(id: string, fn: (project: Project) => Promise<T>): Promise<T | null>;
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

export function isProjectThemePreset(value: unknown): value is ProjectThemePreset {
  return (
    value === "graphite" ||
    value === "sinora" ||
    value === "grove" ||
    value === "ocean" ||
    value === "ember" ||
    value === "orchid"
  );
}

export function isProjectThemeMode(value: unknown): value is ProjectThemeMode {
  return value === "light" || value === "dark";
}

function visible(project: Project): Project {
  return { ...project, memberIds: [...project.memberIds] };
}

export function createProjectStore(
  backing: DurableMap<Project> = createMemoryMap<Project>(),
  opts: {
    now?: () => number;
    id?: () => string;
    isActiveMember?: (principalId: string) => boolean;
    advisoryLock?: AdvisoryLock;
  } = {},
): ProjectStore {
  const now = opts.now ?? Date.now;
  const nextId = opts.id ?? randomUUID;
  const isActiveMember = opts.isActiveMember ?? (() => true);
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const queue = createKeyedQueue<string>();
  const withLock = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
    queue(id, () => advisoryLock.withLock(`project:${id}`, fn));

  async function projectForGroup(groupRef: string): Promise<Project | undefined> {
    const id = projectIdFromGroupRef(groupRef);
    if (!id) return undefined;
    const project = await backing.get(id);
    return project?.orgId === configOrgId() ? project : undefined;
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
      if (!backing.update) throw new Error("project store requires DurableMap.update");
      const outcome: { status: ProjectMutation["status"] } = { status: "not_found" };
      let changed = false;
      const updated = await backing.update(id, (project) => {
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
      const stored = await backing.putIfAbsent(project.id, project);
      if (stored.createdAt !== project.createdAt || stored.ownerId !== project.ownerId)
        throw new Error("project id collision");
      return visible(stored);
    },
    async get(id) {
      const project = await backing.get(id);
      return project ? visible(project) : null;
    },
    async listForMember(principalId) {
      return (await backing.all())
        .filter(
          (project) =>
            project.orgId === configOrgId() &&
            isActiveMember(project.ownerId) &&
            isActiveMember(principalId) &&
            project.memberIds.includes(principalId),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(visible);
    },
    addMember: (id, ownerId, memberId, effect) => mutate(id, ownerId, memberId, true, effect),
    removeMember: (id, ownerId, memberId, effect) => mutate(id, ownerId, memberId, false, effect),
    async rename(id, ownerId, name, effect) {
      return withLock(id, async () => {
        if (!backing.update) throw new Error("project store requires DurableMap.update");
        const clean = cleanName(name);
        if (!clean) return { status: "invalid_name" };
        const outcome: { status: ProjectMutation["status"] } = { status: "not_found" };
        let changed = false;
        const updated = await backing.update(id, (project) => {
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
    async updateTheme(id, ownerId, themePreset, themeMode, effect) {
      return withLock(id, async () => {
        if (!backing.update) throw new Error("project store requires DurableMap.update");
        const outcome: { status: ProjectMutation["status"] } = { status: "not_found" };
        let changed = false;
        const updated = await backing.update(id, (project) => {
          if (project.ownerId !== ownerId || !isActiveMember(ownerId)) {
            outcome.status = "forbidden";
            return project;
          }
          outcome.status = "ok";
          if (project.themePreset === themePreset && project.themeMode === themeMode) return project;
          changed = true;
          return { ...project, themePreset, themeMode, updatedAt: Math.max(now(), project.updatedAt + 1) };
        });
        if (!updated) return { status: "not_found" };
        if (outcome.status !== "ok") return { status: outcome.status };
        const result = { status: "ok" as const, project: visible(updated), changed };
        await effect?.(result);
        return result;
      });
    },
    recognizes: isProjectGroupRef,
    async membership(groupRef, principalId) {
      const project = await projectForGroup(groupRef);
      return project
        ? isActiveMember(project.ownerId) && isActiveMember(principalId) && project.memberIds.includes(principalId)
        : undefined;
    },
    async members(groupRef) {
      const project = await projectForGroup(groupRef);
      if (!project) return undefined;
      return isActiveMember(project.ownerId)
        ? project.memberIds.filter((principalId) => isActiveMember(principalId))
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
  };
}
