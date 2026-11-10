import type { AuditLog } from "../audit/audit-log.ts";
import { canonicalPerson } from "../directory/person.ts";
import { parseScopeId, scopeId, type ScopeId } from "../types.ts";
import { activeHolder } from "./persona-schema.ts";
import type { Persona, PersonaStore } from "./persona-store.ts";

interface OwnerHandover {
  persona: Persona;
  to: string;
}

export interface PersonaHandover {
  handovers(leaving?: (principalId: string) => Promise<boolean>): Promise<OwnerHandover[]>;
  handOver(handover: OwnerHandover, by: string): Promise<void>;
  adoptOrphans(): Promise<OwnerHandover[]>;
}

export function createPersonaHandover(deps: {
  store: Pick<PersonaStore, "get" | "ownerGrants" | "addOwner">;
  isActive: (principalId: string) => boolean;
  orgAdmins: () => Promise<ReadonlyArray<{ principalId: string; createdAt?: number }>>;
  auditLog: Pick<AuditLog, "record">;
  now?: () => number;
}): PersonaHandover {
  const now = deps.now ?? Date.now;

  async function defaultAdmin(leaving?: (principalId: string) => Promise<boolean>): Promise<string | undefined> {
    const admins = [...(await deps.orgAdmins())].sort(
      (a, b) =>
        (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        a.principalId.localeCompare(b.principalId),
    );
    for (const admin of admins)
      if (deps.isActive(admin.principalId) && !(await leaving?.(admin.principalId))) return admin.principalId;
    return undefined;
  }

  async function handovers(leaving?: (principalId: string) => Promise<boolean>): Promise<OwnerHandover[]> {
    const owners = new Map<string, ScopeId[]>();
    for (const { personaId, scopeId: owner } of await deps.store.ownerGrants())
      owners.set(personaId, [...(owners.get(personaId) ?? []), owner]);
    const orphaned: string[] = [];
    for (const [personaId, grants] of owners) {
      const active = grants.filter((grant) => activeHolder(grant, deps.isActive)).map(parseScopeId);
      const lastOwnersLeave = leaving
        ? active.length > 0 &&
          (await Promise.all(active.map(({ kind, ref }) => kind === "personal" && leaving(ref!)))).every(Boolean)
        : active.length === 0;
      if (lastOwnersLeave) orphaned.push(personaId);
    }
    const to = orphaned.length ? await defaultAdmin(leaving) : undefined;
    if (!to) return [];
    const result: OwnerHandover[] = [];
    for (const personaId of orphaned) {
      const persona = await deps.store.get(personaId);
      if (persona) result.push({ persona, to });
    }
    return result;
  }

  async function handOver({ persona, to }: OwnerHandover, by: string): Promise<void> {
    await deps.store.addOwner(persona.id, scopeId("personal", canonicalPerson(to)), by);
    deps.auditLog.record({
      at: now(),
      principalId: by,
      action: "persona_owner_handover",
      resource: persona.id,
      scopeLabel: scopeId("persona", persona.id),
      detail: canonicalPerson(to),
    });
  }

  return {
    handovers,
    handOver,
    async adoptOrphans() {
      const found = await handovers();
      for (const handover of found) await handOver(handover, handover.to);
      return found;
    },
  };
}
