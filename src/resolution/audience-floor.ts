import type { Principal, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import type { ScopedConfigStore } from "./config-store.ts";

function principalScopes(p: Principal, orgScope: ScopeId, contextScope?: ScopeId): ScopeId[] {
  return [
    ...new Set(
      [orgScope, contextScope, scopeId("personal", p.id), ...(p.teamIds ?? []).map((t) => scopeId("team", t))].filter(
        (s): s is ScopeId => !!s,
      ),
    ),
  ];
}

function principalHosts(
  p: Principal,
  config: ScopedConfigStore,
  orgScope: ScopeId,
  contextScope: ScopeId | undefined,
  list: "allowedHosts" | "deniedHosts",
): Set<string> {
  const hosts = new Set<string>();
  for (const s of principalScopes(p, orgScope, contextScope))
    for (const h of config.getEgress(s)?.[list] ?? []) hosts.add(h);
  return hosts;
}

export function audienceEgressFloor(
  audience: Principal[],
  config: ScopedConfigStore,
  orgScope: ScopeId,
  contextScope?: ScopeId,
): string[] {
  if (audience.length === 0) return [];
  const sets = audience.map((p) => principalHosts(p, config, orgScope, contextScope, "allowedHosts"));
  const [first, ...rest] = sets;
  return [...(first ?? new Set<string>())].filter((h) => rest.every((s) => s.has(h)));
}

export function audienceDeniedFloor(
  audience: Principal[],
  config: ScopedConfigStore,
  orgScope: ScopeId,
  contextScope?: ScopeId,
): string[] {
  const out = new Set<string>();
  for (const p of audience)
    for (const h of principalHosts(p, config, orgScope, contextScope, "deniedHosts")) out.add(h);
  return [...out];
}
