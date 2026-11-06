import type { FinnyAuditFinding, FinnyFindingPolicy } from "./types.ts";

function nonEmptyText(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Finny ${label} is invalid`);
}

export function assertFinnyFindingPolicy(policy: FinnyFindingPolicy): void {
  nonEmptyText(policy.id, "finding policy ID");
  if (
    !Number.isSafeInteger(policy.maxFindings) ||
    policy.maxFindings < 1 ||
    !Number.isSafeInteger(policy.maxCodeLength) ||
    policy.maxCodeLength < 1 ||
    !Number.isSafeInteger(policy.maxMessageLength) ||
    policy.maxMessageLength < 1
  ) {
    throw new Error("Finny finding policy limit is invalid");
  }
}

export function assertFinnyAuditFindings(findings: readonly FinnyAuditFinding[], policy: FinnyFindingPolicy): void {
  assertFinnyFindingPolicy(policy);
  if (!findings.length || findings.length > policy.maxFindings) {
    throw new Error("Finny audit findings count is invalid");
  }
  for (const finding of findings) {
    nonEmptyText(finding.code, "finding code");
    nonEmptyText(finding.message, "finding message");
    if (finding.code.length > policy.maxCodeLength || finding.message.length > policy.maxMessageLength) {
      throw new Error("Finny audit finding text exceeds policy");
    }
  }
}

export function assertFinnyEscalationReason(reason: string): void {
  nonEmptyText(reason, "escalation reason");
}
