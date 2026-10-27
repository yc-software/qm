// The cron and webhook tools: scheduled and inbound-event work.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { CRON_FIRE_NOTE_MAX_CHARS, UNATTENDED_ADMIN_GRANTS } from "../../api/control-service.ts";
import { utcMinute } from "../../util/time.ts";
import { WEBHOOK_SCHEMES } from "../../webhooks/verifiers.ts";
import { type ToolKit } from "./kit.ts";
import {
  CRON_ID_ACTIONS,
  fmtCronCreated,
  fmtCronLine,
  fmtCronRunLine,
  listOrder,
  optionalBoolean,
  optionalInteger,
  optionalString,
  pageOf,
  previewText,
  previewTrims,
  SENDER_WEBHOOK_SCHEMES,
  text,
  WEBHOOK_ACTION_PREVIEW_CHARS,
} from "./shared.ts";

type ToolContext = NonNullable<ToolKit["ref"]["current"]>;

export function schedulingTools(kit: ToolKit) {
  const { cron } = cronTool(kit);
  const { webhook } = webhookTool(kit);
  return { cron, webhook };
}

/** The cron tool: create, inspect and manage scheduled work. */
function cronTool(kit: ToolKit) {
  const cron = defineTool({
    name: "cron",
    label: "cron",
    description:
      "Schedule future or recurring work and manage it. Confirm the timing with the user before creating. " +
      "One job = one cron: list first and patch an existing one rather than creating a second.\n" +
      'create: always set `title`, a distinctive 2-5 word label for what the cron is FOR (e.g. "Gmail unread digest"), ' +
      "never the command or a generic word. Give either `task` (a prompt re-evaluated at each fire, e.g. " +
      '"summarize anything notable in Gmail; if nothing changed, call finish_silently") or `text` (exact words to relay). ' +
      "`schedule`: {cron,timezone} for anything tied to a time of day or calendar (IANA timezone: the user's local " +
      "one unless they name another; omit for this turn's), {everyMs} for sub-day polling only (first run one " +
      "interval from now; 24h or more is rejected), or {firstFireAt} (epoch ms, one-shot; Date.now() means now). " +
      "Never compute future epochs for calendar times.\n" +
      "DELIVERY: by default a cron posts back to this conversation; keep that for watches and follow-ups on work " +
      "started here, and don't pick a DM just because this is one. Otherwise set `recipient` (a teammate → DM) or " +
      "`channel`; never put the destination inside `task`. It is fixed at create: to move one, create the new cron " +
      "and delete the old.\n" +
      "ACCESS: a cron belongs to its creator and runs as them; everyone here can see it, only the owner can change " +
      "it unless shared with permission=write; it is deleted if the owner leaves the conversation. A cron whose " +
      "fires read admin data needs `unattendedGrants`, and many admin reads have none: first follow the admin " +
      'skill\'s "Scheduling admin-reading work", which fetches the live grant list.\n' +
      "list: 25 per page, enabled and newest first; a footer names the next offset. get: one in full. runs: the " +
      'fire log (a fire shows as "running" from the moment it starts). patch: edit in place. delete: remove for ' +
      "good. run: fire once now (refused while a fire is running). disable: pause.\n" +
      "`task` is the standing instructions for every fire. Durable run-state belongs in this conversation's Files " +
      "(verify the upload, leave the file ID in the note), never only in `task` or on sandbox disk; small progress " +
      "state can live in the note itself, never credentials.\n" +
      "note (inside a fire): a one- or two-sentence shift-change note " +
      `(max ${CRON_FIRE_NOTE_MAX_CHARS} chars) the next fire reads first; it overwrites the previous one.`,
    parameters: cronParams(),
    execute: (callId, params) => runCronAction(kit, callId, params),
  });
  return { cron };
}

