import { surfaceProfile } from "../../surfaces/surface.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type OutboundFile } from "../../core/attachments.ts";
import { type ToolKit } from "./kit.ts";
import type { TurnHalt } from "../turn-tool-state.ts";
import {
  capText,
  optionalBoolean,
  optionalString,
  outboundFilesSchema,
  outboundSandboxSchema,
  SURFACE_ACTIONS,
  text,
} from "./shared.ts";

type ToolContext = NonNullable<ToolKit["ref"]["current"]>;

export function replyTools(kit: ToolKit, halt: Pick<TurnHalt, "setSilent">) {
  const { surface } = surfaceTool(kit);
  const { attach, finishSilently } = attachAndFinishTools(kit, halt);
  return { surface, attach, finishSilently };
}

function surfaceTool(kit: ToolKit) {
  const { opts } = kit;
  const surfaceName = opts?.surfaceName ?? "slack";
  const surfaceLabel = surfaceProfile(surfaceName).label ?? surfaceName;
  const surface = defineTool({
    name: surfaceName,
    label: surfaceName,
    description:
      `Everything you do on ${surfaceLabel} goes through this tool — posting (the ONLY way your words ` +
      "reach people; end the turn without a post and you stay silent), reacting, editing/deleting your " +
      "own messages, reading threads, checking what's new, searching, listing members, fetching files. " +
      "Pick an `action`.",
    parameters: surfaceParams(surfaceName),
    execute: (callId, params) => runSurfaceAction(kit, surfaceName, callId, params),
  });
  return { surface };
}

function surfaceParams(surfaceName: string) {
  return Type.Object({
    action: Type.Union(
      SURFACE_ACTIONS.map((action) => Type.Literal(action)),
      {
        description:
          "What to do: post (reply HERE, in this conversation — the normal way to answer), reach " +
          "(send to a DIFFERENT audience: a teammate DM, another channel, a group — the ONLY way to " +
          "leave this conversation), react (emoji on a message), edit/delete (revise/retract your " +
          "OWN message), read_thread (read stored thread messages, with live fallback for missing context), whats_new (pointers to what " +
          "changed), search (find messages), read_members (the roster), read_file (a shared file's " +
          "contents by reference).",
      },
    ),
    text: Type.Optional(
      Type.String({
        description:
          "post/reach: the message to send. edit: the new message content. Use Markdown, including [label](url) links; the surface renders it." +
          (surfaceProfile(surfaceName).toolHint ?? ""),
      }),
    ),
    channel: optionalString(
      "reach: send to THIS named channel (a channel you and the recipient can both see). EXTREMELY IMPORTANT: a channel post is a broadcast to everyone there — pick the narrowest audience that can act. A question or errand for one person (or a few) goes to their DM via `recipient`, NEVER to a public channel; use a channel only when the person you're helping explicitly named it as the destination, or the message genuinely concerns that whole room. react/edit/delete: which channel the target message is in (omit for the current one). NOT valid on post — post only ever replies in the current conversation.",
    ),
    recipient: optionalString("reach: DM this teammate (by name). NOT valid on post."),
    participants: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "reach: send to the group DM whose other members are exactly these (a group DM has no name; it's opened if it doesn't exist yet, so never ask someone to create one). react/edit/delete: the group DM the target message is in.",
      }),
    ),
    ts: optionalString(
      "post: reply under THIS message id (from read_thread/whats_new) — threads off it. You DON'T need it to answer where you were addressed; a plain post already lands in the current thread/DM. Only set it to reply under a DIFFERENT message here. react: the message id to react to.",
    ),
    broadcast: optionalBoolean(
      "post: set true to post at THIS channel's top level instead of in the current thread — a deliberate wider-audience announcement. Default (unset) replies in the thread you're in. Ignored in a DM.",
    ),
    sandbox_id: outboundSandboxSchema,
    files: Type.Optional(outboundFilesSchema),
    emoji: optionalString('react: emoji name without colons (e.g. "eyes", "tada").'),
    ref: optionalString(
      "edit/delete: the id of your OWN message to rewrite/retract (its `ts` from read_thread). read_file: the file's reference (its id from an earlier read result).",
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "read_thread: how many recent messages to fetch. search: max hits to return (default: a small window).",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "read_file: character offset to continue from (the offset an earlier read_file said to use).",
      }),
    ),
    query: optionalString("search: words to look for in this place's messages."),
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
    since: optionalString(
      "whats_new: only count what's newer than this message marker (from an earlier pull). Omit for the recent window.",
    ),
  });
}

