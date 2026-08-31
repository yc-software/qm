import type { McpAuthorityPayload } from "./mcp-authority.ts";
import type { QmAnalyticsNativeCard } from "../types.ts";

interface ParsedAnalyticsDelivery {
  card: QmAnalyticsNativeCard;
  unsignedCard: QmAnalyticsNativeCard;
  idempotencyKey: string;
}

const RECEIPT = /^[a-f0-9]{64}$/;
const SOURCES = new Set(["posthog", "clarify", "brain", "calendar", "human_receipt"]);
const TOPICS = new Set([
  "usage",
  "funnel",
  "error",
  "opportunity",
  "meeting",
  "recipient",
  "commitment",
  "pricing",
  "history",
]);
const CONFIDENCE = new Set(["high", "medium", "low"]);

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function boundedLine(value: unknown, maximum: number): value is string {
  return boundedText(value, maximum) && !/[\r\n]/.test(value);
}

function analyticsNativeCardFallbackText(value: string): string {
  return value
    .replace(/\b(https?|mailto):/gi, "$1:\u200b")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b");
}

function exactAuthority(value: unknown, authority: McpAuthorityPayload): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    exactKeys(record, [
      "organizationId",
      "principalId",
      "slackTeamId",
      "slackUserId",
      "slackChannelId",
      "slackConversationType",
      "slackMessageTs",
      "slackThreadTs",
      "jti",
    ]) &&
    record.organizationId === authority.organizationId &&
    record.principalId === authority.principalId &&
    record.slackTeamId === authority.slackTeamId &&
    record.slackUserId === authority.slackUserId &&
    record.slackChannelId === authority.slackChannelId &&
    record.slackConversationType === authority.slackConversationType &&
    record.slackMessageTs === authority.slackMessageTs &&
    record.slackThreadTs === authority.slackThreadTs &&
    record.jti === authority.jti
  );
}

export function parseAnalyticsNativeDelivery(
  structured: unknown,
  authority: McpAuthorityPayload,
): ParsedAnalyticsDelivery | null {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return null;
  const envelope = structured as Record<string, unknown>;
  if (!exactKeys(envelope, ["version", "delivery"]) || envelope.version !== 1) return null;
  if (!envelope.delivery || typeof envelope.delivery !== "object" || Array.isArray(envelope.delivery)) return null;
  const delivery = envelope.delivery as Record<string, unknown>;
  if (
    !exactKeys(delivery, [
      "version",
      "renderer",
      "receiptId",
      "authority",
      "fallbackText",
      "heading",
      "question",
      "findings",
      "confidenceNotes",
      "nextStep",
      "proposedActions",
    ]) ||
    delivery.version !== 1 ||
    delivery.renderer !== "qm.analytics.card.v1" ||
    typeof delivery.receiptId !== "string" ||
    !RECEIPT.test(delivery.receiptId) ||
    !exactAuthority(delivery.authority, authority) ||
    !boundedText(delivery.fallbackText, 2_900) ||
    !boundedLine(delivery.heading, 150) ||
    !boundedText(delivery.question, 2_000) ||
    !boundedText(delivery.nextStep, 1_000) ||
    !Array.isArray(delivery.findings) ||
    delivery.findings.length > 8 ||
    !Array.isArray(delivery.confidenceNotes) ||
    delivery.confidenceNotes.length > 5 ||
    delivery.confidenceNotes.some((value) => !boundedText(value, 500)) ||
    !Array.isArray(delivery.proposedActions) ||
    delivery.proposedActions.length > 4 ||
    delivery.proposedActions.some((value) => !boundedText(value, 1_000))
  ) {
    return null;
  }
  const findings: QmAnalyticsNativeCard["findings"] = [];
  for (const value of delivery.findings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const finding = value as Record<string, unknown>;
    if (
      !exactKeys(finding, ["source", "topic", "text", "confidence"]) ||
      typeof finding.source !== "string" ||
      !SOURCES.has(finding.source) ||
      typeof finding.topic !== "string" ||
      !TOPICS.has(finding.topic) ||
      !boundedText(finding.text, 2_000) ||
      typeof finding.confidence !== "string" ||
      !CONFIDENCE.has(finding.confidence)
    ) {
      return null;
    }
    findings.push(finding as QmAnalyticsNativeCard["findings"][number]);
  }
  const card: QmAnalyticsNativeCard = {
    version: 1,
    renderer: "qm.analytics.card.v1",
    receiptId: delivery.receiptId,
    fallbackText: analyticsNativeCardFallbackText(delivery.fallbackText),
    heading: delivery.heading,
    question: delivery.question,
    findings,
    confidenceNotes: [...delivery.confidenceNotes] as string[],
    nextStep: delivery.nextStep,
    proposedActions: [...delivery.proposedActions] as string[],
  };
  return {
    card,
    unsignedCard: { ...card, fallbackText: delivery.fallbackText },
    idempotencyKey: `mcp-card:${card.receiptId}`,
  };
}
