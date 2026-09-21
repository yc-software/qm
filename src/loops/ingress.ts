import { randomBytes, randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { Loop } from "../types.ts";
import type { LoopStore } from "./loop-store.ts";
import type { IngestEntryInput, LoopItemLedger } from "./item-ledger.ts";
import type { LoopOutputStore } from "./output-store.ts";
import type { LoopFireService } from "./loop-fire.ts";
import { getVerifier, type VerifierInput } from "../webhooks/verifiers.ts";
import { hashId } from "../util/crypto.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { isObj } from "./sources/adapter.ts";
import { slackConversationRef } from "./sources/slack.ts";
import { createGmailPushClient, verifyGmailPush, type GmailCursor, type GmailPushConfig } from "./gmail-push.ts";

export interface LoopIngress {
  id: string;
  loopId: string;
  owner: string;
  kind: "webhook" | "slack" | "gmail";
  enabled: boolean;
  secret?: string;
  teamId?: string;
  channels?: string[];
  gmail?: GmailCursor;
  createdAt: number;
  lastReceivedAt?: number;
  lastError?: string;
  nextWatchAt?: number;
  nextReconcileAt?: number;
  nextWorkAt?: number;
}

export interface IngressDelivery {
  id: string;
  ingressId: string;
  queueKey?: string;
  receivedAt: number;
  entries?: IngestEntryInput[];
  historyId?: string;
  ingested?: boolean;
  completedAt?: number;
  attempts: number;
  nextAttemptAt: number;
}

export interface LoopIngressDeps {
  enabledFor: (owner: string) => Promise<boolean>;
  sources: DurableMap<LoopIngress>;
  deliveries: DurableMap<IngressDelivery>;
  loops: LoopStore;
  items: LoopItemLedger;
  outputs: LoopOutputStore;
  fire: Pick<LoopFireService, "fire">;
  lock: AdvisoryLock;
  gmailConfig?: GmailPushConfig;
  gmailClient?: ReturnType<typeof createGmailPushClient>;
  verifyGoogle?: typeof verifyGmailPush;
}

export interface IngressSetup {
  kind: LoopIngress["kind"];
  secret?: string;
  teamId?: string;
  channels?: string[];
}

export function createLoopIngress(deps: LoopIngressDeps) {
  let nextCleanupAt = 0;
  async function enqueue(
    source: LoopIngress,
    deliveryId: string,
    payload: Pick<IngressDelivery, "entries" | "historyId">,
  ) {
    const id = hashId([source.id, deliveryId]);
    await deps.deliveries.putIfAbsent(id, {
      id,
      ingressId: source.id,
      queueKey: source.id,
      receivedAt: Date.now(),
      attempts: 0,
      nextAttemptAt: 0,
      ...payload,
    });
    await deps.sources.merge(source.id, { lastReceivedAt: Date.now() });
  }

  async function process(sourceId: string) {
    const initial = await deps.sources.get(sourceId);
    if (!initial?.enabled || !(await deps.enabledFor(initial.owner)) || (initial.nextWorkAt ?? 0) > Date.now()) return;
    const run = async () => {
      const source = await deps.sources.get(sourceId);
      if (!source?.enabled || !(await deps.enabledFor(source.owner)) || (source.nextWorkAt ?? 0) > Date.now()) return;
      const loop = await deps.loops.get(source.loopId);
      if (loop?.state !== "enabled") return;
      const pending = (await deps.deliveries.select({ where: { field: "queueKey", anyOfFold: [sourceId] } }))
        .filter((delivery) => !delivery.completedAt && delivery.nextAttemptAt <= Date.now())
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .slice(0, 20);
      const ingest = async (entries: IngestEntryInput[]) => {
        for (const entry of entries) {
          const existing = (await deps.items.byLoop(source.loopId)).find((item) => item.sourceKey === entry.dedupeKey);
          const refreshed = existing && (entry.sourceAt ?? 0) > (existing.sourceAt ?? 0);
          if (
            refreshed &&
            (await deps.outputs.byItem(existing.id)).some(
              (output) => output.state === "shipping" || output.state === "unconfirmed",
            )
          )
            throw new Error("Confirm the previous output before refreshing this conversation");
          await deps.items.ingest([entry]);
          if (refreshed) await deps.outputs.supersedeActiveSiblings(existing.id, "");
        }
      };
      for (const delivery of pending) {
        const attempt = delivery.attempts + 1;
        await deps.deliveries.merge(delivery.id, { attempts: attempt, nextAttemptAt: Date.now() + 60_000 });
        try {
          if (!delivery.ingested) {
            if (source.kind === "gmail") {
              if (!source.gmail || !deps.gmailClient) throw new Error("Gmail Pub/Sub is not configured");
              if (!delivery.historyId || BigInt(delivery.historyId) > BigInt(source.gmail.historyId)) {
                const historyId = await deps.gmailClient.changes(source.owner, source.loopId, source.gmail, ingest);
                source.gmail = { ...source.gmail, historyId };
                await deps.sources.merge(source.id, { gmail: source.gmail });
              }
            } else await ingest(delivery.entries ?? []);
          }
          await deps.deliveries.merge(delivery.id, {
            ingested: true,
            completedAt: Date.now(),
            queueKey: undefined,
            entries: undefined,
          });
          await deps.sources.merge(source.id, { lastError: undefined });
        } catch (error) {
          await deps.sources.merge(source.id, { lastError: errMessage(error) });
          await deps.deliveries.merge(delivery.id, {
            nextAttemptAt: Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempt, 7)),
          });
          return;
        }
      }
    };
    const keys = [`loop-ingress:${sourceId}`, `loop-lifecycle:${initial.loopId}`];
    const acquire = async (held: string[], action: () => Promise<void>) => {
      if (deps.lock.tryWithLocks) await deps.lock.tryWithLocks(held, action);
      else await deps.lock.withLock(`loop-ingress:${sourceId}`, action);
    };
    await acquire([...keys, `loop-intake:${initial.loopId}`], run);
    await acquire(keys, async () => {
      const source = await deps.sources.get(sourceId);
      if (
        !source?.enabled ||
        !(await deps.enabledFor(source.owner)) ||
        (source.nextWorkAt ?? 0) > Date.now() ||
        (await deps.loops.get(source.loopId))?.state !== "enabled"
      )
        return;
      const queued = await deps.items.queued(source.loopId);
      if (queued.length) {
        for (const item of queued) {
          if (
            (await deps.outputs.byItem(item.id)).some(
              (output) => output.state === "shipping" || output.state === "unconfirmed",
            )
          )
            return;
          await deps.outputs.supersedeActiveSiblings(item.id, "");
        }
        await deps.sources.merge(source.id, { nextWorkAt: Date.now() + 30_000 });
        const result = await deps.fire.fire(source.loopId, `loop-ingress:${source.id}:${randomUUID()}`, undefined, {
          enumerate: false,
        });
        await deps.sources.merge(source.id, {
          nextWorkAt: Date.now() + (result.status === "failed" ? 60_000 : 5_000),
          lastError: result.status === "failed" ? (result.note ?? "Loop processing failed") : undefined,
        });
      }
    });
  }

  return {
    gmailAvailable: Boolean(deps.gmailConfig && deps.gmailClient),
    async list(loopId: string) {
      return await deps.sources.select({ omit: ["secret"], where: { field: "loopId", anyOfFold: [loopId] } });
    },
    async create(loop: Loop, input: IngressSetup): Promise<LoopIngress> {
      if (!(await deps.enabledFor(loop.owner))) throw new Error("Event ingestion is not enabled for this owner");
      if (!["webhook", "slack", "gmail"].includes(input.kind)) throw new Error("Unsupported ingestion source");
      if (loop.sources?.length && input.kind !== "webhook" && !loop.sources.includes(input.kind))
        throw new Error("This source does not match the Loop");
      if (input.kind === "webhook" && loop.sources?.length)
        throw new Error("Generic webhooks require a Loop without a source restriction");
      if (
        input.kind === "slack" &&
        (!input.secret?.trim() ||
          !/^T[A-Z0-9]+$/.test(input.teamId ?? "") ||
          !input.channels?.length ||
          input.channels.some((channel) => !/^[CDG][A-Z0-9]+$/.test(channel)))
      )
        throw new Error("Slack requires a signing secret, workspace ID, and selected channel IDs");
      if (
        input.kind === "gmail" &&
        (loop.ownerScopeId !== `personal:${loop.owner}` || loop.runAs === "scopeShared" || loop.runAs === "scopeFloor")
      )
        throw new Error("Gmail ingestion requires a personal Loop");
      return deps.lock.withLock(`loop-ingress-setup:${loop.id}`, async () => {
        const existing = (await deps.sources.all()).find(
          (source) => source.loopId === loop.id && source.kind === input.kind,
        );
        if (existing) throw new Error("This Loop already has that source. Disable or enable the existing source.");
        const source: LoopIngress = {
          id: randomUUID(),
          loopId: loop.id,
          owner: loop.owner,
          kind: input.kind,
          enabled: true,
          createdAt: Date.now(),
        };
        if (input.kind === "gmail") {
          if (!deps.gmailClient) throw new Error("An administrator must configure Gmail Pub/Sub first");
          source.gmail = await deps.gmailClient.watch(loop.owner);
          source.nextWatchAt = Date.now() + 86_400_000;
        } else {
          source.secret = input.kind === "slack" ? input.secret!.trim() : randomBytes(32).toString("hex");
          if (input.kind === "slack") {
            source.teamId = input.teamId;
            source.channels = [...new Set(input.channels!)];
          }
        }
        await deps.sources.put(source.id, source);
        return source;
      });
    },
    async setEnabled(loopId: string, id: string, enabled: boolean) {
      return deps.lock.withLock(`loop-ingress:${id}`, async () => {
        const source = await deps.sources.get(id);
        if (!source || source.loopId !== loopId) throw new Error("No such ingestion source");
        if (enabled && !(await deps.enabledFor(source.owner)))
          throw new Error("Event ingestion is not enabled for this owner");
        if (enabled && source.kind === "gmail") {
          if (!deps.gmailClient) throw new Error("Gmail Pub/Sub is not configured");
          const watch = await deps.gmailClient.watch(source.owner);
          if (source.gmail && watch.email !== source.gmail.email) throw new Error("Connected Gmail account changed");
          await deps.sources.merge(id, {
            gmail: { ...watch, historyId: source.gmail?.historyId ?? watch.historyId },
            nextWatchAt: Date.now() + 86_400_000,
          });
        }
        await deps.sources.merge(id, { enabled });
      });
    },
    async receive(
      id: string,
      request: { headers: VerifierInput["headers"]; rawBody: string },
    ): Promise<{ status: number; body: string }> {
      if (Buffer.byteLength(request.rawBody) > 64_000)
        return { status: 413, body: "Event payload must be under 64 KB" };
      if (id === "gmail") {
        const authorization = request.headers.authorization;
        if (
          !deps.gmailConfig ||
          !(await (deps.verifyGoogle ?? verifyGmailPush)(
            typeof authorization === "string" ? authorization : undefined,
            deps.gmailConfig,
          ))
        )
          return { status: 401, body: "Invalid Pub/Sub identity" };
        let notification: Record<string, unknown>;
        try {
          const envelope = JSON.parse(request.rawBody);
          if (typeof envelope.message?.data !== "string") throw new Error("Missing data");
          notification = JSON.parse(Buffer.from(envelope.message.data, "base64").toString());
          if (typeof notification.emailAddress !== "string" || !/^\d+$/.test(String(notification.historyId)))
            throw new Error("Invalid notification");
        } catch {
          return { status: 400, body: "Invalid Gmail notification" };
        }
        const sources = (await deps.sources.all()).filter(
          (source) =>
            source.enabled &&
            source.kind === "gmail" &&
            source.gmail?.email === String(notification.emailAddress).toLowerCase(),
        );
        for (const source of sources)
          if (await deps.enabledFor(source.owner))
            await enqueue(source, String(notification.historyId), { historyId: String(notification.historyId) });
        return { status: 202, body: "Accepted" };
      }
      const source = await deps.sources.get(id);
      if (!source?.enabled || !(await deps.enabledFor(source.owner)) || source.kind === "gmail")
        return { status: 404, body: "Not found" };
      const verifier = getVerifier(source.kind === "slack" ? "slack" : "hmac-sha256")!;
      const input = { ...request, secret: source.secret };
      if (!verifier.verify(input)) return { status: 401, body: "Invalid signature" };
      let payload: unknown;
      try {
        payload = JSON.parse(request.rawBody);
      } catch {
        return { status: 400, body: "JSON body required" };
      }
      const handshake = verifier.handshake?.(input, payload);
      if (handshake !== undefined && handshake !== null) return { status: 200, body: handshake };
      const deliveryId = verifier.deliveryId(input);
      let entry: IngestEntryInput;
      if (source.kind === "slack") {
        if (!isObj(payload) || payload.team_id !== source.teamId || !isObj(payload.event))
          return { status: 200, body: "Skipped" };
        const event = payload.event;
        if (
          event.type !== "message" ||
          event.subtype ||
          event.bot_id ||
          typeof event.channel !== "string" ||
          !source.channels?.includes(event.channel) ||
          typeof event.ts !== "string" ||
          typeof event.user !== "string" ||
          typeof event.text !== "string" ||
          !event.text.trim()
        )
          return { status: 200, body: "Skipped" };
        const at = Number(event.ts) * 1000;
        if (!Number.isFinite(at) || at <= 0) return { status: 400, body: "Invalid Slack timestamp" };
        const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : undefined;
        entry = {
          loopId: source.loopId,
          source: "slack",
          dedupeKey: slackConversationRef(event.channel, event.ts, threadTs),
          summary: event.text.slice(0, 500),
          sourceAt: at,
          sourcePayload: {
            source: "slack",
            title: event.channel,
            from: event.user,
            snippet: event.text.slice(0, 10_000),
            receivedAt: at,
            slack: { channelId: event.channel, ts: event.ts, ...(threadTs ? { threadTs } : {}) },
          },
        };
      } else {
        entry = {
          loopId: source.loopId,
          source: "webhook",
          dedupeKey: `${source.id}:${deliveryId}`,
          summary: isObj(payload) && typeof payload.title === "string" ? payload.title.slice(0, 300) : "Webhook event",
          sourceAt: Date.now(),
          sourcePayload: { event: payload },
        };
      }
      await enqueue(source, deliveryId, { entries: [entry] });
      return { status: 202, body: "Accepted" };
    },
    async maintain() {
      if (Date.now() >= nextCleanupAt) {
        for (const delivery of await deps.deliveries.select({ omit: ["entries"] }))
          if (delivery.completedAt && delivery.completedAt < Date.now() - 30 * 86_400_000)
            await deps.deliveries.delete(delivery.id);
        nextCleanupAt = Date.now() + 86_400_000;
      }
      const sources = await deps.sources.all();
      for (const source of sources) {
        if (!source.enabled || !(await deps.enabledFor(source.owner))) continue;
        if (source.kind === "gmail" && deps.gmailClient && (source.nextWatchAt ?? 0) <= Date.now()) {
          await deps.lock.withLock(`loop-ingress:${source.id}`, async () => {
            const current = await deps.sources.get(source.id);
            if (!current?.enabled || (current.nextWatchAt ?? 0) > Date.now()) return;
            try {
              const watch = await deps.gmailClient!.watch(source.owner);
              if (current.gmail && watch.email !== current.gmail.email)
                throw new Error("Connected Gmail account changed");
              await deps.sources.merge(source.id, {
                gmail: { ...watch, historyId: current.gmail?.historyId ?? watch.historyId },
                nextWatchAt: Date.now() + 86_400_000,
                lastError: undefined,
              });
              await enqueue(source, `reconcile:${Date.now()}`, { historyId: watch.historyId });
            } catch (error) {
              await deps.sources.merge(source.id, { lastError: errMessage(error), nextWatchAt: Date.now() + 300_000 });
            }
          });
        }
        if (source.kind === "gmail" && (source.nextReconcileAt ?? 0) <= Date.now()) {
          await enqueue(source, `reconcile:${Math.floor(Date.now() / 600_000)}`, {});
          await deps.sources.merge(source.id, { nextReconcileAt: Date.now() + 600_000 });
        }
      }
      for (const source of sources) {
        if (source.enabled) await process(source.id).catch((error) => swallow("Loop ingestion", error));
      }
    },
    process,
  };
}

export type LoopIngressService = ReturnType<typeof createLoopIngress>;