function cronParams() {
  return Type.Object({
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("list"),
      Type.Literal("get"),
      Type.Literal("runs"),
      Type.Literal("patch"),
      Type.Literal("delete"),
      Type.Literal("run"),
      Type.Literal("disable"),
      Type.Literal("note"),
    ]),
    id: optionalString("The cron id (all actions except create/list)."),
    title: optionalString('create/patch: distinctive 2-5 word label for what it is FOR, e.g. "Gmail unread digest".'),
    schedule: Type.Optional(
      Type.Object(
        {
          cron: optionalString("5-field cron expression: minute hour day-of-month month day-of-week."),
          timezone: optionalString('IANA timezone, e.g. "America/Los_Angeles".'),
          everyMs: optionalInteger("Interval in ms for sub-day polling; >= 24h rejected."),
          firstFireAt: optionalInteger("Epoch ms for a one-shot; past times rejected."),
        },
        { description: "create/patch: {cron,timezone} | {everyMs} | {firstFireAt}." },
      ),
    ),
    task: optionalString("create/patch: prompt re-evaluated at fire time. Use this OR text."),
    text: optionalString("create/patch: exact words to send verbatim. Use this OR task."),
    recipient: optionalString("create: a teammate's name to DM."),
    channel: optionalString("create: a channel name to post to."),
    session: optionalBoolean("Show as ongoing work in this conversation. create: default true; patch: omit to keep."),
    unfurlLinks: optionalBoolean("create/patch: false suppresses Slack link previews."),
    note: Type.Optional(
      Type.String({
        maxLength: CRON_FIRE_NOTE_MAX_CHARS,
        description: `note: the shift-change note (max ${CRON_FIRE_NOTE_MAX_CHARS} chars).`,
      }),
    ),
    runtime: Type.Optional(
      Type.Union(
        [
          Type.Null(),
          Type.Object({
            modelId: Type.String(),
            effortLevel: Type.Optional(Type.String()),
            fastMode: Type.Optional(Type.Boolean()),
          }),
        ],
        {
          description:
            "create/patch: runtime override for an agent task (null clears). Use runtime get for approved models/harnesses; auto effort unsupported. Prefer a cheap model and low effort for simple tasks.",
        },
      ),
    ),
    unattendedGrants: Type.Optional(
      Type.Array(Type.Union(UNATTENDED_ADMIN_GRANTS.map((grant) => Type.Literal(grant))), {
        description:
          "create/patch: read-only admin grants for unattended fires (org admins only; the cron must live in and deliver to their own DM); admin unattended_grants lists which read needs which. patch replaces; [] removes.",
      }),
    ),
    inbox: optionalBoolean(
      "create: give the cron an inbox, a durable queue of work items each fire reads, adds to and closes at $AGENT_API_URL/v1/crons/<id>/items.",
    ),
    enabled: optionalBoolean("patch: false pauses, true resumes."),
    archived: optionalBoolean("patch: true archives the cron."),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "list: page size (default 25, max 100). runs: latest N entries.",
      }),
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "list: page offset from the previous footer." })),
  });
}

