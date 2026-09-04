import type { Cron, CronSchedule, Destination } from "../types.ts";
import { principalDestination } from "../reach/reach.ts";
import { personKeys } from "../directory/person.ts";
import { errMessage } from "../util/errors.ts";
import { createHash } from "node:crypto";

export interface CronEditDetail {
  schedule?: CronSchedule;
  destinationLabel?: string;
}

function scheduleClause(s: CronSchedule | undefined): string {
  if (s?.everyMs) {
    const mins = Math.round(s.everyMs / 60_000);
    if (mins < 1) return "to run more often";
    if (mins < 60) return `to run every ${mins === 1 ? "minute" : `${mins} minutes`}`;
    if (mins % 60 === 0) {
      const h = mins / 60;
      if (h % 24 === 0) return `to run every ${h === 24 ? "day" : `${h / 24} days`}`;
      return `to run every ${h === 1 ? "hour" : `${h} hours`}`;
    }
    return `to run every ${mins} minutes`;
  }
  if (s?.cron) return `to run on a new schedule (\`${s.cron}\`)`;
  return "to run on a new schedule";
}

const LIFECYCLE_VERB: Record<string, string> = {
  deleted: "deleted",
  "enabled=false": "paused",
  "enabled=true": "re-enabled",
  "archived=true": "archived",
  "archived=false": "restored",
};

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function composeCronEditNotice(args: {
  editorName: string;
  ref: string;
  place?: string;
  changes: string[];
  detail?: CronEditDetail;
}): string {
  const cron = `your ${args.ref} cron${args.place ? ` in ${args.place}` : ""}`;
  const verbs: string[] = [];
  const toClauses: string[] = [];
  for (const token of args.changes) {
    const key = token.split("=")[0]!;
    if (LIFECYCLE_VERB[token]) verbs.push(LIFECYCLE_VERB[token]!);
    else if (key === "title") verbs.push("renamed");
    else if (key === "task") toClauses.push("to do something different");
    else if (key === "schedule") toClauses.push(scheduleClause(args.detail?.schedule));
    else if (key === "destination")
      toClauses.push(
        args.detail?.destinationLabel ? `to post to ${args.detail.destinationLabel}` : "to post somewhere new",
      );
    else if (key === "unfurlLinks") toClauses.push("to change its link previews");
    else if (key === "mode") toClauses.push("to run in a different mode");
  }
  const clauses = [
    ...verbs.map((v) => `${v} ${cron}`),
    ...(toClauses.length ? [`changed ${cron} ${joinAnd(toClauses)}`] : []),
  ];
  const body = clauses.length
    ? joinAnd(clauses.map((c, i) => (i === 0 ? c : c.replace(` ${cron}`, " it"))))
    : `edited ${cron}`;
  return `Heads up: ${args.editorName} ${body}.`;
}

export interface CronEditNoticeSink {
  enqueueDelivery(input: { destination: Destination; text: string; idempotencyKey: string }): Promise<unknown>;
  directoryMember(
    principalId: string,
  ): Promise<{ displayName?: string; principalId?: string; slackId?: string } | null>;
  cronAdminUrl(cron: Cron): string | undefined;
  channelName?(channelId: string): Promise<string | undefined>;
}

export async function notifyOwnerOfCronEdit(
  sink: CronEditNoticeSink,
  args: { cron: Cron; editorId: string; changeSummary: string[]; editFingerprint: string; detail?: CronEditDetail },
  onError?: (message: string) => void,
): Promise<void> {
  const { cron } = args;
  if (cron.runAs !== "scopeShared") return;
  try {
    const [editor, owner] = await Promise.all([
      sink.directoryMember(args.editorId).catch(() => null),
      sink.directoryMember(cron.owner).catch(() => null),
    ]);
    const ownerKeys = personKeys(owner, cron.owner);
    if ([...personKeys(editor, args.editorId)].some((k) => ownerKeys.has(k))) return;
    const editKey = createHash("sha256")
      .update(`${cron.id}:${args.editorId}:${args.editFingerprint}`)
      .digest("hex")
      .slice(0, 16);
    const url = sink.cronAdminUrl(cron);
    const label = cron.title ?? "shared";
    let ref = "shared";
    if (url) ref = `<${url}|${label}>`;
    else if (cron.title) ref = `"${cron.title}"`;
    const [kind, scopeRef] = String(cron.ownerScopeId).split(":", 2) as [string, string | undefined];
    const place =
      kind === "channel" && scopeRef && sink.channelName
        ? await sink.channelName(scopeRef).catch(() => undefined)
        : undefined;
    await sink.enqueueDelivery({
      destination: principalDestination(cron.owner, args.editorId),
      text: composeCronEditNotice({
        editorName: editor?.displayName ?? args.editorId,
        ref,
        ...(place ? { place } : {}),
        changes: args.changeSummary,
        ...(args.detail ? { detail: args.detail } : {}),
      }),
      idempotencyKey: `cron-edit-notice:${cron.id}:${editKey}`,
    });
  } catch (e) {
    (onError ?? ((m) => console.warn("[cron-edit-notice]", m)))(errMessage(e));
  }
}
