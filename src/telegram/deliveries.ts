import { swallow } from "../util/errors.ts";
import type { CoreClient } from "../api/core-client.ts";
import type { CoreBridge } from "../api/core-bridge.ts";
import type { TelegramApi } from "./bot-api.ts";
import type { Delivery } from "../types.ts";

const DELIVERY_MAX_ATTEMPTS = 5;

export function createDeliveryPoller(deps: { core: CoreClient; bridge: CoreBridge; api: TelegramApi }): {
  pollDeliveries(): Promise<void>;
} {
  const { core, bridge, api } = deps;
  const { inFlightRuns, fetchBlobFromCore, fetchFileArtifactFromCore } = bridge;
  const failures = new Map<string, number>();
  const dead = new Set<string>();

  async function fetchDeliveries(): Promise<Delivery[]> {
    try {
      return await core.claimDeliveries("telegram", 15_000);
    } catch {
      return [];
    }
  }

  async function pollDeliveries(): Promise<void> {
    for (const d of await fetchDeliveries()) {
      if (dead.has(d.id)) continue;
      const runId = d.idempotencyKey?.startsWith("run:") ? d.idempotencyKey.slice("run:".length) : undefined;
      if (runId && inFlightRuns.has(runId)) continue;
      const chatId = d.destination.target;
      if (!chatId) {
        await core.ackDelivery(d.id);
        continue;
      }
      try {
        if (d.text?.trim()) {
          await api.sendMessage(chatId, d.text);
        }
        for (const attachment of d.attachments ?? []) {
          const bytes = attachment.artifactId
            ? await fetchFileArtifactFromCore(attachment.artifactId, attachment.artifactViewerId!)
            : await fetchBlobFromCore(attachment.blobId);
          await api.sendDocument(chatId, attachment.name, bytes);
        }
        await core.ackDelivery(d.id);
        failures.delete(d.id);
      } catch (err) {
        swallow("telegram: delivery", err);
        const count = (failures.get(d.id) ?? 0) + 1;
        if (count >= DELIVERY_MAX_ATTEMPTS) {
          failures.delete(d.id);
          dead.add(d.id);
          console.error(`[telegram-plugin] delivery ${d.id} failed permanently (giving up)`);
        } else {
          failures.set(d.id, count);
        }
      }
    }
  }

  return { pollDeliveries };
}