/** Runs one cron-tool action against the turn's tool context. */
async function runCronAction(kit: ToolKit, callId: string, params: Static<ReturnType<typeof cronParams>>) {
  const { ref, recordCall, recordResult, recordText, recordFail, refused } = kit;
  const tc = ref.current;
  if (!tc) return text("[error] no active tool context");
  await recordCall(callId, { tool: "cron", action: params.action, ...(params.id ? { id: params.id } : {}) });
  const id = typeof params.id === "string" ? params.id : "";
  const fail = (error: string, message: string) => recordFail(callId, { tool: "cron", error }, `[error] ${message}`);
  if (CRON_ID_ACTIONS.has(params.action) && !id) return fail("id required", `cron ${params.action} requires \`id\`.`);
  switch (params.action) {
    case "create": {
      return cronCreateAction(kit, tc, callId, params, fail);
    }
    case "list": {
      return cronListAction(kit, tc, callId, params);
    }
    case "get": {
      const r = await tc.cronGet(id);
      if (!r.ok) return refused(callId, "cron", r);
      return recordResult(callId, { tool: "cron", id }, text(fmtCronLine(r.cron)), false, {
        screenAs: {
          provenance: "external",
          source: "shared crons",
        },
      });
    }
    case "runs": {
      const r = await tc.cronRuns(id, params.limit !== undefined ? { limit: params.limit } : undefined);
      if (!r.ok) return refused(callId, "cron", r);
      const lines = r.runs.map(fmtCronRunLine);
      const suffix =
        r.runs.length === r.total
          ? ""
          : `\n(showing ${r.runs.length} of ${r.total}; omit limit for all retained entries)`;
      const noteLine =
        r.cron.lastFireNote && Number.isFinite(r.cron.lastFireNote.at)
          ? `\n(shift-change note (${utcMinute(r.cron.lastFireNote.at)}${r.cron.lastFireNote.by ? `, by ${r.cron.lastFireNote.by}` : ""}): ${r.cron.lastFireNote.text})`
          : "";
      return recordResult(
        callId,
        { tool: "cron", id, count: r.runs.length, total: r.total },
        text(lines.length ? `${lines.join("\n")}${suffix}${noteLine}` : "(no recorded fires for this cron)"),
        false,
        { screenAs: { provenance: "external", source: "shared crons" } },
      );
    }
    case "patch": {
      const r = await tc.cronPatch(id, {
        ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.task !== undefined ? { action: params.task } : {}),
        ...(params.text !== undefined ? { text: params.text } : {}),
        ...(params.schedule !== undefined ? { schedule: params.schedule } : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.archived !== undefined ? { archived: params.archived } : {}),
        ...(params.unfurlLinks !== undefined ? { unfurlLinks: params.unfurlLinks } : {}),
        ...(params.session !== undefined ? { session: params.session } : {}),
        ...(params.unattendedGrants !== undefined ? { unattendedGrants: params.unattendedGrants } : {}),
      });
      if (!r.ok) return refused(callId, "cron", r);
      return recordText(callId, { tool: "cron", id }, `Updated cron ${fmtCronLine(r.cron)}`);
    }
    case "delete": {
      const r = await tc.cronDelete(id);
      if (!r.ok) return refused(callId, "cron", r);
      return recordText(callId, { tool: "cron", id, deleted: true }, `Deleted cron ${id}.`);
    }
    case "disable": {
      const r = await tc.cronSetEnabled(id, false);
      if (!r.ok) return refused(callId, "cron", r);
      return recordText(callId, { tool: "cron", id, enabled: false }, `Paused cron ${id}.`);
    }
    case "run": {
      const r = await tc.cronRun(id);
      if (!r.ok) return refused(callId, "cron", r);
      return recordText(
        callId,
        { tool: "cron", id, ran: true },
        `Fired cron ${id} — the run is starting now and delivers on its own when it finishes.`,
      );
    }
    case "note": {
      if (typeof params.note !== "string" || !params.note.trim()) {
        return fail("note required", "cron note requires `note` (the short message the next fire reads).");
      }
      const r = await tc.cronNote(id, params.note);
      if (!r.ok) return refused(callId, "cron", r);
      return recordText(
        callId,
        { tool: "cron", id, noted: r.applied },
        r.applied
          ? `Noted — the next fire of ${id} will see it.`
          : `[not stored] a newer shift-change note for ${id} already exists — the next fire will see that one instead.`,
      );
    }
  }
}

