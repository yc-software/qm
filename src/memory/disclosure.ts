import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId, personalScope } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { CurrentScopeMembers, IsCurrentSharedScopeMember } from "../resolution/scope-membership.ts";
import { MemoryFactsMissing, parseFactId, renderFacts, type MemoryFact, type MemoryProvenance } from "./facts.ts";
import { queryFacts, type MemoryService } from "./memory-service.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { recallCandidates } from "./recall-candidates.ts";

export interface MemoryDisclosure {
  actor: Principal;
  targetScope: ScopeId;
  nativeScopes: readonly ScopeId[];
  audience: readonly Principal[];
  open: boolean;
  config?: Pick<ScopedConfigStore, "resolveSharingPostureDurable">;
  isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
  currentScopeMembers?: CurrentScopeMembers;
}

function memoryDisclosurePolicy(input: MemoryDisclosure) {
  const decisions = new Map<string, Promise<boolean>>();
  const once = (key: string, read: () => Promise<boolean>) => {
    let decision = decisions.get(key);
    if (!decision) {
      decision = read().catch(swallowAs(`memory disclosure: ${key}`, false));
      decisions.set(key, decision);
    }
    return decision;
  };
  let currentAudience: Promise<readonly Principal[]> | undefined;
  const audience = () =>
    (currentAudience ??=
      input.targetScope === personalScope(input.actor.id)
        ? Promise.resolve(input.audience)
        : (input
            .currentScopeMembers?.(input.targetScope)
            .then((members) => members ?? [])
            .catch(swallowAs("memory disclosure: audience", [])) ?? Promise.resolve([])));
  const native = (scope: ScopeId) => input.nativeScopes.includes(scope);
  function entitled(person: Principal, scope: ScopeId): Promise<boolean> {
    return once(`member:${person.id}:${scope}`, async () => {
      const { kind, ref } = parseScopeId(scope);
      if (person.type !== "internal") return false;
      if (kind === "personal") return samePerson(person.id, ref);
      if (kind === "org") return native(scope);
      if (kind === "team") return native(scope) && person.teamIds?.includes(ref) === true;
      if (scope === input.targetScope && native(scope)) return true;
      return (await input.isCurrentSharedScopeMember?.(person.id, scope)) === true;
    });
  }
  async function allEntitled(scope: ScopeId, members = input.audience): Promise<boolean> {
    return members.length > 0 && (await Promise.all(members.map((person) => entitled(person, scope)))).every(Boolean);
  }
  async function narrow(scope: ScopeId): Promise<boolean> {
    return native(scope) && (await entitled(input.actor, scope)) && (await allEntitled(scope));
  }
  function sourceAllowed(source: ScopeId, sensitivity: MemoryProvenance["sensitivity"]): Promise<boolean> {
    return once(`source:${source}:${sensitivity}`, async () => {
      if (!(await entitled(input.actor, source))) return false;
      if (source === input.targetScope || (native(source) && ["org", "team"].includes(parseScopeId(source).kind ?? "")))
        return allEntitled(source);
      if (!input.open || !input.config) return false;
      const personal = personalScope(input.actor.id);
      if ((await input.config.resolveSharingPostureDurable(personal, input.targetScope)) !== "open") return false;
      if ((await input.config.resolveSharingPostureDurable(personal, source)) !== "open") return false;
      const members = await audience();
      if (await allEntitled(source, [...members])) return true;
      return (
        sensitivity === "ordinary" &&
        source === personal &&
        members.length > 0 &&
        members.every((person) => person.type === "internal")
      );
    });
  }
  return {
    async narrow(scope: ScopeId) {
      try {
        return await narrow(scope);
      } catch (e) {
        swallow("memory disclosure: narrow", e);
        return false;
      }
    },
    async allows(home: ScopeId, record: MemoryProvenance): Promise<boolean> {
      try {
        const homeAllowed = async () => (await narrow(home)) || (await sourceAllowed(home, "unknown"));
        if ((record.sourceUnknown || record.sensitivity === "unknown") && !(await homeAllowed())) return false;
        if (!record.sources.length) return record.sourceUnknown && (await homeAllowed());
        return (await Promise.all(record.sources.map((source) => sourceAllowed(source, record.sensitivity)))).every(
          Boolean,
        );
      } catch (e) {
        swallow("memory disclosure: allows", e);
        return false;
      }
    },
  };
}

export class MemoryDisclosureDenied extends Error {
  constructor() {
    super("This notebook isn't editable from this conversation. Edit it from an authorized conversation.");
  }
}

export function disclosedMemory(memory: MemoryService, access: MemoryDisclosure): MemoryService {
  if (memory.withDisclosure) {
    const view = memory.withDisclosure(access);
    return { ...view, capture: (...args) => memory.capture(...args) };
  }
  const listed = memory.facts?.bind(memory);
  if (!listed) {
    const narrow = (scope: ScopeId) => memoryDisclosurePolicy(access).narrow(scope);
    return {
      ...memory,
      recall: async (scope, context) => ((await narrow(scope)) ? memory.recall(scope, context) : []),
      async *recallPages(scope, context) {
        if (await narrow(scope)) for await (const row of recallCandidates(memory, scope, context)) yield [row];
      },
      query: async (scope, query, limit, context) =>
        (await narrow(scope)) ? memory.query(scope, query, limit, context) : [],
      read: async (scope) => ((await narrow(scope)) ? memory.read(scope) : ""),
    };
  }
  async function visible(scope: ScopeId): Promise<MemoryFact[]> {
    const facts = await listed!(scope);
    const policy = memoryDisclosurePolicy(access);
    const allowed = await Promise.all(facts.map((fact) => policy.allows(scope, fact)));
    return facts.filter((_, index) => allowed[index]);
  }
  async function editable(scope: ScopeId, ids: readonly string[]): Promise<void> {
    if (!(await memoryDisclosurePolicy(access).narrow(scope))) throw new MemoryDisclosureDenied();
    const shown = new Set((await visible(scope)).map((fact) => fact.id));
    const hidden = [...new Set(ids.map(parseFactId))].filter((id) => !shown.has(id));
    if (hidden.length) throw new MemoryFactsMissing(hidden);
  }
  return {
    ...memory,
    facts: visible,
    async edit(scope, edits, author, context) {
      await editable(
        scope,
        edits.map((edit) => edit.id),
      );
      await memory.edit!(scope, edits, author, context);
    },
    async delete(scope, ids, author) {
      await editable(scope, ids);
      await memory.delete!(scope, ids, author);
    },
    read: async (scope) => renderFacts(await visible(scope)),
    async *recallPages(scope, context) {
      const shown = new Set((await visible(scope)).map((fact) => fact.id));
      for await (const row of recallCandidates(memory, scope, context)) {
        if (row.id !== undefined && shown.has(row.id)) yield [row];
      }
    },
    async recall(scope, context) {
      const shown = new Set((await visible(scope)).map((fact) => fact.id));
      return (await memory.recall(scope, context)).filter((row) => row.id !== undefined && shown.has(row.id));
    },
    query: async (scope, query, limit = 20) => queryFacts(await visible(scope), query, limit),
  };
}