async function runSurfaceAction(
  kit: ToolKit,
  surfaceName: string,
  callId: string,
  params: Static<ReturnType<typeof surfaceParams>>,
) {
  const { ref, recordCall, recordResult, recordText, recordFail } = kit;
  const tc = ref.current;
  if (!tc) return text("[error] no active tool context");
  const missing = (field: string) =>
    recordFail(
      callId,
      { tool: surfaceName, action: params.action, error: `missing_${field}` },
      `[error] the "${params.action}" action requires \`${field}\`.`,
    );
  const couldnt = (what: string, message?: string) =>
    recordFail(
      callId,
      { tool: surfaceName, action: params.action, ok: false },
      `[couldn't ${what}] ${message ?? "unavailable"}`,
    );
  const settled = (r: { ok: boolean; message?: string }, done: string, verb: string, failure: string) =>
    recordResult(
      callId,
      { tool: surfaceName, action: params.action, ok: r.ok },
      text(r.ok ? done : `[not ${verb}] ${r.message ?? failure}`),
      !r.ok,
    );
  const routing = {
    ...(params.channel !== undefined ? { channel: params.channel } : {}),
    ...(params.participants !== undefined ? { participants: params.participants } : {}),
  };
  switch (params.action) {
    case "post": {
      if (params.text === undefined) return missing("text");
      if (params.channel !== undefined || params.recipient !== undefined || params.participants !== undefined) {
        return recordFail(
          callId,
          { tool: surfaceName, action: "post", error: "post_cannot_address" },
          '[not sent] `post` only replies in this conversation. To send to another channel, a teammate DM, or a group, use `action: "reach"` with `channel`/`recipient`/`participants`.',
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
          ...(r.ok && r.attachments?.length ? { files: r.attachments } : {}),
        },
        text(r.ok ? "[sent]" : `[not sent] ${r.message ?? "delivery failed"}`),
        !r.ok,
      );
    }
    case "reach": {
      return surfaceReach(kit, tc, callId, params, surfaceName, missing);
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
      return settled(r, "[reacted]", "reacted", "reaction failed");
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
      return settled(r, "[edited]", "edited", "edit failed");
    }
    case "delete": {
      if (params.ref === undefined) return missing("ref");
      await recordCall(callId, { tool: surfaceName, action: "delete", ref: params.ref, ...routing });
      const r = await tc.delete({ ref: params.ref, ...routing });
      return settled(r, "[deleted]", "deleted", "delete failed");
    }
    case "read_thread": {
      return surfaceReadThread(kit, tc, callId, params, surfaceName, couldnt);
    }
    case "whats_new": {
      return surfaceWhatsNew(kit, tc, callId, params, surfaceName, couldnt);
    }
    case "search": {
      return surfaceSearch(kit, tc, callId, params, surfaceName, missing, couldnt);
    }
    case "read_members": {
      await recordCall(callId, { tool: surfaceName, action: "read_members" });
      const r = await tc.readMembers();
      if (!r.ok) return couldnt("read the members", r.message);
      const members = r.members ?? [];
      const body = members.length ? members.map((m) => `- ${m.displayName}`).join("\n") : "[no members to show here]";
      return recordText(callId, { tool: surfaceName, action: "read_members", ok: true, count: members.length }, body);
    }
    case "read_file": {
      return surfaceReadFile(kit, tc, callId, params, surfaceName, missing, couldnt);
    }
    default:
      return recordFail(
        callId,
        { tool: surfaceName, error: "unknown_action" },
        `[error] unknown action "${(params as { action?: string }).action}" — valid actions: ${SURFACE_ACTIONS.join(", ")}.`,
      );
  }
}

