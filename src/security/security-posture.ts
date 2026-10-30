export const SECURITY_POSTURES = ["dangerous", "auto", "strict"] as const;
export type SecurityPosture = (typeof SECURITY_POSTURES)[number];

type ToolApprovalBehavior = "none" | "all";

export interface ResolvedSecurityPolicy {
  readonly posture: SecurityPosture;
  readonly denyPrivateNetworks: boolean;
  readonly toolApprovals: ToolApprovalBehavior;
}

const POSTURE_POLICIES: Record<SecurityPosture, Omit<ResolvedSecurityPolicy, "posture">> = {
  dangerous: { toolApprovals: "none", denyPrivateNetworks: false },
  auto: { toolApprovals: "none", denyPrivateNetworks: true },
  strict: { toolApprovals: "all", denyPrivateNetworks: false },
};

export function resolveSecurityPolicy(posture: SecurityPosture): ResolvedSecurityPolicy {
  return { posture, ...POSTURE_POLICIES[posture] };
}

const POSTURE_RANK: Record<SecurityPosture, number> = {
  dangerous: 0,
  auto: 1,
  strict: 2,
};

export function parseSecurityPosture(value: unknown): SecurityPosture | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (SECURITY_POSTURES as readonly string[]).includes(normalized) ? (normalized as SecurityPosture) : null;
}

export function composeSecurityPosture(orgFloor: SecurityPosture, scope?: SecurityPosture | null): SecurityPosture {
  if (!scope || POSTURE_RANK[orgFloor] >= POSTURE_RANK[scope]) return orgFloor;
  return scope;
}
