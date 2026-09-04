import type { EgressPolicy } from "../types.ts";

function normalizeHost(host: string): string {
  const s = host
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/\.$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  if (!s) return "";
  const isIPv6 = (s.match(/:/g)?.length ?? 0) >= 2;
  try {
    return new URL(`https://${isIPv6 ? `[${s}]` : s}`).hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  } catch {
    return s;
  }
}

export function parseEgressPolicy(input: unknown): { policy: EgressPolicy } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { error: "egress requires { allowedHosts, deniedHosts }" };
  const value = input as { allowedHosts?: unknown; deniedHosts?: unknown };
  const parseList = (name: "allowedHosts" | "deniedHosts", raw: unknown): string[] | { error: string } => {
    if (!Array.isArray(raw)) return { error: `${name} must be an array of host names` };
    const hosts: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== "string") return { error: `${name} must contain only host names` };
      const candidate = item.trim();
      if (!candidate) continue;
      if (/\s|\*|:\/\/|[/?#@]/.test(candidate))
        return { error: `${candidate} is not a host name; omit schemes, wildcards, ports, paths, and credentials` };
      const colonCount = (candidate.match(/:/g) ?? []).length;
      if (colonCount === 1) return { error: `${candidate} includes a port; enter a host name only` };
      const normalized = normalizeHost(candidate);
      if (
        !normalized ||
        (colonCount < 2 &&
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(normalized))
      ) {
        return { error: `${candidate} is not a valid host name` };
      }
      if (seen.has(normalized)) return { error: `${name} contains duplicate host ${normalized}` };
      seen.add(normalized);
      hosts.push(normalized);
    }
    return hosts;
  };
  const allowedHosts = parseList("allowedHosts", value.allowedHosts ?? []);
  if ("error" in allowedHosts) return allowedHosts;
  const deniedHosts = parseList("deniedHosts", value.deniedHosts ?? []);
  if ("error" in deniedHosts) return deniedHosts;
  const denied = new Set(deniedHosts);
  const overlap = allowedHosts.find((host) => denied.has(host));
  if (overlap) return { error: `${overlap} cannot appear in both allowedHosts and deniedHosts` };
  return { policy: { allowedHosts, deniedHosts } };
}

export function hostMatches(requestHost: string, ruleHost: string): boolean {
  const h = normalizeHost(requestHost);
  const r = normalizeHost(ruleHost);
  if (!h || !r) return false;
  return h === r || h.endsWith(`.${r}`);
}

export function isHostDenied(host: string, deniedHosts: readonly string[] | undefined): boolean {
  return !!deniedHosts && deniedHosts.some((d) => d && hostMatches(host, d));
}

export type EgressVerdict = "ok" | "denied" | "not_allowlisted";

export interface EgressDecision {
  allow: boolean;
  verdict: EgressVerdict;
}

export function egressDecision(host: string, policy: EgressPolicy | undefined): EgressDecision {
  if (!policy) return { allow: true, verdict: "ok" };
  if (isHostDenied(host, policy.deniedHosts)) return { allow: false, verdict: "denied" };
  const allow = policy.allowedHosts ?? [];
  if (allow.length > 0 && !allow.some((rule) => hostMatches(host, rule))) {
    return { allow: false, verdict: "not_allowlisted" };
  }
  return { allow: true, verdict: "ok" };
}
