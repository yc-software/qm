import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import type { Delivery, DeliveryHold, Destination } from "../../types.ts";
import { parseScopeId } from "../../types.ts";
import { samePerson } from "../../directory/person.ts";
import { combineSendNow, createFireHandler, UNCHANGED_REASON, type FireReport } from "./fire-handler.ts";

export const HOLD_WINDOW_MS = 10 * 60_000;
const DIGEST_HOURS = [9, 17];
const DIGEST_TIME_ZONE = "America/Los_Angeles";
const URGENT_MARKER = "[urgent]";

export function isOwnInbox(owner: string, destination: Destination): boolean {
  if (destination.type === "principal")
    return samePerson(destination.target, owner) && samePerson(destination.onBehalfOf ?? owner, owner);
  if (destination.type !== "web" || !destination.audienceScopeId) return false;
  const { kind, ref } = parseScopeId(destination.audienceScopeId);
  return kind === "personal" && samePerson(ref, owner);
}

export function holdReply(text: string, now: number): { text: string; hold: DeliveryHold } {
  const trimmed = text.trimStart();
  const urgent = trimmed.toLowerCase().startsWith(URGENT_MARKER);
  return urgent
    ? { text: trimmed.slice(URGENT_MARKER.length).trimStart(), hold: { kind: "triage", until: now } }
    : { text, hold: { kind: "triage", until: now + HOLD_WINDOW_MS } };
}

function zonedHour(at: number): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: DIGEST_TIME_ZONE, hour: "numeric", hourCycle: "h23" })
    .formatToParts(at)
    .find((p) => p.type === "hour")!.value;
  return Number(hour);
}

function nextDigestAt(now: number): number {
  const startOfHour = Math.floor(now / 3_600_000) * 3_600_000;
  for (let at = startOfHour + 3_600_000; ; at += 3_600_000) if (DIGEST_HOURS.includes(zonedHour(at))) return at;
}

function report(d: Delivery): FireReport {
  return {
    cronId: d.sourceCronId ?? d.id,
    cronTitle: d.provenance?.sourceTitle ?? d.sourceCronId ?? "Scheduled task",
    at: d.createdAt,
    text: d.text,
    ...(d.hold && d.hold.until <= d.createdAt ? { urgent: true } : {}),
  };
}

function handlerSend(first: Delivery, latest: Delivery, key: string, text: string, hold?: DeliveryHold) {
  return {
    destination: latest.destination,
    text,
    idempotencyKey: key,
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey: key,
      sourceScopeId: first.provenance?.sourceScopeId ?? latest.provenance!.sourceScopeId,
      sourceThreadRef: `cron-handler:${first.destination.type}:${first.destination.target}`,
    },
    ...(hold ? { hold } : {}),
  };
}

export async function sweepHeldDeliveries(
  deliveries: DeliveryStore,
  model: (prompt: string) => Promise<string>,
  now: number,
): Promise<void> {
  const inboxes = new Map<string, Delivery[]>();
  for (const d of await deliveries.listHeld()) {
    const key = `${d.destination.type}\u0000${d.destination.target}`;
    inboxes.set(key, [...(inboxes.get(key) ?? []), d]);
  }
  for (const rows of inboxes.values()) {
    const triage = rows.filter((d) => d.hold!.kind === "triage");
    const digest = rows.filter((d) => d.hold!.kind === "digest" && d.hold!.until <= now);
    if (triage.length && Math.min(...triage.map((d) => d.hold!.until)) <= now) {
      const first = triage[0]!;
      const latest = triage.at(-1)!;
      const lastText = Object.fromEntries(
        await deliveries.lastCronTexts([...new Set(triage.flatMap((d) => d.sourceCronId ?? []))]),
      );
      const handler = createFireHandler({ model, state: { lastText, digest: [] } });
      const decision = await handler.handle(triage.map(report), now);
      if (decision.sendNow.length)
        await deliveries.enqueue(
          handlerSend(first, latest, `cron-handler:${first.id}:now`, combineSendNow(decision.sendNow)),
        );
      const digestHold: DeliveryHold = { kind: "digest", until: nextDigestAt(now) };
      for (const [i, item] of decision.digestItems.entries())
        await deliveries.enqueue(handlerSend(first, latest, `cron-handler:${first.id}:digest:${i}`, item, digestHold));
      const reasons = new Map(decision.dropped.map((d) => [d.cronId, d.reason || UNCHANGED_REASON]));
      for (const d of triage) {
        const reason = reasons.get(report(d).cronId);
        await deliveries.settleHeld([d.id], now, reason === undefined ? undefined : `cron handler: ${reason}`);
      }
    }
    if (digest.length) {
      const handler = createFireHandler({ model, state: { lastText: {}, digest: digest.map((d) => d.text) } });
      const text = await handler.flushDigest(now);
      if (text) await deliveries.enqueue(handlerSend(digest[0]!, digest.at(-1)!, `cron-digest:${digest[0]!.id}`, text));
      await deliveries.settleHeld(
        digest.map((d) => d.id),
        now,
      );
    }
  }
}