/** cron list: this scope's crons plus the read-only ones visible here, one page at a time. */
async function cronListAction(
  kit: ToolKit,
  tc: ToolContext,
  callId: string,
  params: Static<ReturnType<typeof cronParams>>,
) {
  const { recordResult, recordText, unavailable, isUnavailable } = kit;
  const r = await tc.cronList();
  if (isUnavailable(r)) return unavailable(callId, "cron");
  const items = [
    ...r.crons.map((c) => ({ c, prefix: "" })),
    ...r.visible.map((c) => ({ c, prefix: `(read-only, ${c.scopeName ?? c.ownerScopeId}) ` })),
  ].sort((a, b) => listOrder(a.c, b.c));
  if (!items.length) return recordText(callId, { tool: "cron", count: 0, visible: 0 }, "(no crons scheduled here)");
  const { page, offset, note } = pageOf(items, params);
  const trimmed = page.some(({ c }) => previewTrims(c.action || c.message));
  const lines = page.map(({ c, prefix }) => `- ${prefix}${fmtCronLine(c, true)}`);
  const footer = [note, trimmed ? "task text is trimmed — action=get shows a cron in full" : null]
    .filter(Boolean)
    .join("; ");
  return recordResult(
    callId,
    {
      tool: "cron",
      count: r.crons.length,
      visible: r.visible.length,
      shown: page.length,
      ...(offset > 0 ? { offset } : {}),
    },
    text([...lines, ...(footer ? [`(${footer})`] : [])].join("\n")),
    false,
    { screenAs: r.visible.length ? { provenance: "external", source: "shared crons" } : undefined },
  );
}

/** cron create: validates the request and schedules the job. */
async function cronCreateAction(
  kit: ToolKit,
  tc: ToolContext,
  callId: string,
  params: Static<ReturnType<typeof cronParams>>,
  fail: (error: string, message: string) => ReturnType<ToolKit["recordFail"]>,
) {
  const { recordText, unavailable, isUnavailable } = kit;
  if (!params.schedule)
    return fail("schedule required", "cron create requires `schedule` ({cron,timezone} | {everyMs} | {firstFireAt}).");
  if (params.task === undefined && params.text === undefined) {
    return fail("task or text required", "cron create requires `task` (a prompt) or `text` (exact words).");
  }
  const r = await tc.cronCreate({
    schedule: params.schedule,
    ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.task !== undefined ? { action: params.task } : {}),
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...(params.recipient !== undefined ? { recipient: params.recipient } : {}),
    ...(params.channel !== undefined ? { channel: params.channel } : {}),
    ...(params.unfurlLinks !== undefined ? { unfurlLinks: params.unfurlLinks } : {}),
    ...(params.session !== undefined ? { session: params.session } : {}),
    ...(params.unattendedGrants !== undefined ? { unattendedGrants: params.unattendedGrants } : {}),
    ...(params.inbox === true ? { inbox: true } : {}),
  });
  if (isUnavailable(r)) return unavailable(callId, "cron");
  if (!r.ok) {
    const cand = r.candidates?.length
      ? `\nCandidates: ${r.candidates.map((c) => `${c.label} (${c.id})`).join(", ")}`
      : "";
    return fail(r.code, `${r.message}${cand}`);
  }
  return recordText(
    callId,
    {
      tool: "cron",
      id: r.cron.id,
      created: true,
      ...(r.recipient ? { recipient: r.recipient } : {}),
      ...(r.channel ? { channel: r.channel } : {}),
    },
    fmtCronCreated(r),
  );
}

