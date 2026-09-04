import type {
  CandidateDestination,
  CommandApprovalGrant,
  EgressPolicy,
  Principal,
  Resolution,
  ScopeId,
  SessionEntry,
  TurnRequest,
  ActorAssertion,
} from "../../types.ts";
import { parseScopeId } from "../../types.ts";
import { turnOriginRequestFields } from "../turn-origin.ts";
import type { DirectoryStore } from "../../directory/directory-store.ts";
import { isOverheardEntry } from "../../sessions/session-store.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { writableMemoryScope } from "../../memory/policy.ts";
import { collectBytes } from "../../util/bytes.ts";
import type { SkillBundle, SkillBundleStore } from "../../skills/skill-bundle-store.ts";
import type { SkillResolution } from "../../skills/skill-store.ts";
import type { FileArtifact, FileArtifactStore } from "../../files/file-artifact-store.ts";
import { hostMatches } from "../../resolution/egress-policy.ts";
import { isVisionAttachment, MAX_VISION_IMAGE_BYTES } from "../attachments.ts";
import { swallow } from "../../util/errors.ts";
import { hashId } from "../../util/crypto.ts";
import type { OrchestratorInput } from "./types.ts";

export const MAX_AUTO_ATTACHMENT_SCREEN_BYTES = 12_000;

export function isScreenableTextAttachment(mimetype: string): boolean {
  const mime = mimetype.split(";", 1)[0]!.trim().toLowerCase();
  return (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/yaml",
      "application/x-yaml",
    ].includes(mime)
  );
}

export function stripAckPrefix(text: string, ack: string | undefined): string {
  if (!text || !ack) return text;
  const lead = text.trimStart();
  if (!lead.startsWith(ack)) return text;
  return lead.slice(ack.length).trimStart();
}

export function headLooksLikeText(head: Buffer): boolean {
  if (head.length === 0) return true;
  if (head.includes(0)) return false;
  let suspicious = 0;
  for (const ch of head.toString("utf8")) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) suspicious++;
  }
  return suspicious / head.length < 0.1;
}

export async function loadTapeImage(
  files: FileArtifactStore,
  artifactRef: string,
  remainingBytes: number,
  authorize: (artifact: FileArtifact) => boolean | Promise<boolean>,
) {
  const artifact = await files.get(artifactRef);
  if (
    !artifact ||
    !(await authorize(artifact)) ||
    !isVisionAttachment(artifact) ||
    artifact.sizeBytes <= 0 ||
    !artifact.sha256
  )
    return null;
  if (artifact.sizeBytes > MAX_VISION_IMAGE_BYTES || artifact.sizeBytes > remainingBytes) return "over-budget";
  const opened = await files.open(artifactRef);
  if (!opened) return null;
  if (
    opened.sizeBytes !== artifact.sizeBytes ||
    opened.artifact.sizeBytes !== artifact.sizeBytes ||
    opened.artifact.sha256 !== artifact.sha256 ||
    opened.artifact.mimetype !== artifact.mimetype
  ) {
    opened.stream.destroy();
    return null;
  }
  const bytes = await collectBytes(opened.stream, { maxBytes: Math.min(MAX_VISION_IMAGE_BYTES, remainingBytes) });
  if (bytes.sizeBytes !== artifact.sizeBytes || bytes.sha256 !== artifact.sha256) return null;
  return { data: bytes.data.toString("base64"), mimeType: artifact.mimetype, sizeBytes: bytes.sizeBytes };
}

export function visibleSkillScopes(resolution: Resolution, scopeId: ScopeId): ScopeId[] {
  const memoryScopeId = writableMemoryScope(resolution.layers, scopeId);
  const teamScopes = resolution.layers
    .filter((l) => l.mode === "ro" && l.scopeId !== resolution.orgScopeId)
    .map((l) => l.scopeId);
  return [memoryScopeId, ...teamScopes, resolution.orgScopeId];
}

const CONNECTOR_SKILL_PROVIDERS: Readonly<Record<string, string>> = {
  dropbox: "dropbox",
  "email-draft-in-voice": "google",
  "email-voice-profile": "google",
  "google-drive-sheets": "google",
  "google-workspace": "google",
  linear: "linear",
  "morning-digest": "x",
  "slack-drafts": "slack",
  x: "x",
};

