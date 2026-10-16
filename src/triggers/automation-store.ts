import { assertNoEscalation, buildTriggerBase, createDeduped, type CreateTriggerInput } from "./trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import type { Automation, Destination, RecipientConsent } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface CreateAutomationInput extends CreateTriggerInput {
  title?: string;
  action?: string;
  message?: string;
  enabled?: boolean;
}

export interface AutomationPatch {
  destination?: Destination;
  title?: string;
  action?: string;
  message?: string;
  enabled?: boolean;
  archived?: boolean;
}

export function normalizeAutomationTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}...` : trimmed;
}

function automationPatch(patch: AutomationPatch): Partial<Automation> {
  const fields: Partial<Automation> = {};
  if (patch.destination !== undefined) fields.destination = patch.destination;
  if (patch.title !== undefined) fields.title = normalizeAutomationTitle(patch.title);
  if (patch.action !== undefined) fields.action = patch.action;
  if (patch.message !== undefined) fields.message = patch.message;
  if (patch.enabled !== undefined) fields.enabled = patch.enabled;
  if (patch.archived !== undefined) fields.archived = patch.archived;
  if (patch.archived === true) fields.enabled = false;
  return fields;
}

export interface AutomationStore<T extends Automation, I extends CreateAutomationInput, P extends AutomationPatch> {
  create(input: I): Promise<T>;
  get(id: string): Promise<T | null>;
  list(): Promise<T[]>;
  update(id: string, patch: P): Promise<T | null>;
  delete(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setDestination(id: string, destination: Destination | undefined): Promise<void>;
  setRecipientConsent(id: string, consent: RecipientConsent): Promise<void>;
}

export function createAutomationStore<T extends Automation, I extends CreateAutomationInput, P extends AutomationPatch>(
  backing: DurableMap<T>,
  trigger: {
    create(input: I, now: number): { identity: string[]; fields: Partial<T> };
    update(before: T, patch: P): Partial<T>;
    present?: (value: T) => Promise<T>;
    reactivateDuplicate?: boolean;
  },
): AutomationStore<T, I, P> {
  const present = trigger.present ?? ((value: T) => Promise.resolve(value));
  const setEnabled = async (id: string, enabled: boolean) => {
    await backing.merge(id, { enabled, ...(enabled ? { archived: false } : {}) } as Partial<T>);
  };
  return {
    async create(input) {
      assertNoEscalation(input);
      const now = Date.now();
      const { identity, fields } = trigger.create(input, now);
      const title = normalizeAutomationTitle(input.title);
      const value = await createDeduped(
        backing,
        hashId(identity),
        (id) =>
          ({
            ...buildTriggerBase(input, id, now),
            enabled: input.enabled !== false,
            ...(title ? { title } : {}),
            ...(input.action !== undefined ? { action: input.action } : {}),
            ...(input.message !== undefined ? { message: input.message } : {}),
            ...fields,
          }) as T,
      );
      if (trigger.reactivateDuplicate && !value.enabled && input.enabled !== false) {
        await setEnabled(value.id, true);
        return { ...value, enabled: true, archived: false };
      }
      return value;
    },
    async get(id) {
      const value = await backing.get(id);
      return value ? present(value) : null;
    },
    async list() {
      return Promise.all((await backing.all()).map(present));
    },
    async update(id, patch) {
      const before = await backing.get(id);
      if (!before) return null;
      const fields = { ...automationPatch(patch), ...trigger.update(before, patch) } as Partial<T>;
      const value = await backing.merge(id, fields);
      return value ? present(value) : null;
    },
    delete: (id) => backing.delete(id),
    setEnabled,
    async setDestination(id, destination) {
      await backing.merge(id, { destination } as Partial<T>);
    },
    async setRecipientConsent(id, recipientConsent) {
      await backing.merge(id, { recipientConsent } as Partial<T>);
    },
  };
}
