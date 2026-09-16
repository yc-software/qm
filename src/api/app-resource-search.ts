import { skillVisibilityContext } from "./app-skills.ts";
import { visibleSkillRows } from "../skills/skill-store.ts";
import type { App, AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import { cronVisibility } from "./app-messaging.ts";
import { canAdministerWebhook } from "./control-service.ts";
import {
  createMemoryResourceSearch,
  resourceHit,
  type ResourceCandidate,
  type ResourceKind,
  type ResourceSearchHit,
} from "../search/resource-search.ts";
import { matchesSearchTerms, searchTerms } from "../sessions/entry-search.ts";
import { scopeId } from "../types.ts";

export function createResourceSearchMethods(
  deps: AppDeps,
  app: App,
  helpers: AppHelpers,
): Pick<App, "searchResources"> {
  const store =
    deps.resourceSearch ??
    createMemoryResourceSearch(async (kind) => {
      const defaults = { scopeId: scopeId("org", ""), ownerScopeId: scopeId("org", ""), createdBy: "", owner: "" };
      switch (kind) {
        case "skills":
          return (await deps.skills.list()).map((s) => ({
            ...defaults,
            ...s,
            title: s.manifest.name,
            description: s.manifest.description,
          }));
        case "crons":
          return (await deps.crons.list()).map((c) => ({
            ...defaults,
            ...c,
            title: c.title ?? "",
            description: `${c.action ?? ""} ${c.message ?? ""}`,
          }));
        case "deploys":
          return (await deps.deploy.listDeployments()).map((d) => ({
            ...defaults,
            ...d,
            title: d.displayName ?? d.name ?? "",
            description: d.name ?? "",
          }));
        case "webhooks":
          return (await deps.webhooks.list()).map((w) => ({
            ...defaults,
            ...w,
            title: w.action,
            description: w.verification.scheme,
          }));
      }
    });
  return {
    async searchResources(principalId, query) {
      query = query.slice(0, 500);
      if (query.trim().length < 2 || !searchTerms(query).length) return { hits: [], failed: [], limited: [] };
      let visibleSkills = new Set<string>();
      let crons: ReturnType<typeof cronVisibility> | undefined;
      let person: ReturnType<App["personMatcher"]> | undefined;
      const canSee = async (kind: ResourceKind, row: ResourceCandidate): Promise<boolean> => {
        switch (kind) {
          case "skills":
            if (await helpers.canManageSkill(row, principalId)) return true;
            if (row.status !== "published") return false;
            return visibleSkills.has(row.id);
          case "crons":
            crons ??= cronVisibility(deps, helpers, principalId);
            return (await crons).canSee(row);
          case "deploys":
            return (await helpers.principalGitPermission(row, principalId)) !== null;
          case "webhooks":
            person ??= app.personMatcher(principalId);
            return canAdministerWebhook(app, row, principalId, await person);
        }
      };
      const kinds: ResourceKind[] = ["skills", "crons", "deploys", "webhooks"];
      const limited: string[] = [];
      const search = async (kind: ResourceKind): Promise<ResourceSearchHit[]> => {
        const hits: ResourceSearchHit[] = [];
        const candidates = await store.search(kind, query, 201);
        const rows = candidates.slice(0, 200);
        if (kind === "skills" && rows.length) {
          const { skills, homes } = await store.skillMetadata([...new Set(rows.map((r) => r.title))]);
          const { ordered, granted } = await skillVisibilityContext(deps, helpers, principalId, homes);
          visibleSkills = new Set(visibleSkillRows(skills, ordered, granted).map((r) => r.skill.id));
        }
        for (let i = 0; i < rows.length; i += 20) {
          const batch = rows.slice(i, i + 20);
          const allowed = await Promise.all(batch.map((row) => canSee(kind, row)));
          for (const [j, row] of batch.entries()) {
            if (allowed[j]) hits.push(resourceHit(kind, row, query));
            if (hits.length === 8) {
              if (!limited.includes(kind)) limited.push(kind);
              return hits;
            }
          }
        }
        return hits;
      };
      const projects = async (): Promise<ResourceSearchHit[]> => {
        const [projects, channels] = await Promise.all([
          helpers.projectsForViewer(principalId),
          deps.identity.isInternal(deps.identity.classify(principalId))
            ? deps.directory.listChannelsFor(principalId)
            : Promise.resolve([]),
        ]);
        return [
          { id: scopeId("personal", principalId), title: "Personal", description: "Personal project" },
          ...projects.map((p) => ({ id: p.scopeId, title: p.name, description: "Project" })),
          ...channels.map((c) => ({
            id: scopeId("channel", c.channelId),
            title: c.name ?? c.channelId,
            description: "Channel project",
          })),
        ]
          .filter((r) => matchesSearchTerms(`${r.title} ${r.description}`, searchTerms(query)))
          .slice(0, 8)
          .map((r) => resourceHit("contexts", r, query));
      };
      const results = await Promise.allSettled([...kinds.map(search), projects()]);
      return {
        hits: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
        limited,
        failed: results.flatMap((r, i) => (r.status === "rejected" ? [[...kinds, "contexts"][i]!] : [])),
      };
    },
  };
}