async function surfaceReadThread(
  kit: ToolKit,
  tc: ToolContext,
  callId: string,
  params: Static<ReturnType<typeof surfaceParams>>,
  surfaceName: string,
  couldnt: (what: string, message?: string) => ReturnType<ToolKit["recordFail"]>,
) {
  const { recordCall, recordExternalResult } = kit;
  await recordCall(callId, {
    tool: surfaceName,
    action: "read_thread",
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  });
  const r = await tc.readThread(params.limit !== undefined ? { limit: params.limit } : undefined);
  if (!r.ok) return couldnt("read the thread", r.message);
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
      [messages.length ? JSON.stringify(messages) : "[no messages in this thread]", r.message]
        .filter(Boolean)
        .join("\n"),
    ),
    "surface thread",
  );
}

async function surfaceReadFile(
  kit: ToolKit,
  tc: ToolContext,
  callId: string,
  params: Static<ReturnType<typeof surfaceParams>>,
  surfaceName: string,
  missing: (field: string) => ReturnType<ToolKit["recordFail"]>,
  couldnt: (what: string, message?: string) => ReturnType<ToolKit["recordFail"]>,
) {
  const { recordCall, recordExternalResult, recordText } = kit;
  if (params.ref === undefined) return missing("ref");
  await recordCall(callId, {
    tool: surfaceName,
    action: "read_file",
    ref: params.ref,
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
  });
  const r = await (params.offset !== undefined ? tc.readFile(params.ref, params.offset) : tc.readFile(params.ref));
  if (!r.ok) return couldnt("read that file", r.message);
  if (r.content !== undefined) {
    return recordExternalResult(
      callId,
      {
        tool: surfaceName,
        action: "read_file",
        ok: true,
        ...(r.name ? { name: r.name } : {}),
        ...(r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {}),
        ...(r.nextOffset !== undefined ? { nextOffset: r.nextOffset } : {}),
      },
      text(
        r.nextOffset !== undefined
          ? `${r.content}\n[showing up to character ${r.nextOffset} of ${r.totalChars} — read_file again with offset ${r.nextOffset} for more]`
          : r.content,
      ),
      "surface file",
    );
  }
  const kind = r.contentType ?? "binary";
  const size = r.sizeBytes !== undefined ? ` (${r.sizeBytes} bytes)` : "";
  return recordText(
    callId,
    {
      tool: surfaceName,
      action: "read_file",
      ok: true,
      binary: true,
      ...(r.name ? { name: r.name } : {}),
      ...(r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {}),
      ...(r.contentType ? { contentType: r.contentType } : {}),
    },
    `[${r.name ?? "file"}${size} — ${kind}; not text. Bring it onto your computer to work with it.]`,
  );
}