export function filterConnectorSkills(
  resolved: SkillResolution[],
  availableProviders: readonly string[],
): SkillResolution[] {
  const available = new Set(availableProviders);
  return resolved.filter((entry) => {
    const provider = entry.skill ? CONNECTOR_SKILL_PROVIDERS[entry.skill.manifest.name] : undefined;
    return !provider || available.has(provider);
  });
}

export async function loadActiveBundles(store: SkillBundleStore, resolved: SkillResolution[]): Promise<SkillBundle[]> {
  const packIds = [...new Set(resolved.map((r) => r.skill?.pack?.packId).filter((id): id is string => Boolean(id)))];
  const bundles = await Promise.all(packIds.map((id) => store.get(id)));
  return bundles.filter((b): b is SkillBundle => b !== null);
}

export function egressClaimAllowingControlPlane(
  egress: EgressPolicy,
  apiBaseUrl: string,
  denyPrivateNetworks = false,
): EgressPolicy | undefined {
  const allowedHosts = egress.allowedHosts ?? [];
  const deniedHosts = egress.deniedHosts ?? [];
  if (allowedHosts.length === 0 && deniedHosts.length === 0 && !denyPrivateNetworks) return undefined;
  let coreHost = "";
  if (apiBaseUrl) {
    try {
      coreHost = new URL(apiBaseUrl).hostname;
    } catch (e) {
      swallow("orchestrator: apiBaseUrl parse", e);
    }
  }
  const safeDenied = coreHost ? deniedHosts.filter((d) => !hostMatches(coreHost, d)) : deniedHosts;
  const allowedWithCore =
    coreHost && allowedHosts.length > 0 && !allowedHosts.includes(coreHost)
      ? [...allowedHosts, coreHost]
      : allowedHosts;
  const claim: EgressPolicy = {
    allowedHosts: allowedWithCore,
    ...(denyPrivateNetworks ? { denyPrivateNetworks: true } : {}),
    ...(denyPrivateNetworks && coreHost ? { privateNetworkAllowedHosts: [coreHost] } : {}),
    ...(safeDenied.length ? { deniedHosts: safeDenied } : {}),
  };
  return claim.allowedHosts.length || claim.deniedHosts?.length || claim.denyPrivateNetworks ? claim : undefined;
}

export function stripTurnBoilerplate(text: string): string {
  const kept = text
    .split("\n\n")
    .filter((p) => !/^\s*\[/.test(p))
    .join("\n\n")
    .trim();
  return kept || text.trim();
}

export function renderTitleTranscript(entries: SessionEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.type !== "user" && e.type !== "assistant") continue;
    if (isOverheardEntry(e)) continue;
    const raw = (e.payload as { text?: string } | null)?.text?.trim();
    if (!raw) continue;
    const text = e.type === "user" ? stripTurnBoilerplate(raw) : raw;
    if (!text) continue;
    lines.push(`${e.type === "user" ? "User" : "Assistant"}:\n${text}`);
    if (lines.length >= 6) break;
  }
  return lines.join("\n\n");
}

export async function recentPrincipalDeliveryNote(
  deliveries: DeliveryStore | undefined,
  threadRef: string,
): Promise<string> {
  if (!deliveries) return "";
  const recent = await deliveries.listByRecipientThread(threadRef, { limit: 5 });
  if (!recent.length) return "";
  const lines = recent.map((d) => {
    const from = d.destination.onBehalfOf ? ` from ${d.destination.onBehalfOf}` : "";
    const trigger = d.provenance?.trigger ? ` [${d.provenance.trigger}]` : "";
    const text = d.text.trim().replace(/\s+/g, " ");
    return `- ${new Date(d.deliveredAt ?? d.createdAt).toISOString()}${trigger}${from}: ${text}`;
  });
  return [
    "Recent agent-initiated deliveries to this conversation:",
    ...lines,
    "These are delivery events, not prior assistant turns. Use them as context if the user replies about them.",
  ].join("\n");
}

function principalAssertion(p: Principal): ActorAssertion {
  return {
    externalId: p.id,
    ...(p.type === "guest" ? { isExternalGuest: true } : {}),
    ...(p.teamIds ? { teamIds: p.teamIds } : {}),
    ...(p.displayName ? { displayName: p.displayName } : {}),
  };
}

