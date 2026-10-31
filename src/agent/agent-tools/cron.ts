import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CronFireLogEntry } from "../../triggers/types.ts";
import { CRON_FIRE_NOTE_MAX_CHARS, UNATTENDED_ADMIN_GRANTS } from "../../api/control-service.ts";
import { utcMinute } from "../../util/time.ts";
import { text, type ToolKit } from "./kit.ts";
import { listOrder, pageOf, previewText, previewTrims } from "./listing.ts";

function fmtCronSchedule(c: {
  schedule: { cron?: string; timezone?: string; everyMs?: number; firstFireAt?: number };
}): string {
  const s = c.schedule;
  if (s.cron) return `${s.cron}${s.timezone ? ` (${s.timezone})` : ""}`;
  if (s.everyMs != null) return `every ${Math.max(1, Math.round(s.everyMs / 60_000))}m`;
  if (s.firstFireAt != null) return `once at ${new Date(s.firstFireAt).toISOString()}`;
  return "no schedule";
}

interface CronLike {
  runtime?: import("../agent.ts").RuntimeChoice | null;
  id: string;
  title?: string;
  enabled: boolean;
  archived?: boolean;
  schedule: { cron?: string; timezone?: string; everyMs?: number; firstFireAt?: number };
  action?: string;
  message?: string;
  nextFireAt?: number;
  destination?: { type: string; target: string };
  lastFireNote?: { text: string; at: number; by?: string };
  unattendedGrants?: string[];
}

function fmtCronLine(c: CronLike, preview = false): string {
  const body = c.action || c.message;
  let shown: string | undefined;
  if (body) shown = preview ? previewText(body) : body;
  const what = shown ? `${c.action ? "task" : "text"}: ${shown}` : "";
  let state = " [paused]";
  if (c.archived) state = " [archived]";
  else if (c.enabled) state = "";
  const dest = c.destination ? ` → ${c.destination.type}:${c.destination.target}` : "";
  const next = c.nextFireAt ? ` (next ${new Date(c.nextFireAt).toISOString()})` : "";
  const note =
    !preview && c.lastFireNote && Number.isFinite(c.lastFireNote.at)
      ? `\n    shift-change note (${utcMinute(c.lastFireNote.at)}${c.lastFireNote.by ? `, by ${c.lastFireNote.by}` : ""}): ${c.lastFireNote.text}`
      : "";
  const runtime = c.runtime
    ? `\n    runtime: ${c.runtime.modelId}${c.runtime.effortLevel ? ` (${c.runtime.effortLevel})` : ""}`
    : "";
  const grants = c.unattendedGrants?.length ? `\n    unattended grants: ${c.unattendedGrants.join(", ")}` : "";
  return `${c.id}${c.title ? ` "${c.title}"` : ""} — ${fmtCronSchedule(c)}${dest}${state}${next}${what ? `\n    ${what}` : ""}${runtime}${grants}${note}`;
}

function fmtCronCreated(r: {
  cron: CronLike;
  recipient?: { displayName: string };
  channel?: { name: string };
  group?: { groupId: string };
}): string {
  let to = "";
  if (r.recipient) to = `\nAddressed to ${r.recipient.displayName} (DM).`;
  else if (r.channel) to = `\nAddressed to #${r.channel.name}.`;
  else if (r.group) to = `\nAddressed to a group DM.`;
  return `Created cron ${fmtCronLine(r.cron)}${to}`;
}

function fmtCronRunLine(entry: CronFireLogEntry): string {
  let lifecycle: string | null = null;
  if (entry.status === "running") {
    lifecycle = `in flight for ${Math.max(0, Math.round((Date.now() - entry.firedAt) / 60_000))}m`;
  } else if (entry.endedAt !== undefined) {
    lifecycle = `took ${Math.max(0, Math.round((entry.endedAt - entry.firedAt) / 1000))}s`;
  }
  const bits = [
    new Date(entry.firedAt).toISOString(),
    `status=${entry.status ?? "unknown"}`,
    lifecycle,
    `fireKey=${entry.fireKey}`,
    entry.note ? `note=${entry.note}` : null,
    entry.reply ? `reply=${entry.reply}` : null,
  ].filter((bit): bit is string => bit !== null);
  return `- ${bits.join("; ")}`;
}

