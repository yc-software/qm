import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId, personalScope } from "../types.ts";
import type { PublishedApp } from "./deploy-store.ts";
import { memoryDisclosurePolicy, type MemoryDisclosure } from "../memory/disclosure.ts";
import type { SourceProvenance } from "../memory/facts.ts";
import { samePerson } from "../directory/person.ts";

export function createAppDisclosure(
  deps: Pick<MemoryDisclosure, "config" | "currentScopeMembers" | "isCurrentSharedScopeMember"> & {
    classify(id: string): Principal;
    orgScopeId: ScopeId;
    nativeSources?: (target: ScopeId, sources: readonly ScopeId[]) => Promise<readonly ScopeId[]>;
  },
) {
  return async (
    app: Pick<PublishedApp, "sourceProvenance">,
    target: ScopeId | undefined,
    actorId: string,
  ): Promise<SourceProvenance | undefined> => {
    if (!app.sourceProvenance) return undefined;
    const original = app.sourceProvenance;
    const sources = original.sources.filter((source) => source !== personalScope(actorId));
    const published = { ...original, sources };
    if (!target) {
      if (sources.length || original.sourceUnknown || original.sensitivity !== "ordinary")
        throw new Error("This app's source restrictions prevent public access.");
      return published;
    }
    const publicationMembers = async (scope: ScopeId) => {
      const parsed = parseScopeId(scope);
      return parsed.kind === "personal" ? [deps.classify(parsed.ref)] : deps.currentScopeMembers?.(scope);
    };
    const members = await publicationMembers(target);
    if (
      !members?.length ||
      members.some((member) => member.type !== "internal") ||
      (parseScopeId(target).kind !== "personal" && !members.some((member) => samePerson(member.id, actorId)))
    )
      throw new Error("The app's destination audience could not be verified.");
    const aliases = (await deps.nativeSources?.(target, sources)) ?? [];
    const policy = memoryDisclosurePolicy({
      config: deps.config,
      isCurrentSharedScopeMember: deps.isCurrentSharedScopeMember,
      actor: deps.classify(actorId),
      targetScope: target,
      nativeScopes: [target, deps.orgScopeId, ...aliases],
      audience: members,
      open: true,
      currentScopeMembers: publicationMembers,
    });
    if (
      (sources.length || original.sourceUnknown || original.sensitivity === "unknown") &&
      !(await policy.allows(target, published))
    )
      throw new Error("The selected output's other source restrictions prevent sharing with this audience.");
    return published;
  };
}
