import { createHash } from "node:crypto";
import type { SlackUser, ActorAssertion } from "./identity.ts";

export interface ExternalSlackAccess {
  companyDomains: string[];
  serviceCredentials: string[];
}

export function parseExternalSlackAccess(value: unknown): ExternalSlackAccess | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("externalAccess must be an object");
  const raw = value as Record<string, unknown>;
  const domains = raw.companyDomains;
  const services = raw.serviceCredentials ?? [];
  if (
    !Array.isArray(domains) ||
    !domains.length ||
    domains.some((d) => typeof d !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(d))
  )
    throw new Error("externalAccess.companyDomains must contain exact company email domains");
  if (!Array.isArray(services) || services.some((s) => typeof s !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(s)))
    throw new Error("externalAccess.serviceCredentials must contain credential slugs");
  return {
    companyDomains: [...new Set(domains.map((d: string) => d.toLowerCase()))].sort(),
    serviceCredentials: [...new Set(services as string[])].sort(),
  };
}

export function companySlackActor(user: SlackUser | undefined, policy: ExternalSlackAccess): ActorAssertion {
  const email = user?.profile?.email?.trim().toLowerCase() ?? "";
  const parts = email.split("@");
  const internal = Boolean(
    user?.id &&
    !user.deleted &&
    !user.is_bot &&
    parts.length === 2 &&
    parts[0] &&
    policy.companyDomains.includes(parts[1]!),
  );
  return {
    externalId: internal ? email : String(user?.id ?? "slack-unknown"),
    isExternalGuest: !internal,
    ...(user?.is_bot ? { isBot: true } : {}),
    ...(user?.profile?.display_name || user?.real_name || user?.name
      ? { displayName: user.profile?.display_name || user.real_name || user.name }
      : {}),
  };
}

export function externalSlackNamespace(teamId: string, policy: ExternalSlackAccess): string {
  const hash = createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 16);
  return `external-slack:${teamId}:${hash}`;
}

export const PRIVATE_CONTINUATION_INSTRUCTION =
  "This Slack workspace has an external audience. Answer and run code here only with the explicitly available external-safe services. Before any personal memory, files, account, calendar, email, or confidential company service is needed, end this turn with [[continue-private: a concise description of the remaining work]]. The platform acknowledges here and automatically continues in the requesting employee's private DM with this request and its channel context. Do not ask them to repeat it or ask for an additional handoff approval. Do not use ask-agent, and do not promise a result back to this channel. Private results stay in the DM. This directive can continue only the current requester's work, never another person's.";

export function extractPrivateContinuation(text: string): { text: string; task?: string } {
  if (!/\[\[continue-private:/i.test(text)) return { text };
  const pattern = /\[\[continue-private:([\s\S]*?)\]\]/gi;
  const tasks = [...text.matchAll(pattern)].map((m) => m[1]!.trim()).filter(Boolean);
  const cleaned = text
    .replace(pattern, "")
    .replace(/\[\[continue-private:[\s\S]*$/gi, "")
    .trim();
  return { text: cleaned, ...(tasks.length ? { task: tasks[0]!.slice(0, 16_000) } : {}) };
}
