import type {
  Delivery,
  DeliveryProvenance,
  Destination,
  OutgoingAttachment,
  SurfaceContextQuery,
  SurfaceContextResult,
} from "../types.ts";
import { scopeId as makeScopeId } from "../types.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { ChannelResolution, GroupResolution, RecipientResolution } from "../directory/directory-store.ts";
import { isVisible } from "../directory/visibility.ts";
import { swallow } from "../util/errors.ts";

export function principalDestination(target: string, onBehalfOf: string): Destination {
  return { type: "principal", target, audienceScopeId: makeScopeId("personal", target), onBehalfOf };
}

export interface ReachDirectory {
  resolveRecipient(query: string): Promise<RecipientResolution>;
  resolveChannel(query: string): Promise<ChannelResolution>;
  channelMember(channelId: string, principalId: string): Promise<boolean>;
  resolveGroup(participants: readonly string[]): Promise<GroupResolution>;
  groupMember(groupId: string, principalId: string): Promise<boolean>;
  directoryMember(principalId: string): Promise<{ type: string } | null>;
  openGroup?(participants: readonly string[]): Promise<{ groupId: string } | { error: string } | null>;
  registerGroup?(groupId: string, participants: readonly string[]): Promise<void>;
}

const MAX_GROUP_DM_PARTICIPANTS = 8;

function groupTooLarge(): Extract<ReachResolution, { ok: false }> {
  return {
    ok: false,
    status: 400,
    error: "group_too_large",
    message: `a group DM holds at most ${MAX_GROUP_DM_PARTICIPANTS} people including you — use a channel instead`,
  };
}

export async function openGroupViaSurface(
  pull: (query: SurfaceContextQuery) => Promise<SurfaceContextResult | null>,
  participants: readonly string[],
): Promise<{ groupId: string } | { error: string } | null> {
  const result = await pull({ count: 1, openGroup: { participants: [...participants] } });
  if (result?.group?.groupId) return { groupId: result.group.groupId };
  return result?.note ? { error: result.note } : null;
}

async function membershipDenial(
  dir: ReachDirectory,
  authorityId: string,
  room: "channel" | "group",
): Promise<Extract<ReachResolution, { ok: false }>> {
  if (!(await dir.directoryMember(authorityId))) {
    return {
      ok: false,
      status: 403,
      error: "identity_unverified",
      message:
        "I can't confirm your membership here — your account isn't in this workspace's directory, so your login may not be linked to Slack (or it hasn't synced yet). Connecting / signing in with Slack should link it.",
    };
  }
  return {
    ok: false,
    status: 403,
    error: "not_a_member",
    message:
      room === "channel" ? "I can only post to a private channel you're in" : "I can only post to a group DM you're in",
  };
}

export interface ReachTarget {
  recipient?: string;
  channel?: string;
  participants?: readonly string[];
}

export type ReachResolution =
  | {
      ok: true;
      destination: Destination;
      recipient?: { principalId: string; displayName: string };
      channel?: { channelId: string; name: string };
      group?: { groupId: string };
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 502;
      error: string;
      message: string;
      candidates?: Array<Record<string, string>>;
    };

export interface ReachOpts {
  mayOpenGroup?: boolean;
}