export async function conversationLabelFor(
  directory: DirectoryStore | undefined,
  conversationScope: ScopeId,
  channelName: string | undefined,
): Promise<string | undefined> {
  if (channelName) return `#${channelName}`;
  const { kind, ref } = parseScopeId(conversationScope);
  if (kind !== "channel" || !directory) return undefined;
  const resolved = await directory.resolveChannel(ref).catch(() => ({ kind: "none" as const }));
  return resolved.kind === "one" && resolved.channel.channelId.toLowerCase() === ref.toLowerCase()
    ? `#${resolved.channel.name}`
    : undefined;
}

export function replayableRequest(input: OrchestratorInput): TurnRequest {
  const c = input.conversation;
  return {
    surface: input.surface ?? "unknown",
    ...(input.scopeVersion ? { scopeVersion: input.scopeVersion } : {}),
    ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
    ...(input.deliveryCandidates?.length ? { deliveryCandidates: input.deliveryCandidates } : {}),
    actor: principalAssertion(input.actor),
    conversation: {
      kind: c.kind,
      threadRef: c.threadRef,
      ...(c.channelRef ? { channelRef: c.channelRef } : {}),
      ...(c.channelName ? { channelName: c.channelName } : {}),
      audience: c.audience.map(principalAssertion),
      ...(c.isPrivate !== undefined ? { isPrivate: c.isPrivate } : {}),
      ...(c.isMpim !== undefined ? { isMpim: c.isMpim } : {}),
      ...(c.publishMembers ? { publishMembers: c.publishMembers.map(principalAssertion) } : {}),
    },
    text: input.text,
    ...(input.gatewayContext ? { gatewayContext: input.gatewayContext } : {}),
    ...turnOriginRequestFields(input.origin),
    ...(input.conversationHeader ? { conversationHeader: input.conversationHeader } : {}),
    ...(input.priorTurns?.length ? { priorTurns: input.priorTurns } : {}),
    ...(input.overheard?.length ? { overheard: input.overheard } : {}),
    ...(input.detectContext ? { detectContext: input.detectContext } : {}),
    ...(input.detectOpener ? { detectOpener: input.detectOpener } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.harness ? { harness: input.harness } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.skipMemory ? { skipMemory: true } : {}),
    ...(input.surfaceTools ? { surfaceTools: true } : {}),
    ...(input.addressed ? { addressed: true } : {}),
    ...(input.envelopeWrapped ? { envelopeWrapped: true } : {}),
    ...(input.displayText ? { displayText: input.displayText } : {}),
    ...(typeof input.turnWallClockMs === "number" ? { turnWallClockMs: input.turnWallClockMs } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
  };
}

export function approvalGrantId(
  grant: Pick<CommandApprovalGrant, "actorId" | "command" | "scope" | "sessionId" | "approvalKey">,
): string {
  return hashId([grant.actorId, grant.scope, grant.sessionId ?? "*", grant.approvalKey ?? grant.command], 24);
}

function candidateKey(target: string, audienceScopeId: ScopeId): string {
  return hashId([target, audienceScopeId]);
}

export function replaceThreadSegment(target: string, threadTs: string): string {
  const i = target.lastIndexOf(":");
  const channel = i < 0 ? target : target.slice(0, i);
  return `${channel}:${threadTs}`;
}

export function deliveryCandidatesFor(
  surface: string | undefined,
  deliveryTarget: string | undefined,
  surfaceCandidates: { target: string; label: string }[] | undefined,
  sessionScopeId: ScopeId,
): { candidates: CandidateDestination[]; defaultKey?: string } {
  if (!surface) return { candidates: [] };
  let raw: { target: string; label: string }[] = [];
  if (surfaceCandidates && surfaceCandidates.length > 0) raw = surfaceCandidates;
  else if (deliveryTarget) raw = [{ target: deliveryTarget, label: "this conversation" }];
  const seen = new Set<string>();
  const candidates: CandidateDestination[] = [];
  for (const c of raw) {
    const key = candidateKey(c.target, sessionScopeId);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ type: surface, target: c.target, audienceScopeId: sessionScopeId, key, label: c.label });
  }
  const defaultKey = candidates.find((c) => c.target === deliveryTarget)?.key ?? candidates[0]?.key;
  return { candidates, ...(defaultKey ? { defaultKey } : {}) };
}
