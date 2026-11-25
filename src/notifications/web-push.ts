import { createHash } from "node:crypto";
import { generateRequestDetails, generateVAPIDKeys } from "web-push";
import type { SecretKey } from "../connectors/connector-client-store.ts";
import {
  createEncryptedSecretStore,
  deleteReplacedSecrets,
  type SecretStoreFactory,
} from "../credentials/secret-store.ts";
import { canonicalPerson } from "../directory/person.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { scopeId } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { publicFetch, type AddressFetch } from "../util/network.ts";
import type { AddressedReplyNotice } from "./reply-notifications.ts";

export interface WebPushSubscriptionRecord {
  principalId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  updatedAt: number;
}

export interface VapidKeyRecord {
  publicKey: string;
  privateKeyEnc: string;
  createdAt: number;
}

export interface WebPush {
  publicKey(): Promise<string>;
  subscribe(
    principalId: string,
    subscription: Pick<WebPushSubscriptionRecord, "endpoint" | "p256dh" | "auth">,
  ): Promise<void>;
  unsubscribe(principalId: string, endpoint: string): Promise<void>;
  send(notices: readonly AddressedReplyNotice[]): Promise<void>;
}

const VAPID_ID = "current";
const GONE = new Set([404, 410]);

export function webPushSubject(publicUrl: string | undefined): string | undefined {
  if (!publicUrl) return undefined;
  try {
    return new URL(publicUrl).protocol === "https:" ? publicUrl : undefined;
  } catch {
    return undefined;
  }
}

export async function webNotificationsOn(
  deps: { featureFlags?: Pick<FeatureFlagStore, "enabled"> },
  person: string,
): Promise<boolean> {
  return (await deps.featureFlags?.enabled("web_notifications", scopeId("personal", person))) === true;
}

const subscriptionId = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex");

export function createWebPush(deps: {
  subscriptions: DurableMap<WebPushSubscriptionRecord>;
  vapid: DurableMap<VapidKeyRecord>;
  key: SecretKey;
  secrets?: SecretStoreFactory;
  subject: string;
  fetch?: AddressFetch;
}): WebPush {
  const send = deps.fetch ?? publicFetch;
  const secrets = (deps.secrets ?? createEncryptedSecretStore)(deps.key);
  const vapidRecord = async (): Promise<VapidKeyRecord> => {
    const stored = await deps.vapid.get(VAPID_ID);
    if (stored) return stored;
    const fresh = generateVAPIDKeys();
    const privateKeyEnc = await secrets.put("web-push/vapid", fresh.privateKey);
    const saved = await deps.vapid.putIfAbsent(VAPID_ID, {
      publicKey: fresh.publicKey,
      privateKeyEnc,
      createdAt: Date.now(),
    });
    await deleteReplacedSecrets(secrets, [privateKeyEnc], [saved.privateKeyEnc]);
    return saved;
  };
  const deliver = async (
    sub: WebPushSubscriptionRecord,
    payload: string,
    vapid: { publicKey: string; privateKey: string },
  ): Promise<void> => {
    const request = generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      { vapidDetails: { subject: deps.subject, ...vapid }, urgency: "high" },
    );
    const res = await send(request.endpoint, { method: request.method, headers: request.headers, body: request.body });
    if (GONE.has(res.status)) {
      await deps.subscriptions.deleteIf(subscriptionId(sub.endpoint), (stored) => stored.endpoint === sub.endpoint);
      return;
    }
    if (!res.ok)
      throw new Error(`push service ${new URL(sub.endpoint).origin} answered ${res.status}: ${await res.text()}`);
  };
  return {
    publicKey: async () => (await vapidRecord()).publicKey,
    async subscribe(principalId, { endpoint, p256dh, auth }) {
      await deps.subscriptions.put(subscriptionId(endpoint), {
        principalId: canonicalPerson(principalId),
        endpoint,
        p256dh,
        auth,
        updatedAt: Date.now(),
      });
    },
    async unsubscribe(principalId, endpoint) {
      const owner = canonicalPerson(principalId);
      await deps.subscriptions.deleteIf(subscriptionId(endpoint), (stored) => stored.principalId === owner);
    },
    async send(notices) {
      const payloads = new Map<string, string[]>();
      for (const { principalId, notice } of notices) {
        const owner = canonicalPerson(principalId);
        payloads.set(owner, [...(payloads.get(owner) ?? []), JSON.stringify(notice)]);
      }
      if (!payloads.size) return;
      const subs = await deps.subscriptions.select({
        where: { field: "principalId", anyOfFold: [...payloads.keys()] },
      });
      if (!subs.length) return;
      const stored = await vapidRecord();
      const vapid = { publicKey: stored.publicKey, privateKey: await secrets.get(stored.privateKeyEnc) };
      const sends = subs.flatMap((sub) =>
        (payloads.get(canonicalPerson(sub.principalId)) ?? []).map((payload) => deliver(sub, payload, vapid)),
      );
      const results = await Promise.allSettled(sends);
      const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
      if (failures.length)
        throw new AggregateError(
          failures,
          `web push failed for ${failures.length} of ${sends.length} deliveries; first: ${errMessage(failures[0])}`,
        );
    },
  };
}
