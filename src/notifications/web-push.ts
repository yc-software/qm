import { createHash } from "node:crypto";
import { generateRequestDetails, generateVAPIDKeys } from "web-push";
import { decryptSecret, encryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
import { canonicalPerson } from "../directory/person.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { publicFetch, type AddressFetch } from "../util/network.ts";
import type { ReplyNotice } from "./reply-notifications.ts";

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
  send(principalId: string, notice: ReplyNotice): Promise<void>;
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

const subscriptionId = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex");

export function createWebPush(deps: {
  subscriptions: DurableMap<WebPushSubscriptionRecord>;
  vapid: DurableMap<VapidKeyRecord>;
  key: SecretKey;
  subject: string;
  fetch?: AddressFetch;
}): WebPush {
  const send = deps.fetch ?? publicFetch;
  const vapidRecord = async (): Promise<VapidKeyRecord> => {
    const stored = await deps.vapid.get(VAPID_ID);
    if (stored) return stored;
    const fresh = generateVAPIDKeys();
    return deps.vapid.putIfAbsent(VAPID_ID, {
      publicKey: fresh.publicKey,
      privateKeyEnc: encryptSecret(fresh.privateKey, deps.key),
      createdAt: Date.now(),
    });
  };
  const deliver = async (sub: WebPushSubscriptionRecord, payload: string, vapid: VapidKeyRecord): Promise<void> => {
    const request = generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      {
        vapidDetails: {
          subject: deps.subject,
          publicKey: vapid.publicKey,
          privateKey: decryptSecret(vapid.privateKeyEnc, deps.key),
        },
        urgency: "high",
      },
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
    async send(principalId, notice) {
      const subs = await deps.subscriptions.select({
        where: { field: "principalId", anyOfFold: [canonicalPerson(principalId)] },
      });
      if (!subs.length) return;
      const vapid = await vapidRecord();
      const payload = JSON.stringify(notice);
      const results = await Promise.allSettled(subs.map((sub) => deliver(sub, payload, vapid)));
      const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
      if (failures.length)
        throw new AggregateError(failures, `web push failed for ${failures.length} of ${subs.length} subscriptions`);
    },
  };
}