/** The webhook tool: create, list, update and disable inbound webhooks. */
function webhookTool(kit: ToolKit) {
  const { ref, recordCall, recordText, recordFail, refused, unavailable, isUnavailable } = kit;
  const webhook = defineTool({
    name: "webhook",
    label: "webhook",
    description:
      "Inbound webhooks: a turn runs whenever an external system POSTs to the URL. Confirm with the user before creating one.\n" +
      'create: `task` (what to do per event; the payload is appended), `verification`, optional `filters` and `destinationKey` (a key from the "Where scheduled tasks post" menu). ' +
      `For ${SENDER_WEBHOOK_SCHEMES.join("/")} the user supplies the signing secret from the sender's settings; for hmac-sha256 generate a strong random one; for google-pubsub (Gmail and other Pub/Sub push) generate one too and have the user set it as the push subscription's audience. ` +
      "The result shows the public `url` and `secret` once; relay both verbatim to the user, who must configure the sender before it fires.\n" +
      "list: 25 per page, secrets elided. update: replace one's task (same URL and secret). disable: pause one.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("update"),
        Type.Literal("disable"),
      ]),
      id: optionalString("update/disable: the webhook id."),
      task: optionalString("create/update: what to do on each event."),
      verification: Type.Optional(
        Type.Object(
          {
            scheme: Type.Union(WEBHOOK_SCHEMES.map((scheme) => Type.Literal(scheme))),
            secret: Type.String({ description: "The signing secret." }),
          },
          { description: "create: request authentication." },
        ),
      ),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "Dotted path into the payload." }),
            in: Type.Array(Type.String(), { description: "Values that pass." }),
          }),
          { description: 'create: skip the turn unless the payload matches, e.g. [{path:"action",in:["opened"]}].' },
        ),
      ),
      destinationKey: optionalString('create: a key from the "Where scheduled tasks post" menu.'),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "list: page size (default 25, max 100)." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "list: page offset from the previous footer." })),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, { tool: "webhook", action: params.action, ...(params.id ? { id: params.id } : {}) });
      switch (params.action) {
        case "create": {
          if (!params.verification || typeof params.task !== "string") {
            return recordFail(
              callId,
              { tool: "webhook", error: "verification and task required" },
              "[error] webhook create requires `task` (what to do per event) and `verification` ({scheme, secret?}).",
            );
          }
          const r = await tc.webhookCreate({
            action: params.task,
            verification: params.verification,
            ...(params.filters?.length ? { filters: params.filters } : {}),
            ...(params.destinationKey !== undefined ? { destinationKey: params.destinationKey } : {}),
          });
          if (!r.ok) return refused(callId, "webhook", r);

          const secretLine = `\nSecret (shown once — store it): ${r.secret}`;
          return recordText(
            callId,
            { tool: "webhook", id: r.webhook.id, url: r.url, secretShown: !!r.secret },
            `Registered webhook ${r.webhook.id}.\nInbound URL (give to the sender verbatim): ${r.url}${secretLine}\nIt won't fire until the sender is pointed at this URL.`,
          );
        }
        case "list": {
          const r = await tc.webhookList();
          if (isUnavailable(r)) return unavailable(callId, "webhook");
          if (!r.length) return recordText(callId, { tool: "webhook", count: 0 }, "(no webhooks registered here)");
          const { page, offset, note } = pageOf([...r].sort(listOrder), params);
          const lines = page.map(
            (w) =>
              `- ${w.id} (${w.verification.scheme}${w.enabled ? "" : ", paused"}): ${previewText(w.action, WEBHOOK_ACTION_PREVIEW_CHARS)}`,
          );
          return recordText(
            callId,
            { tool: "webhook", count: r.length, shown: page.length, ...(offset > 0 ? { offset } : {}) },
            [...lines, ...(note ? [`(${note})`] : [])].join("\n"),
          );
        }
        case "disable": {
          const id = typeof params.id === "string" && params.id ? params.id : null;
          if (!id)
            return recordFail(
              callId,
              { tool: "webhook", error: "id required" },
              "[error] webhook disable requires `id`.",
            );
          const r = await tc.webhookDisable(id);
          if (!r.ok) return refused(callId, "webhook", r);
          return recordText(callId, { tool: "webhook", id, enabled: false }, `Disabled webhook ${id}.`);
        }
        case "update": {
          const id = typeof params.id === "string" && params.id ? params.id : null;
          const task = typeof params.task === "string" ? params.task : "";
          if (!id)
            return recordFail(
              callId,
              { tool: "webhook", error: "id required" },
              "[error] webhook update requires `id` and the new `task`.",
            );
          const r = await tc.webhookUpdate(id, task);
          if (!r.ok) return refused(callId, "webhook", r);
          return recordText(
            callId,
            { tool: "webhook", id, updated: true },
            `Updated webhook ${id}. The next delivery uses the new task; URL and secret are unchanged.`,
          );
        }
      }
    },
  });
  return { webhook };
}
