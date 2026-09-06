import type { ActorAssertion } from "./identity.ts";

export function parseAllowFrom(raw: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const entry = part.trim().toLowerCase().replace(/^@+/, "");
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

export function normalizeAllowFrom(entries: readonly unknown[] | undefined): string[] {
  if (!entries) return [];
  return parseAllowFrom(entries.filter((e) => typeof e === "string").join(","));
}

export type ActorGate = (actor: ActorAssertion) => boolean;

export function createActorGate(entries: readonly string[] | undefined): ActorGate | undefined {
  if (!entries?.length) return undefined;
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const entry of entries) {
    if (entry.includes("@")) emails.add(entry);
    else domains.add(entry);
  }
  return (actor: ActorAssertion): boolean => {
    if (actor.isBot || actor.isExternalGuest) return false;
    const email = actor.externalId.trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at <= 0) return false;
    if (emails.has(email)) return true;
    return domains.has(email.slice(at + 1));
  };
}

export interface DenyResponder {
  message: string;
  shouldSend(key: string): boolean;
}

export function createDenyResponder(message: string | undefined, ttlMs = 60 * 60_000): DenyResponder | undefined {
  const text = message?.trim();
  if (!text) return undefined;
  const lastSent = new Map<string, number>();
  return {
    message: text,
    shouldSend(key: string): boolean {
      const now = Date.now();
      const prev = lastSent.get(key);
      if (prev !== undefined && now - prev < ttlMs) return false;
      if (lastSent.size >= 5000) {
        for (const [k, at] of lastSent) {
          if (now - at >= ttlMs) lastSent.delete(k);
        }
        if (lastSent.size >= 5000) lastSent.clear();
      }
      lastSent.set(key, now);
      return true;
    },
  };
}
