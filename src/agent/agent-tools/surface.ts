import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { text, outboundFilesSchema, outboundSandboxSchema, type ToolKit } from "./kit.ts";
import { MAX_TOOL_RESULT_CHARS } from "./record.ts";
import { surfaceCapabilities, surfaceLabel } from "../../surfaces/surface-capabilities.ts";
import { DISCORD_SURFACE } from "../../discord/config.ts";

function capText(t: string): string {
  return t.length > MAX_TOOL_RESULT_CHARS ? `${t.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]` : t;
}

export function surfaceTool(kit: ToolKit) {
  const { ref, opts, recordCall, recordResult, recordExternalResult } = kit;
  const surfaceName = opts?.surfaceName ?? "slack";
  const surfaceLabelText = surfaceLabel(surfaceName);
  const surface = defineTool({
    name: surfaceName,
    label: surfaceName,
    description:
      `Everything you do on ${surfaceLabelText} goes through this tool — posting (the ONLY way your words ` +
      "reach people; end the turn without a post and you stay silent), reacting, editing/deleting your " +
      "own messages, reading threads, checking what's new, searching, listing members, fetching files. " +
      "Pick an `action`.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("post"),
          Type.Literal("reach"),
          Type.Literal("react"),
          Type.Literal("edit"),
          Type.Literal("delete"),
          Type.Literal("read_thread"),
          Type.Literal("whats_new"),
          Type.Literal("search"),
          Type.Literal("read_members"),
        ],
        {
          description:
            "What to do: post (reply HERE, in this conversation — the normal way to answer), reach " +
            "(send to a DIFFERENT audience: a teammate DM, another channel, a group — the ONLY way to " +
            "leave this conversation), react (emoji on a message), edit/delete (revise/retract your " +
            "OWN message), read_thread (read stored thread messages, with live fallback for missing context), whats_new (pointers to what " +
            "changed), search (find messages), read_members (the roster).",
        },
      ),
      text: Type.Optional(
        Type.String({
          description:
            "post/reach: the message to send. edit: the new message content. Use Markdown, including [label](url) links; the surface renders it." +
            (surfaceCapabilities(surfaceName)?.mentionHint ?? ""),
        }),
      ),
      channel: Type.Optional(
        Type.String({
          description:
            "reach: send to THIS named channel (a channel you and the recipient can both see). EXTREMELY IMPORTANT: a channel post is a broadcast to everyone there — pick the narrowest audience that can act. A question or errand for one person (or a few) goes to their DM via `recipient`, NEVER to a public channel; use a channel only when the person you're helping explicitly named it as the destination, or the message genuinely concerns that whole room. react/edit/delete: which channel the target message is in (omit for the current one). read_thread/search/read_members: read THIS channel instead of the current conversation (a name or id; you must be able to see it, otherwise the read fails). NOT valid on post — post only ever replies in the current conversation.",
        }),
      ),
      recipient: Type.Optional(Type.String({ description: "reach: DM this teammate (by name). NOT valid on post." })),
      participants: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "reach: send to the group DM whose other members are exactly these (a group DM has no name; it's opened if it doesn't exist yet, so never ask someone to create one). react/edit/delete: the group DM the target message is in.",
        }),
      ),
      ts: Type.Optional(
        Type.String({
          description:
            "post: reply under THIS message id (from read_thread/whats_new) — threads off it. You DON'T need it to answer where you were addressed; a plain post already lands in the current thread/DM. Only set it to reply under a DIFFERENT message here. react: the message id to react to. read_thread: read the thread under THIS message id instead of the current thread (not on Discord — pass the thread's id as `channel`).",
        }),
      ),
      broadcast: Type.Optional(
        Type.Boolean({
          description:
            "post: set true to post at THIS channel's top level instead of in the current thread — a deliberate wider-audience announcement. Default (unset) replies in the thread you're in. Ignored in a DM.",
        }),
      ),
      sandbox_id: outboundSandboxSchema,
      files: Type.Optional(outboundFilesSchema),
      emoji: Type.Optional(Type.String({ description: 'react: emoji name without colons (e.g. "eyes", "tada").' })),
      ref: Type.Optional(
        Type.String({
          description: "edit/delete: the id of your OWN message to rewrite/retract (its `ts` from read_thread).",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "read_thread: how many recent messages to fetch. search: max hits to return (default: a small window).",
        }),
      ),
      query: Type.Optional(Type.String({ description: "search: words to look for in this place's messages." })),
      ...(surfaceName === DISCORD_SURFACE
        ? {}
        : {
            source: Type.Optional(
              Type.Union([Type.Literal("mirror"), Type.Literal("slack")], {
                description:
                  "search: where to search — `mirror` (default) searches the local copy of recent messages: only channels I'm in, " +
                  "and only back to each channel's coverage date, so it can miss both very recent and older messages. " +
                  "`slack` runs Slack's own full-history search AS THE ASKING PERSON, via their connected Slack login — it sees " +
                  "exactly what they can see, including their own DMs and private channels (never anyone else's). Retry with " +
                  "`slack` when the mirror and this conversation's own history both come up empty; reading the conversation needs no personal login. " +
                  "A message neither lens can see may still exist — say what you couldn't search, don't declare it nonexistent. " +
                  "In a channel or group, hits from the asker's DMs or private channels are for their eyes: don't quote that content to the room — acknowledge you found it and take it to their DM.",
              }),
            ),
          }),
      since: Type.Optional(
        Type.String({
          description:
            "whats_new: only count what's newer than this message marker (from an earlier pull). Omit for the recent window.",
        }),
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      const missing = (field: string) =>
        recordResult(
          callId,
          { tool: surfaceName, action: params.action, error: `missing_${field}` },
          text(`[error] the "${params.action}" action requires \`${field}\`.`),
          true,
        );
      const readScope = params.channel !== undefined ? { channel: params.channel } : {};
      const routing = {
        ...(params.channel !== undefined ? { channel: params.channel } : {}),
        ...(params.participants !== undefined ? { participants: params.participants } : {}),
      };
      switch (params.action) {
        case "post": {
          if (params.text === undefined) return missing("text");
          if (params.channel !== undefined || params.recipient !== undefined || params.participants !== undefined) {
            return recordResult(
              callId,
              { tool: surfaceName, action: "post", error: "post_cannot_address" },
              text(
                '[not sent] `post` only replies in this conversation. To send to another channel, a teammate DM, or a group, use `action: "reach"` with `channel`/`recipient`/`participants`.',
              ),
              true,
            );
          }
          const opts = {
            ...(params.ts !== undefined ? { ts: params.ts } : {}),
            ...(params.broadcast !== undefined ? { broadcast: params.broadcast } : {}),
          };
          await recordCall(callId, {
            tool: surfaceName,
            action: "post",
            ...opts,
            text: capText(params.text),
            ...(params.files?.length ? { files: params.files } : {}),
          });
          const r = await tc.post(params.text, opts, params.files, params.sandbox_id);
          return recordResult(
            callId,
            {
              tool: surfaceName,
              action: "post",
              ok: r.ok,
              ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}),
              ...(r.ok && r.attachments?.length ? { files: r.attachments } : {}),
            },
            text(r.ok ? "[sent]" : `[not sent] ${r.message ?? "delivery failed"}`),
            !r.ok,
          );
        }
        case "reach": {
          if (params.text === undefined) return missing("text");
          const selectors = [
            params.channel !== undefined,
            params.recipient !== undefined,
            params.participants !== undefined,
          ].filter(Boolean).length;
          if (selectors !== 1) {
            return recordResult(
              callId,
              { tool: surfaceName, action: "reach", error: "reach_target" },
              text(
                "[not sent] `reach` needs exactly one destination: a `channel`, a `recipient` (teammate DM), or `participants` (group DM).",
              ),
              true,
            );
          }
          const target = {
            ...(params.channel !== undefined ? { channel: params.channel } : {}),
            ...(params.recipient !== undefined ? { recipient: params.recipient } : {}),
            ...(params.participants !== undefined ? { participants: params.participants } : {}),
          };
          await recordCall(callId, {
            tool: surfaceName,
            action: "reach",
            ...target,
            bytes: params.text.length,
            ...(params.files?.length ? { files: params.files.length } : {}),
          });
          const r = await tc.reach(params.text, target, params.files, params.sandbox_id);
          return recordResult(
            callId,
            {
              tool: surfaceName,
              action: "reach",
              ok: r.ok,
              ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}),
              ...(r.ok && r.attachments?.length ? { files: r.attachments } : {}),
            },
            text(
              r.ok
                ? `[sent to ${r.matched ?? "the named destination"}]`
                : `[not sent] ${r.message ?? "delivery failed"}`,
            ),
            !r.ok,
          );
        }
        case "react": {
          if (params.ts === undefined) return missing("ts");
          if (params.emoji === undefined) return missing("emoji");
          await recordCall(callId, {
            tool: surfaceName,
            action: "react",
            ts: params.ts,
            emoji: params.emoji,
            ...routing,
          });
          const r = await tc.react({ ts: params.ts, emoji: params.emoji, ...routing });
          return recordResult(
            callId,
            { tool: surfaceName, action: "react", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            text(r.ok ? "[reacted]" : `[not reacted] ${r.message ?? "reaction failed"}`),
            !r.ok,
          );
        }
        case "edit": {
          if (params.ref === undefined) return missing("ref");
          if (params.text === undefined) return missing("text");
          await recordCall(callId, {
            tool: surfaceName,
            action: "edit",
            ref: params.ref,
            text: capText(params.text),
            ...routing,
          });
          const r = await tc.edit({ ref: params.ref, text: params.text, ...routing });
          return recordResult(
            callId,
            { tool: surfaceName, action: "edit", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            text(r.ok ? "[edited]" : `[not edited] ${r.message ?? "edit failed"}`),
            !r.ok,
          );
        }
        case "delete": {
          if (params.ref === undefined) return missing("ref");
          await recordCall(callId, { tool: surfaceName, action: "delete", ref: params.ref, ...routing });
          const r = await tc.delete({ ref: params.ref, ...routing });
          return recordResult(
            callId,
            { tool: surfaceName, action: "delete", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            text(r.ok ? "[deleted]" : `[not deleted] ${r.message ?? "delete failed"}`),
            !r.ok,
          );
        }
        case "read_thread": {
          await recordCall(callId, {
            tool: surfaceName,
            action: "read_thread",
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...readScope,
            ...(params.ts !== undefined ? { ts: params.ts } : {}),
          });
          const r = await tc.readThread({
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...readScope,
            ...(params.ts !== undefined ? { ts: params.ts } : {}),
          });
          if (!r.ok)
            return recordResult(
              callId,
              { tool: surfaceName, action: "read_thread", ok: false },
              text(`[couldn't read the thread] ${r.message ?? "unavailable"}`),
              true,
            );
          const messages = r.messages ?? [];
          return recordExternalResult(
            callId,
            {
              tool: surfaceName,
              action: "read_thread",
              ok: true,
              count: messages.length,
              ...(r.message ? { note: r.message } : {}),
            },
            text(
              [messages.length ? JSON.stringify(messages, null, 2) : "[no messages in this thread]", r.message]
                .filter(Boolean)
                .join("\n"),
            ),
            "surface thread",
          );
        }
        case "whats_new": {
          await recordCall(callId, {
            tool: surfaceName,
            action: "whats_new",
            ...(params.since !== undefined ? { since: params.since } : {}),
          });
          const r = await tc.whatsNew(params.since !== undefined ? { since: params.since } : undefined);
          if (!r.ok)
            return recordResult(
              callId,
              { tool: surfaceName, action: "whats_new", ok: false },
              text(`[couldn't check what's new] ${r.message ?? "unavailable"}`),
              true,
            );
          const here = r.hereNew ?? 0;
          const others = r.activeSubConversations ?? 0;
          const line =
            `${here} new in this thread` +
            (others > 0 ? `, ${others} other ${others === 1 ? "thread" : "threads"} active` : "") +
            "." +
            (r.latest ? ` (as of ${r.latest} — pass this as \`since\` next time.)` : "") +
            (r.coverageSince ? ` (mirror covers this channel since ${r.coverageSince})` : "");
          return recordResult(
            callId,
            {
              tool: surfaceName,
              action: "whats_new",
              ok: true,
              hereNew: here,
              activeSubConversations: others,
              ...(r.message ? { note: r.message } : {}),
              ...(r.latest ? { latest: r.latest } : {}),
            },
            text([line, r.message].filter(Boolean).join("\n")),
          );
        }
        case "search": {
          if (params.query === undefined) return missing("query");
          const searchSource = (params as { source?: "mirror" | "slack" }).source;
          await recordCall(callId, {
            tool: surfaceName,
            action: "search",
            query: params.query,
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...(searchSource !== undefined ? { source: searchSource } : {}),
            ...readScope,
          });
          const r = await tc.search(params.query, {
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...(searchSource !== undefined ? { source: searchSource } : {}),
            ...readScope,
          });
          if (!r.ok)
            return recordResult(
              callId,
              { tool: surfaceName, action: "search", ok: false },
              text(`[couldn't search] ${r.message ?? "unavailable"}`),
              true,
            );
          const hits = r.hits ?? [];
          const coverage = r.coverageSince ? ` (mirror covers this channel since ${r.coverageSince})` : "";
          let body = `[nothing here matches "${params.query}"]`;
          if (hits.length) {
            body =
              hits
                .map(
                  (h) =>
                    `- ${[h.author, h.when].filter(Boolean).join(" · ")}${h.ref ? ` [${h.ref}]` : ""}: ${h.snippet}`,
                )
                .join("\n") + coverage;
          } else if (r.source === "slack") {
            body = `[no matches in Slack's full history as far as the asking person can see — a message in someone else's DMs or private channels stays invisible; ask them to forward it]`;
          } else if (r.coverageSince) {
            body = `[no matches in the mirror — it only covers this channel since ${r.coverageSince}; retry with source "slack" to search full history as the asking person]`;
          }
          return recordExternalResult(
            callId,
            {
              tool: surfaceName,
              action: "search",
              ok: true,
              count: hits.length,
              ...(r.message ? { note: r.message } : {}),
              ...(r.source ? { source: r.source } : {}),
            },
            text([body, r.message].filter(Boolean).join("\n")),
            "surface search",
          );
        }
        case "read_members": {
          await recordCall(callId, { tool: surfaceName, action: "read_members", ...readScope });
          const r = await tc.readMembers(readScope);
          if (!r.ok)
            return recordResult(
              callId,
              { tool: surfaceName, action: "read_members", ok: false },
              text(`[couldn't read the members] ${r.message ?? "unavailable"}`),
              true,
            );
          const members = r.members ?? [];
          const body = members.length
            ? members.map((m) => `- ${m.displayName}`).join("\n")
            : "[no members to show here]";
          return recordResult(
            callId,
            { tool: surfaceName, action: "read_members", ok: true, count: members.length },
            text(body),
          );
        }
        default:
          return recordResult(
            callId,
            { tool: surfaceName, error: "unknown_action" },
            text(
              `[error] unknown action "${(params as { action?: string }).action}" — valid actions: post, react, edit, delete, read_thread, whats_new, search, read_members.`,
            ),
            true,
          );
      }
    },
  });

  return { surface };
}