export async function resolveReachTarget(
  dir: ReachDirectory,
  target: ReachTarget,
  authorityId: string,
  opts: ReachOpts = {},
): Promise<ReachResolution> {
  const wantsRecipient = typeof target.recipient === "string";
  const wantsChannel = typeof target.channel === "string";
  const wantsGroup = Array.isArray(target.participants);
  if ([wantsRecipient, wantsChannel, wantsGroup].filter(Boolean).length > 1) {
    return {
      ok: false,
      status: 400,
      error: "bad_request",
      message: "specify exactly one of recipient (a teammate), channel, or participants (a group DM)",
    };
  }
  if (wantsRecipient) {
    const r = await dir.resolveRecipient(target.recipient!);
    if (r.kind === "none") {
      return {
        ok: false,
        status: 404,
        error: "recipient_not_found",
        message: `no internal teammate matches "${target.recipient}"`,
      };
    }
    if (r.kind === "ambiguous") {
      return {
        ok: false,
        status: 409,
        error: "ambiguous_recipient",
        message: `"${target.recipient}" matches multiple teammates — pass an exact name or id`,
        candidates: r.candidates.map((c) => ({ principalId: c.principalId, displayName: c.displayName })),
      };
    }
    const rid = r.member.principalId;
    return {
      ok: true,
      destination: principalDestination(rid, authorityId),
      recipient: { principalId: rid, displayName: r.member.displayName },
    };
  }
  if (wantsChannel) {
    const r = await dir.resolveChannel(target.channel!);
    if (r.kind === "none") {
      return {
        ok: false,
        status: 404,
        error: "channel_not_found",
        message: `no channel I'm in matches "${target.channel}"`,
      };
    }
    if (r.kind === "ambiguous") {
      return {
        ok: false,
        status: 409,
        error: "ambiguous_channel",
        message: `"${target.channel}" matches multiple channels — pass an exact name or id`,
        candidates: r.candidates.map((c) => ({ channelId: c.channelId, name: c.name })),
      };
    }
    const cid = r.channel.channelId;
    if (
      !(await isVisible(dir, authorityId, { kind: "channel", channelId: cid, isPrivate: r.channel.isPrivate === true }))
    ) {
      return membershipDenial(dir, authorityId, "channel");
    }
    return {
      ok: true,
      destination: { type: "slack", target: cid, audienceScopeId: makeScopeId("channel", cid) },
      channel: { channelId: cid, name: r.channel.name },
    };
  }
  if (wantsGroup) {
    if (target.participants!.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "bad_request",
        message: "participants must list the group DM's other members (at least one)",
      };
    }
    const asked = [...new Set(target.participants!)];
    if (asked.length > MAX_GROUP_DM_PARTICIPANTS) return groupTooLarge();
    const named: string[] = [];
    for (const query of asked) {
      const p = await dir.resolveRecipient(query);
      if (p.kind === "none") {
        return {
          ok: false,
          status: 404,
          error: "recipient_not_found",
          message: `no internal teammate matches "${query}"`,
        };
      }
      if (p.kind === "ambiguous") {
        return {
          ok: false,
          status: 409,
          error: "ambiguous_recipient",
          message: `"${query}" matches multiple teammates — pass an exact name or id`,
          candidates: p.candidates.map((c) => ({ principalId: c.principalId, displayName: c.displayName })),
        };
      }
      named.push(p.member.principalId);
    }
    const participants = [...new Set([...named, authorityId])];
    if (participants.length < 2) {
      return {
        ok: false,
        status: 400,
        error: "bad_request",
        message: "a group DM needs someone besides you — name a `recipient` instead for a 1:1 DM",
      };
    }
    if (participants.length > MAX_GROUP_DM_PARTICIPANTS) return groupTooLarge();
    const groupDestination = (gid: string): ReachResolution => ({
      ok: true,
      destination: { type: "group", target: gid, audienceScopeId: makeScopeId("group", gid) },
      group: { groupId: gid },
    });
    const known = await dir.resolveGroup(participants);
    if (known.kind === "one") {
      if (!(await isVisible(dir, authorityId, { kind: "group", groupId: known.groupId }))) {
        return membershipDenial(dir, authorityId, "group");
      }
      return groupDestination(known.groupId);
    }
    if (!opts.mayOpenGroup || !dir.openGroup) {
      return {
        ok: false,
        status: 404,
        error: "group_not_found",
        message: dir.openGroup
          ? "no group DM I'm in has exactly those participants — post to it once with /v1/reach, which opens it, then address it here"
          : "no group DM I'm in has exactly those participants (it may not have synced yet)",
      };
    }
    if (!(await dir.directoryMember(authorityId))) return membershipDenial(dir, authorityId, "group");
    const opened = await dir.openGroup(participants);
    if (!opened || "error" in opened) {
      return {
        ok: false,
        status: 502,
        error: "group_open_failed",
        message: opened?.error ?? "I couldn't open a group DM with those people just now — try again in a moment",
      };
    }
    await dir.registerGroup?.(opened.groupId, participants).catch((e) => swallow("reach: register opened group", e));
    return groupDestination(opened.groupId);
  }
  return {
    ok: false,
    status: 400,
    error: "bad_request",
    message: "name a recipient (a teammate), a channel, or a group DM's participants",
  };
}

export function attributeRelay(text: string, senderDisplayName: string | undefined): string {
  const who = senderDisplayName?.trim();
  return who ? `${who} asked me to pass on:\n${text}` : text;
}

export interface ReachEnqueueInput {
  deliveries: DeliveryStore;
  destination: Destination;
  text: string;
  attachments?: OutgoingAttachment[];
  idempotencyKey: string;
  provenance?: DeliveryProvenance;
  attributeAs?: string;
  shadow?: boolean;
}

export function withSlackUnfurlOption(destination: Destination, unfurlLinks: boolean | undefined): Destination {
  return unfurlLinks === undefined ? destination : { ...destination, unfurlLinks };
}

export function withReact(
  destination: Destination,
  react: { messageTs: string; emoji: string } | undefined,
): Destination {
  return react ? { ...destination, react } : destination;
}

export function withDelete(destination: Destination, del: { messageTs: string } | undefined): Destination {
  return del ? { ...destination, delete: del } : destination;
}

export function withThread(destination: Destination, threadTs: string | undefined): Destination {
  if (!threadTs) return destination;
  return destination.type === "principal"
    ? { ...destination, threadTs }
    : { ...destination, target: `${destination.target}:${threadTs}` };
}

export function withEdit(destination: Destination, editRef: string | undefined): Destination {
  return editRef ? { ...destination, editRef } : destination;
}

export async function reachEnqueue(input: ReachEnqueueInput): Promise<Delivery> {
  if (input.destination.react || input.destination.delete) {
    return input.deliveries.enqueue({
      destination: input.destination,
      text: "",
      idempotencyKey: input.idempotencyKey,
      ...(input.provenance ? { provenance: input.provenance } : {}),
      ...(input.shadow ? { shadow: true } : {}),
    });
  }
  const relayPrefixed = isThirdPartyRelay(input.destination, input.attributeAs)
    ? attributeRelay(input.text, input.attributeAs)
    : input.text;
  return input.deliveries.enqueue({
    destination: input.destination,
    text: relayPrefixed,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    idempotencyKey: input.idempotencyKey,
    ...(input.provenance ? { provenance: input.provenance } : {}),
    ...(input.shadow ? { shadow: true } : {}),
  });
}

function isThirdPartyRelay(destination: Destination, attributeAs: string | undefined): boolean {
  if (attributeAs === undefined) return false;
  if (destination.type === "group") return true;
  if (destination.type !== "principal") return false;
  return destination.onBehalfOf !== destination.target;
}
