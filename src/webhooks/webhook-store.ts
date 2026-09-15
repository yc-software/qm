import type { RecipientConsent, Webhook } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  contentPart,
  createDeduped,
  setTriggerEnabled,
  setTriggerRecipientConsent,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import { getVerifier } from "./verifiers.ts";

export interface CreateWebhookInput extends CreateTriggerInput {
  action: string;
  verification: Webhook["verification"];
  filters?: Webhook["filters"];
}

export interface WebhookEvent {
  deliveryId: string;
  receivedAt: number;
  payload: string;
}

export interface WebhookHistory {
  events: WebhookEvent[];
}

export interface WebhookStore {
  recordEvent(id: string, event: WebhookEvent): Promise<void>;
  listEvents(id: string): Promise<WebhookEvent[]>;
  create(input: CreateWebhookInput): Promise<Webhook>;
  get(id: string): Promise<Webhook | null>;
  list(): Promise<Webhook[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setRecipientConsent(id: string, recipientConsent: RecipientConsent): Promise<void>;
  recordFire(id: string, info: { at: number; deliveryId?: string; error?: string }): Promise<void>;
}

export function createWebhookStore(
  backing: DurableMap<Webhook> = createMemoryMap<Webhook>(),
  history: DurableMap<WebhookHistory> = createMemoryMap<WebhookHistory>(),
): WebhookStore {
  if (!history.update) throw new Error("webhook history requires atomic updates");
  const updateHistory = history.update.bind(history);
  return {
    async recordEvent(id, event) {
      await history.putIfAbsent(id, { events: [] });
      await updateHistory(id, (value) => {
        if (value.events.some((e) => e.deliveryId === event.deliveryId)) return value;
        return {
          events: [
            ...value.events,
            {
              ...event,
              payload: event.payload.slice(0, 16_100),
            },
          ]
            .sort((a, b) => b.receivedAt - a.receivedAt || a.deliveryId.localeCompare(b.deliveryId))
            .slice(0, 50),
        };
      });
    },
    async listEvents(id) {
      return structuredClone((await history.get(id))?.events ?? []);
    },
    async create(input) {
      assertNoEscalation(input);
      if (!getVerifier(input.verification.scheme) || !input.verification.secret) {
        throw new Error("webhook verification requires a supported signed scheme and secret");
      }
      if (
        input.filters?.some(
          (filter) => !filter.path.trim() || filter.in.length === 0 || filter.in.some((value) => !value.trim()),
        )
      ) {
        throw new Error("every webhook filter requires a path and at least one value");
      }
      const filters = input.filters?.length ? input.filters : undefined;
      const contentId = hashId([
        contentPart(input.owner),
        contentPart(input.ownerScopeId),
        contentPart(input.action),
        contentPart(input.verification),
        contentPart(filters),
        contentPart(input.destination),
      ]);
      const webhook = await createDeduped(backing, contentId, (id) => ({
        ...buildTriggerBase(input, id, Date.now()),
        action: input.action,
        verification: input.verification,
        ...(filters ? { filters } : {}),
      }));
      if (webhook.enabled) return webhook;
      await setTriggerEnabled(backing, webhook.id, true);
      return { ...webhook, enabled: true };
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    setEnabled(id, enabled) {
      return setTriggerEnabled(backing, id, enabled);
    },
    setRecipientConsent(id, recipientConsent) {
      return setTriggerRecipientConsent(backing, id, recipientConsent);
    },
    async recordFire(id, info) {
      await backing.merge(id, {
        lastFiredAt: info.at,
        ...(info.deliveryId ? { lastDeliveryId: info.deliveryId } : {}),
        lastError: info.error,
      });
    },
  };
}
