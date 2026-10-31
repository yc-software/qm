import type { Webhook } from "../triggers/types.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  contentPart,
  type CreateTriggerInput,
  withFields,
} from "../triggers/trigger-store.ts";
import { type WebhookEvent, type WebhookRows } from "./webhook-table.ts";
import { currentTenant } from "../tenants/context.ts";
import { hashId } from "../util/crypto.ts";
import { getVerifier } from "./verifiers.ts";

export interface CreateWebhookInput extends CreateTriggerInput {
  action: string;
  verification: Webhook["verification"];
  filters?: Webhook["filters"];
}

export type { WebhookEvent };

export interface WebhookStore {
  recordEvent(id: string, event: WebhookEvent): Promise<void>;
  listEvents(id: string): Promise<WebhookEvent[]>;
  create(input: CreateWebhookInput): Promise<Webhook>;
  get(id: string): Promise<Webhook | null>;
  list(): Promise<Webhook[]>;
  ownedBy(scopeId: string): Promise<Webhook[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  update(id: string, patch: { action: string }): Promise<Webhook | null>;
  recordFire(id: string, info: { at: number; deliveryId?: string; error?: string }): Promise<void>;
}

export function createWebhookStore(rows: WebhookRows): WebhookStore {
  const edit = (id: string, fields: Partial<Webhook>) => rows.update(id, (webhook) => withFields(webhook, fields));
  return {
    async recordEvent(id, event) {
      await rows.recordEvent(id, { ...event, payload: event.payload.slice(0, 16_100) });
    },
    listEvents: (id) => rows.listEvents(id),
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
      const id = hashId([
        contentPart(currentTenant()),
        contentPart(input.owner),
        contentPart(input.ownerScopeId),
        contentPart(input.action),
        contentPart(input.verification),
        contentPart(filters),
        contentPart(input.destination),
      ]);
      const webhook = await rows.insertIfAbsent({
        ...buildTriggerBase(input, id, Date.now()),
        action: input.action,
        verification: input.verification,
        ...(filters ? { filters } : {}),
      });
      if (webhook.enabled) return webhook;
      await edit(webhook.id, { enabled: true });
      return { ...webhook, enabled: true };
    },
    get: (id) => rows.get(id),
    list: () => rows.list(),
    ownedBy: (scopeId) => rows.ownedBy(scopeId),
    async setEnabled(id, enabled) {
      await edit(id, { enabled });
    },
    update: (id, patch) => edit(id, { action: patch.action }),
    async recordFire(id, info) {
      await edit(id, {
        lastFiredAt: info.at,
        ...(info.deliveryId ? { lastDeliveryId: info.deliveryId } : {}),
        lastError: info.error,
      });
    },
  };
}
