import { isDeepStrictEqual } from "node:util";
import type { App, AppDeps, CronCopy, VisibleCron } from "./app-types.ts";
import type { CronPatch } from "../cron/cron-store.ts";
import type { Cron, CronSchedule } from "../triggers/types.ts";
import { scopeId, type Destination } from "../types.ts";
import { principalDestination } from "../reach/reach.ts";
import { samePerson } from "../directory/person.ts";

const LINKED_FIELDS = ["runtime", "title", "action", "message", "schedule"] as const;

export function linkedChanges(before: Cron, patch: CronPatch): CronPatch {
  return Object.fromEntries(
    LINKED_FIELDS.filter((key) => patch[key] !== undefined && !isDeepStrictEqual(patch[key], before[key])).map(
      (key) => [key, patch[key]],
    ),
  );
}

export function copyStatus(c: Cron): CronCopy["status"] {
  if (c.forkedAt) return "edited";
  return c.enabled ? "on" : "paused";
}

function asCopy(c: Cron): CronCopy {
  return {
    id: c.id,
    owner: c.owner,
    status: copyStatus(c),
    ...(c.destination ? { deliversTo: c.destination.type } : {}),
  };
}

function sharingOf(cron: VisibleCron, copies: readonly Cron[], sharedBy: string | undefined): VisibleCron {
  return {
    ...cron,
    ...(copies.length ? { copies: copies.map(asCopy) } : {}),
    ...(sharedBy ? { sharedBy } : {}),
  };
}

export function withSharing(all: readonly Cron[]): (cron: VisibleCron) => VisibleCron {
  const owners = new Map(all.map((c) => [c.id, c.owner]));
  const copies = new Map<string, Cron[]>();
  for (const c of all) if (c.sharedFrom) copies.set(c.sharedFrom, [...(copies.get(c.sharedFrom) ?? []), c]);
  return (cron) => sharingOf(cron, copies.get(cron.id) ?? [], cron.sharedFrom && owners.get(cron.sharedFrom));
}

export async function sharingFor(crons: AppDeps["crons"], cron: VisibleCron): Promise<VisibleCron> {
  const source = cron.sharedFrom ? await crons.get(cron.sharedFrom) : null;
  return sharingOf(cron, await crons.copiesOf(cron.id), source?.owner);
}

function scheduleText(s: CronSchedule): string {
  if (s.cron) return `\`${s.cron}\`${s.timezone ? ` (${s.timezone})` : ""}`;
  if (s.everyMs) return `every ${Math.max(1, Math.round(s.everyMs / 60_000))} min`;
  return "once";
}

export function createCronShareMethods(
  deps: AppDeps,
  app: App,
): Pick<App, "shareCron" | "cronCopies" | "cronSharing" | "unshareCron"> {
  return {
    cronCopies: async (id) => (await deps.crons.copiesOf(id)).map(asCopy),
    cronSharing: (cron) => sharingFor(deps.crons, cron),
    async unshareCron(id, recipient) {
      const copy = (await deps.crons.copiesOf(id)).find((c) => samePerson(c.owner, recipient));
      if (copy) await deps.crons.update(copy.id, { sharedFrom: null });
    },
    async shareCron(tenant, id, recipient, by) {
      const source = await deps.crons.get(id);
      if (!source) throw new Error(`no cron ${id}`);
      if (source.script)
        throw new Error("a cron with a script can't be shared with a person: its script runs with the owner's access");
      const existing = (await deps.crons.copiesOf(id)).find((c) => samePerson(c.owner, recipient));
      if (existing) return { copy: existing, existed: true };
      const started = (await deps.admin?.adminStatusOf(tenant, { id: by, type: "internal" }))?.isAdmin === true;
      const ownerScopeId = scopeId("personal", recipient);
      const title = source.title ?? "Shared cron";
      const onSlack = (await app.directoryMember(recipient))?.slackId !== undefined;
      const home = onSlack ? null : await app.spawnSession(recipient, { scopeId: ownerScopeId, title });
      const destination: Destination = home
        ? { type: "web", target: home.session.threadRef }
        : principalDestination(recipient, recipient);
      const copy = await app.createCron({
        ownerScopeId,
        owner: recipient,
        createdBy: recipient,
        destination,
        schedule: source.schedule,
        enabled: started,
        sharedFrom: id,
        title,
        ...(source.action !== undefined ? { action: source.action } : {}),
        ...(source.message !== undefined ? { message: source.message } : {}),
        ...(source.runtime ? { runtime: source.runtime } : {}),
        ...(home ? { sessionRef: home.session.threadRef } : {}),
      });
      const sharer = (await app.directoryMember(by))?.displayName ?? by;
      const what = source.action ?? source.message ?? "";
      const linked = `It stays linked to ${sharer}'s cron, so their edits reach it until it is edited here; then it is a separate copy of its own.`;
      const text = started
        ? `${sharer} shared their cron "${title}" with you, and it is on: it runs as you, ${scheduleText(source.schedule)}, posting here.\n> ${what}\n${linked} To stop it, pause or delete cron ${copy.id}.`
        : `${sharer} wants to share their cron "${title}" with you. It would run as you, ${scheduleText(source.schedule)}, posting here.\n> ${what}\nIt is in your crons, paused. Accept by turning cron ${copy.id} on (patch enabled: true); decline by deleting it. ${linked}`;
      await app.enqueueDelivery({
        destination: home ? { ...destination, webTranscript: { kind: "reply" } } : principalDestination(recipient, by),
        text,
        idempotencyKey: `cron-shared:${copy.id}`,
      });
      return { copy, existed: false };
    },
  };
}