export function cronTools(kit: ToolKit) {
  const { ref, recordCall, recordResult, unavailable, isUnavailable } = kit;
  const cron = defineTool({
    name: "cron",
    label: "cron",
    description:
      "Schedule future or recurring work and manage it. Confirm the timing with the user before creating. One job = one cron: list first and patch an existing one rather than creating a second.\n" +
      'create: always set `title`, a distinctive 2-5 word label for what the cron is FOR (e.g. "Gmail unread digest"), never the command or a generic word. ' +
      "Give either `task` (a prompt re-evaluated at each fire) or `text` (exact words to relay). " +
      "When a task runs a script, first run that exact command once end to end, including what it posts or writes, without marking the work done by other means, so the first fire is not its first real run. " +
      "`schedule`: {cron,timezone} for anything tied to a time of day or calendar (IANA timezone: the user's local one unless they name another; omit for this turn's), {everyMs} for sub-day polling only (first run one interval from now), or {firstFireAt} (epoch ms, one-shot; Date.now() means now). Never compute future epochs for calendar times.\n" +
      "DELIVERY: by default a cron posts back to this conversation; keep that for watches and follow-ups on work started here, and don't pick a DM just because this is one. " +
      'Otherwise set `recipient` (teammate → DM), `channel`, `participants` (member ids → an existing group DM; reach it once first), or `destinationKey` (from the "Where scheduled tasks post" menu); ' +
      'scope="personal" runs it at the asker\'s own scope and DMs them. Never put the destination inside `task`. retarget changes the destinationKey.\n' +
      'Crons whose fires read admin data need `unattendedGrants`, and many admin reads have none: first follow the admin skill\'s "Scheduling admin-reading work", which fetches the live grant list. ' +
      "Before a grant-carrying cron posts anywhere but its owner's DM (create or retarget), tell the owner who will see its unattended admin output and act only on their explicit yes.\n" +
      "ACCESS: a cron belongs to its creator and runs as them; everyone here can see it, only the owner can change it unless shared with permission=write; deleted at its next fire if the owner has left its private channel or group.\n" +
      'list: 25 per page. get: one in full. runs: the fire log (a fire shows as "running" from the moment it starts). ' +
      "patch: edit in place. `task` is the standing instructions; durable run-state goes in this conversation's Files with the file ID left in the note (recurring non-loop crons only), never only in `task` or on sandbox disk; small progress state can live in the note itself. " +
      "delete: remove for good. run: fire once now (refused while a fire is running). disable: pause.\n" +
      `note (inside a fire): a one- or two-sentence shift-change note (max ${CRON_FIRE_NOTE_MAX_CHARS} chars) the next fire reads first; overwrites the previous one; never credentials.`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("get"),
        Type.Literal("runs"),
        Type.Literal("patch"),
        Type.Literal("delete"),
        Type.Literal("run"),
        Type.Literal("disable"),
        Type.Literal("retarget"),
        Type.Literal("note"),
      ]),
      id: Type.Optional(Type.String({ description: "The cron id (all actions except create/list)." })),
      title: Type.Optional(
        Type.String({
          description: 'create/patch: distinctive 2-5 word label for what it is FOR, e.g. "Gmail unread digest".',
        }),
      ),
      schedule: Type.Optional(
        Type.Object(
          {
            cron: Type.Optional(
              Type.String({ description: "5-field cron expression: minute hour day-of-month month day-of-week." }),
            ),
            timezone: Type.Optional(Type.String({ description: 'IANA timezone, e.g. "America/Los_Angeles".' })),
            everyMs: Type.Optional(
              Type.Integer({
                description: "Interval in ms for sub-day polling; >= 24h rejected.",
              }),
            ),
            firstFireAt: Type.Optional(Type.Integer({ description: "Epoch ms for a one-shot; past times rejected." })),
          },
          { description: "create/patch: {cron,timezone} | {everyMs} | {firstFireAt}." },
        ),
      ),
      task: Type.Optional(
        Type.String({ description: "create/patch: prompt re-evaluated at fire time. Use this OR text." }),
      ),
      text: Type.Optional(
        Type.String({ description: "create/patch: exact words to send verbatim. Use this OR task." }),
      ),
      recipient: Type.Optional(Type.String({ description: "create: a teammate's name to DM." })),
      channel: Type.Optional(Type.String({ description: "create: a channel name to post to." })),
      scope: Type.Optional(
        Type.Literal("personal", {
          description: "create: run at the asker's own scope and DM them; not with other destinations.",
        }),
      ),
      participants: Type.Optional(
        Type.Array(Type.String(), {
          description: "create: the other member ids of an existing group DM.",
        }),
      ),
      destinationKey: Type.Optional(
        Type.String({ description: 'create/retarget: a key from the "Where scheduled tasks post" menu.' }),
      ),
      session: Type.Optional(
        Type.Boolean({
          description: "Show as ongoing work in this conversation. create: default true; patch: omit to keep.",
        }),
      ),
      unfurlLinks: Type.Optional(Type.Boolean({ description: "create/patch: false suppresses Slack link previews." })),
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
              "create/patch: runtime override for an agent task (null clears). Use runtime get for approved models; auto effort unsupported. Prefer a cheap model and low effort for simple tasks.",
          },
        ),
      ),
      unattendedGrants: Type.Optional(
        Type.Array(Type.Union(UNATTENDED_ADMIN_GRANTS.map((grant) => Type.Literal(grant))), {
          description:
            "create/patch: read-only admin grants for unattended fires (org admins only; the cron must live in and deliver to their own DM); admin unattended_grants lists which read needs which. patch replaces; [] removes.",
        }),
      ),
      enabled: Type.Optional(Type.Boolean({ description: "patch: false pauses, true resumes." })),
      archived: Type.Optional(Type.Boolean({ description: "patch: true archives the cron." })),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "list: page size (default 25, max 100). runs: latest N entries.",
        }),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "list: page offset from the previous footer." })),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, { tool: "cron", action: params.action, ...(params.id ? { id: params.id } : {}) });
      const needId = (): string | null => (typeof params.id === "string" && params.id ? params.id : null);
      const missingId = () =>
        recordResult(
          callId,
          { tool: "cron", error: "id required" },
          text(`[error] cron ${params.action} requires \`id\`.`),
          true,
        );
      switch (params.action) {
        case "create": {
          if (!params.schedule)
            return recordResult(
              callId,
              { tool: "cron", error: "schedule required" },
              text("[error] cron create requires `schedule` ({cron,timezone} | {everyMs} | {firstFireAt})."),
              true,
            );
          if (params.task === undefined && params.text === undefined) {
            return recordResult(
              callId,
              { tool: "cron", error: "task or text required" },
              text("[error] cron create requires `task` (a prompt) or `text` (exact words)."),
              true,
            );
          }
          const r = await tc.cronCreate({
            schedule: params.schedule,
            ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.task !== undefined ? { action: params.task } : {}),
            ...(params.text !== undefined ? { text: params.text } : {}),
            ...(params.recipient !== undefined ? { recipient: params.recipient } : {}),
            ...(params.channel !== undefined ? { channel: params.channel } : {}),
            ...(params.scope !== undefined ? { scope: params.scope } : {}),
            ...(Array.isArray(params.participants) ? { participants: params.participants } : {}),
            ...(params.destinationKey !== undefined ? { destinationKey: params.destinationKey } : {}),
            ...(params.unfurlLinks !== undefined ? { unfurlLinks: params.unfurlLinks } : {}),
            ...(params.session !== undefined ? { session: params.session } : {}),
            ...(params.unattendedGrants !== undefined ? { unattendedGrants: params.unattendedGrants } : {}),
          });
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) {
            const cand = r.candidates?.length
              ? `\nCandidates: ${r.candidates.map((c) => `${c.label} (${c.id})`).join(", ")}`
              : "";
            return recordResult(callId, { tool: "cron", error: r.code }, text(`[error] ${r.message}${cand}`), true);
          }
          return recordResult(
            callId,
            {
              tool: "cron",
              id: r.cron.id,
              created: true,
              ...(r.recipient ? { recipient: r.recipient } : {}),
              ...(r.channel ? { channel: r.channel } : {}),
              ...(r.group ? { group: r.group } : {}),
            },
            text(fmtCronCreated(r)),
          );
        }
        case "list": {
          const r = await tc.cronList();
          if (isUnavailable(r)) return unavailable(callId, "cron");
          const items = [
            ...r.crons.map((c) => ({ c, prefix: "" })),
            ...r.visible.map((c) => ({ c, prefix: `(read-only, ${c.scopeName ?? c.ownerScopeId}) ` })),
          ].sort((a, b) => listOrder(a.c, b.c));
          if (!items.length)
            return recordResult(callId, { tool: "cron", count: 0, visible: 0 }, text("(no crons scheduled here)"));
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
            undefined,
            false,
            r.visible.length ? { provenance: "external", source: "shared crons" } : undefined,
          );
        }
        case "get": {
          const id = needId();
          if (!id) return missingId();
          const r = await tc.cronGet(id);
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) return recordResult(callId, { tool: "cron", error: r.code }, text(`[error] ${r.message}`), true);
          return recordResult(callId, { tool: "cron", id }, text(fmtCronLine(r.cron)), false, undefined, false, {
            provenance: "external",
            source: "shared crons",
          });
        }
        case "runs": {
          const id = needId();
          if (!id) return missingId();
          const r = await tc.cronRuns(id, params.limit !== undefined ? { limit: params.limit } : undefined);
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) return recordResult(callId, { tool: "cron", error: r.code }, text(`[error] ${r.message}`), true);
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
            undefined,
            false,
            { provenance: "external", source: "shared crons" },
          );
        }
        case "patch": {
          const id = needId();
          if (!id) return missingId();
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
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) return recordResult(callId, { tool: "cron", error: r.code }, text(`[error] ${r.message}`), true);
          return recordResult(callId, { tool: "cron", id }, text(`Updated cron ${fmtCronLine(r.cron)}`));
        }
        case "delete": {
          const id = needId();
          if (!id) return missingId();
          const r = await tc.cronDelete(id);
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) return recordResult(callId, { tool: "cron", error: r.code }, text(`[error] ${r.message}`), true);
          return recordResult(callId, { tool: "cron", id, deleted: true }, text(`Deleted cron ${id}.`));
        }
        case "disable": {
          const id = needId();
          if (!id) return missingId();
          const r = await tc.cronSetEnabled(id, false);
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) return recordResult(callId, { tool: "cron", error: r.code }, text(`[error] ${r.message}`), true);
          return recordResult(callId, { tool: "cron", id, enabled: false }, text(`Paused cron ${id}.`));
        }
        case "run": {
          const id = needId();
          if (!id) return missingId();
          const r = await tc.cronRun(id);
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) return recordResult(callId, { tool: "cron", error: r.code }, text(`[error] ${r.message}`), true);
          return recordResult(
            callId,
            { tool: "cron", id, ran: true },
            text(`Fired cron ${id} — the run is starting now and delivers on its own when it finishes.`),
          );
        }
        case "note": {
          const id = needId();
          if (!id) return missingId();
          if (typeof params.note !== "string" || !params.note.trim()) {
            return recordResult(
              callId,
              { tool: "cron", error: "note required" },
              text("[error] cron note requires `note` (the short message the next fire reads)."),
              true,
            );
          }
          const r = await tc.cronNote(id, params.note);
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) return recordResult(callId, { tool: "cron", error: r.code }, text(`[error] ${r.message}`), true);
          return recordResult(
            callId,
            { tool: "cron", id, noted: r.applied },
            text(
              r.applied
                ? `Noted — the next fire of ${id} will see it.`
                : `[not stored] a newer shift-change note for ${id} already exists — the next fire will see that one instead.`,
            ),
          );
        }
        case "retarget": {
          const id = needId();
          if (!id) return missingId();
          if (typeof params.destinationKey !== "string" || !params.destinationKey) {
            return recordResult(
              callId,
              { tool: "cron", error: "destinationKey required" },
              text("[error] cron retarget requires `destinationKey` (a key from the delivery menu)."),
              true,
            );
          }
          const r = await tc.cronRetarget(id, params.destinationKey);
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) return recordResult(callId, { tool: "cron", error: r.code }, text(`[error] ${r.message}`), true);
          return recordResult(callId, { tool: "cron", id }, text(`Retargeted cron ${fmtCronLine(r.cron)}`));
        }
      }
    },
  });

  return { cron };
}
