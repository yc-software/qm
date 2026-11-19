import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId, personalScope } from "../types.ts";
import { memoryDisclosurePolicy, MemoryDisclosureDenied, type MemoryDisclosure } from "./disclosure.ts";
import type { SourceProvenance } from "./facts.ts";
import { samePerson } from "../directory/person.ts";

export function createArtifactDisclosure(
  deps: Pick<MemoryDisclosure, "config" | "currentScopeMembers" | "isCurrentSharedScopeMember"> & {
    classify(id: string): Principal;
    orgScopeId: ScopeId;
    nativeSources?: (target: ScopeId, sources: readonly ScopeId[]) => Promise<readonly ScopeId[]>;
  },
) {
  return async (
    artifact: { sourceProvenance?: SourceProvenance },
    target: ScopeId | undefined,
    actorId: string,
  ): Promise<SourceProvenance | undefined> => {
    if (!artifact.sourceProvenance) return undefined;
    const original = artifact.sourceProvenance;
    const sources = original.sources.filter((source) => source !== personalScope(actorId));
    const published = { ...original, sources };
    if (!target) {
      if (sources.length || original.sourceUnknown || original.sensitivity !== "ordinary")
        throw new MemoryDisclosureDenied("This output's source restrictions prevent public access.");
      return published;
    }
    if (!sources.length && !original.sourceUnknown && original.sensitivity !== "unknown") return published;
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
      throw new MemoryDisclosureDenied("The output's destination audience could not be verified.");
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
      throw new MemoryDisclosureDenied(
        "The selected output's other source restrictions prevent sharing with this audience.",
      );
    return published;
  };
}
