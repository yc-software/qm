import type { Automation, Destination, ScopeId } from "../types.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { AutomationStore, AutomationPatch, CreateAutomationInput } from "./automation-store.ts";

export function createAutomationService<
  T extends Automation,
  I extends CreateAutomationInput,
  P extends AutomationPatch,
>(
  kind: "cron" | "webhook",
  store: AutomationStore<T, I, P>,
  audit: Pick<AuditLog, "record">,
  rules: {
    create?: (input: I) => Promise<I>;
    update?: (before: T, patch: P) => Promise<P>;
  } = {},
) {
  const record = (operation: string, value: T, actorId = value.owner) =>
    audit.record({
      at: Date.now(),
      principalId: actorId,
      action: `${kind}_${operation}`,
      resource: value.id,
      scopeLabel: value.ownerScopeId,
    });
  return {
    get: store.get,
    list: store.list,
    async create(input: I) {
      const value = await store.create(rules.create ? await rules.create(input) : input);
      record("create", value, value.createdBy);
      return value;
    },
    async update(id: string, patch: P, actorId?: string) {
      const before = await store.get(id);
      if (!before) return null;
      const value = await store.update(id, rules.update ? await rules.update(before, patch) : patch);
      if (value) record("update", value, actorId ?? before.owner);
      return value;
    },
    async delete(id: string, actorId?: string) {
      const before = await store.get(id);
      await store.delete(id);
      if (before) record("delete", before, actorId);
    },
    async setEnabled(id: string, enabled: boolean, actorId?: string) {
      const before = await store.get(id);
      if (!before) return;
      await store.setEnabled(id, enabled);
      record(enabled ? "enable" : "disable", before, actorId);
    },
    async setDestination(id: string, destination: Destination | undefined, actorId?: string) {
      const before = await store.get(id);
      if (!before) return null;
      await store.setDestination(id, destination);
      record("retarget", before, actorId);
      return store.get(id);
    },
    setRecipientConsent: store.setRecipientConsent,
  };
}

export async function canManageAutomation(
  access: {
    membershipControlsScope(scopeId: ScopeId): Promise<boolean>;
    managesScope(actorId: string, scopeId: ScopeId): Promise<boolean>;
    samePerson(left: string, right: string): Promise<boolean>;
  },
  automation: Pick<Automation, "ownerScopeId" | "owner">,
  actorId: string,
  isActor?: (id: string) => Promise<boolean>,
  additionalAccess?: () => Promise<boolean>,
): Promise<boolean> {
  if (await access.membershipControlsScope(automation.ownerScopeId)) {
    return access.managesScope(actorId, automation.ownerScopeId);
  }
  if (await (isActor ? isActor(automation.owner) : access.samePerson(automation.owner, actorId))) return true;
  return additionalAccess ? additionalAccess() : false;
}