async function surfaceSearch(
  kit: ToolKit,
  tc: ToolContext,
  callId: string,
  params: Static<ReturnType<typeof surfaceParams>>,
  surfaceName: string,
  missing: (field: string) => ReturnType<ToolKit["recordFail"]>,
  couldnt: (what: string, message?: string) => ReturnType<ToolKit["recordFail"]>,
) {
  const { recordCall, recordExternalResult } = kit;
  if (params.query === undefined) return missing("query");
  await recordCall(callId, {
    tool: surfaceName,
    action: "search",
    query: params.query,
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.source !== undefined ? { source: params.source } : {}),
  });
  const r = await tc.search(params.query, {
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.source !== undefined ? { source: params.source } : {}),
  });
  if (!r.ok) return couldnt("search", r.message);
  const hits = r.hits ?? [];
  const coverage = r.coverageSince ? ` (mirror covers this channel since ${r.coverageSince})` : "";
  let body = `[nothing here matches "${params.query}"]`;
  if (hits.length) {
    body =
      hits
        .map((h) => `- ${[h.author, h.when].filter(Boolean).join(" · ")}${h.ref ? ` [${h.ref}]` : ""}: ${h.snippet}`)
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

async function surfaceWhatsNew(
  kit: ToolKit,
  tc: ToolContext,
  callId: string,
  params: Static<ReturnType<typeof surfaceParams>>,
  surfaceName: string,
  couldnt: (what: string, message?: string) => ReturnType<ToolKit["recordFail"]>,
) {
  const { recordCall, recordText } = kit;
  await recordCall(callId, {
    tool: surfaceName,
    action: "whats_new",
    ...(params.since !== undefined ? { since: params.since } : {}),
  });
  const r = await tc.whatsNew(params.since !== undefined ? { since: params.since } : undefined);
  if (!r.ok) return couldnt("check what's new", r.message);
  const here = r.hereNew ?? 0;
  const others = r.activeSubConversations ?? 0;
  const line =
    `${here} new in this thread` +
    (others > 0 ? `, ${others} other ${others === 1 ? "thread" : "threads"} active` : "") +
    "." +
    (r.latest ? ` (as of ${r.latest} — pass this as \`since\` next time.)` : "") +
    (r.coverageSince ? ` (mirror covers this channel since ${r.coverageSince})` : "");
  return recordText(
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
    [line, r.message].filter(Boolean).join("\n"),
  );
}

async function surfaceReach(
  kit: ToolKit,
  tc: ToolContext,
  callId: string,
  params: Static<ReturnType<typeof surfaceParams>>,
  surfaceName: string,
  missing: (field: string) => ReturnType<ToolKit["recordFail"]>,
) {
  const { recordCall, recordResult, recordFail } = kit;
  if (params.text === undefined) return missing("text");
  const selectors = [
    params.channel !== undefined,
    params.recipient !== undefined,
    params.participants !== undefined,
  ].filter(Boolean).length;
  if (selectors !== 1) {
    return recordFail(
      callId,
      { tool: surfaceName, action: "reach", error: "reach_target" },
      "[not sent] `reach` needs exactly one destination: a `channel`, a `recipient` (teammate DM), or `participants` (group DM).",
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
      ...(r.ok && r.attachments?.length ? { files: r.attachments } : {}),
    },
    text(r.ok ? `[sent to ${r.matched ?? "the named destination"}]` : `[not sent] ${r.message ?? "delivery failed"}`),
    !r.ok,
  );
}

function attachAndFinishTools(kit: ToolKit, halt: Pick<TurnHalt, "setSilent">) {
  const { ref, surfaceTools, recordCall, recordResult, recordText, recordFail } = kit;
  const attach = defineTool({
    name: "attach",
    label: "Attach",
    description: "Send files with this turn's reply; the result lists what will be delivered.",
    parameters: Type.Object({
      files: outboundFilesSchema,
      sandbox_id: outboundSandboxSchema,
    }),
    async execute(callId, params: { files?: OutboundFile[]; sandbox_id?: string }) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      const files = params.files ?? [];
      await recordCall(callId, { tool: "attach", files, sandbox_id: params.sandbox_id });
      const r = await tc.attach(files, params.sandbox_id);
      if (!r.ok) return recordFail(callId, { tool: "attach", ok: false }, `[not attached] ${r.message}`);
      const list = r.files.map((f) => `${f.name} (${f.sizeBytes} bytes, ${f.mimetype})`).join("; ");
      const total = r.staged > r.files.length ? ` ${r.staged} file(s) are now staged for this reply.` : "";
      return recordText(
        callId,
        { tool: "attach", ok: true, files: r.files },
        `[attached] ${list} — delivered with your reply when this turn ends.${total}`,
      );
    },
  });

  const finishSilently = defineTool({
    name: "finish_silently",
    label: "finish_silently",
    description:
      "End this turn without replying (surface turns that deserve none; scheduled fires with nothing to report). Not needed after posting; does nothing on a turn without surface tools unless it is a cron, webhook or watch fire.",
    parameters: Type.Object({
      reason: optionalString("Short phrase for the audit log."),
    }),
    async execute(callId, params) {
      if (!ref.pollFire && !surfaceTools) {
        await recordCall(callId, { tool: "finish_silently", ...(params.reason ? { reason: params.reason } : {}) });
        return recordFail(
          callId,
          { tool: "finish_silently", noop: "not_a_poll_fire" },
          "[no-op] finish_silently only applies to surface turns or scheduled background fires; a person is waiting on this turn — just reply.",
        );
      }
      halt.setSilent(true);
      try {
        await recordCall(callId, { tool: "finish_silently", ...(params.reason ? { reason: params.reason } : {}) });
        return await recordResult(
          callId,
          { tool: "finish_silently", silent: true },
          { ...text("Turn ended without a closing reply."), terminate: true },
        );
      } catch (e) {
        halt.setSilent(false);
        throw e;
      }
    },
  });
  return { attach, finishSilently };
}
