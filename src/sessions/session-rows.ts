import type { ScopeId, Session, SessionType } from "../types.ts";
import type { SessionOrigin } from "./session-store.ts";
import { isWebThread } from "./session-store.ts";

export const LIST_COLUMNS = `s.id, s.type, s.scope_id, s.thread_ref, s.surface, s.created_at, s.title, s.channel_name,
  s.forked_from_session_id, s.forked_from_title, s.fork_boundary_seq, s.parent_session_id, s.origin, s.side_chat, s.persona_id`;
const AUTOMATION_SURFACES = "('cron', 'webhook', 'loop')";
export const OWN_CHAT = (s: string): string =>
  `${s}.parent_session_id IS NULL AND (${s}.surface IS NULL OR ${s}.surface NOT IN ${AUTOMATION_SURFACES})`;
export const USER_ACTIVITY = "COALESCE(s.last_user_activity, s.created_at)";
export const BOT_VISIBLE = (botActor: boolean | undefined): string =>
  botActor === true
    ? " AND CASE WHEN pg_input_is_valid(s.spawn_meta, 'jsonb') THEN s.spawn_meta::jsonb -> 'botActor' = 'true'::jsonb END"
    : "";

export function rowToSession(r: Record<string, unknown>): Session {
  return {
    id: r.id as string,
    type: r.type as SessionType,
    scopeId: r.scope_id as ScopeId,
    threadRef: r.thread_ref as string,
    ...(r.surface != null ? { surface: r.surface as string } : {}),
    ...(r.client_tools ? { clientTools: r.client_tools as Session["clientTools"] } : {}),
    createdAt: Number(r.created_at),
    ...(r.title != null ? { title: r.title as string } : {}),
    ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
    ...(r.side_chat ? { sideChat: r.side_chat as Session["sideChat"] } : {}),
    ...(r.forked_from_session_id != null && r.fork_boundary_seq != null
      ? {
          forkedFrom: {
            sessionId: r.forked_from_session_id as string,
            ...(r.forked_from_title != null ? { title: r.forked_from_title as string } : {}),
          },
          forkBoundarySeq: Number(r.fork_boundary_seq),
        }
      : {}),
    ...(r.parent_session_id != null ? { parentSessionId: r.parent_session_id as string } : {}),
    ...(r.origin != null ? { origin: r.origin as SessionOrigin } : {}),
    ...(r.spawn_meta != null ? { spawnMeta: JSON.parse(r.spawn_meta as string) as Session["spawnMeta"] } : {}),
    ...((r.slack_binding as { author?: unknown } | null)?.author
      ? { surfaceBinding: r.slack_binding as Session["surfaceBinding"] }
      : {}),
    ...(r.runtime != null ? { runtime: r.runtime as Session["runtime"] } : {}),
    ...(r.persona_id != null ? { personaId: r.persona_id as string } : {}),
  };
}

export function rowToParticipantSession(r: Record<string, unknown>): Session {
  const s = rowToSession(r);
  if (r.p_title != null) s.title = r.p_title as string;
  if (r.p_archived) s.archived = true;
  if (r.p_pinned) s.pinned = true;
  if (r.p_color != null) s.color = r.p_color as string;
  if (r.agent_last_reply != null && Number(r.agent_last_reply) > Number(r.p_read_at ?? 0) && isWebThread(s.threadRef))
    s.unread = true;
  if (r.user_last_activity != null) s.lastActivityAt = Number(r.user_last_activity);
  if (r.has_entries != null) s.hasEntries = Boolean(r.has_entries);
  return s;
}
