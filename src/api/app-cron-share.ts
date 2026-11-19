import { isDeepStrictEqual } from "node:util";
import type { App, AppDeps, CronCopy, VisibleCron } from "./app-types.ts";
import type { CronPatch } from "../cron/cron-store.ts";
import type { Cron, CronOrigin, CronSchedule } from "../triggers/types.ts";
import { isSharedScope, parseScopeId, scopeId, type Destination, type ScopeId } from "../types.ts";
import { principalDestination } from "../reach/reach.ts";
import { samePerson } from "../directory/person.ts";
import { projectIdFromGroupRef } from "../projects/project-store.ts";
import { recordErrorInBinding } from "../admin/error-log.ts";

const LINKED_FIELDS = ["runtime", "title", "action", "message", "schedule"] as const;

export function linkedChanges(before: Cron, patch: CronPatch): CronPatch {
  return Object.fromEntries(
    LINKED_FIELDS.filter((key) => patch[key] !== undefined && !isDeepStrictEqual(patch[key], before[key])).map(
      (key) => [key, patch[key]],
    ),
  );
}

function copyStatus(c: Cron): CronCopy["status"] {
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

async function sharingFor(crons: AppDeps["crons"], cron: VisibleCron): Promise<VisibleCron> {
  const source = cron.sharedFrom ? await crons.get(cron.sharedFrom) : null;
  return sharingOf(cron, await crons.copiesOf(cron.id), source?.owner);
}

export function deliversToOwner(cron: Pick<Cron, "destination" | "ownerScopeId" | "owner">): boolean {
  const { kind, ref } = parseScopeId(cron.destination?.audienceScopeId ?? cron.ownerScopeId);
  return kind === "personal" && samePerson(ref, cron.owner);
}

function scheduleText(s: CronSchedule): string {
  if (s.cron) return `\`${s.cron}\`${s.timezone ? ` (${s.timezone})` : ""}`;
  if (s.everyMs) return `every ${Math.max(1, Math.round(s.everyMs / 60_000))} min`;
  return "once";
}

export function createCronShareMethods(
  deps: AppDeps,
  app: App,
): Pick<App, "shareCron" | "cronCopies" | "cronSharing" | "unshareCron" | "cronOrigin"> {
  const sessionPersona = async (threadRef: string | undefined) =>
    threadRef ? (await deps.sessions.getByThread(threadRef))?.personaId : undefined;

  async function originOf(source: Cron, runsIn: ScopeId, ownSession?: string): Promise<CronOrigin> {
    const pinned =
      source.ownerScopeId !== runsIn && isSharedScope(source.ownerScopeId)
        ? ((await deps.personas?.pinnedIn(source.ownerScopeId)) ?? undefined)
        : undefined;
    const { kind, ref } = parseScopeId(source.ownerScopeId);
    const personaId =
      (kind === "persona" ? ref : undefined) ??
      (await sessionPersona(ownSession)) ??
      (source.sessionRef !== ownSession ? await sessionPersona(source.sessionRef) : undefined) ??
      pinned;
    const projectId = kind === "group" ? projectIdFromGroupRef(ref) : null;
    const project = projectId ? await deps.projects?.get(projectId) : null;
    return {
      ...(personaId ? { personaId } : {}),
      ...(project ? { project: { id: project.id, name: project.name } } : {}),
    };
  }

  async function lendPersona(
    personaId: string | undefined,
    homeScope: ScopeId,
    recipient: string,
    by: string,
    sharer: string,
  ): Promise<{ toRecipient?: string; toSharer: string } | undefined> {
    const personas = deps.personas;
    if (!personaId || !personas) return undefined;
    const worn = await personas.forTurn(personaId, by, homeScope);
    if (!worn || typeof worn !== "object") return undefined;
    const name = worn.persona.name;
    if (await personas.role(recipient, personaId))
      return { toRecipient: `It posts as the persona ${name}.`, toSharer: `Their copy posts as the persona ${name}.` };
    const detail = await personas.detail(by, personaId);
    if (detail.status === "ok" && detail.value.role === "owner") {
      const access = [
        ...detail.value.access.map((a) => ({
          scopeId: a.scopeId,
          role: a.role,
          ...(a.pinned ? { pinned: true } : {}),
        })),
        { scopeId: scopeId("personal", recipient), role: "read" },
      ];
      if ((await personas.setAccess(by, personaId, access)).status === "ok")
        return {
          toRecipient: `It posts as the persona ${name}, which ${sharer} gave you read access to.`,
          toSharer: `Their copy posts as the persona ${name}: they now have read access to it, listed on its page.`,
        };
    }
    return {
      toSharer: `Their copy runs without the persona ${name} until its owner gives them access on the persona's page; then it posts as ${name}.`,
    };
  }

  return {
    cronOrigin: async (cron) => {
      const source = (cron.sharedFrom ? await deps.crons.get(cron.sharedFrom) : null) ?? cron;
      const origin = await originOf(source, cron.ownerScopeId, cron.sessionRef);
      if (cron.message === undefined || parseScopeId(source.ownerScopeId).kind !== "persona") return origin;
      const held = await app.personas?.forTurn(origin.personaId, cron.owner, cron.ownerScopeId);
      if (typeof held === "string")
        recordErrorInBinding(deps.errors, {
          category: "cron",
          code: "persona_unavailable",
          message: `cron ${cron.id} posts without its persona: ${held}`,
          scopeLabel: cron.ownerScopeId,
        });
      if (!held || typeof held === "string") return origin;
      const { id, name, icon } = held.persona;
      return { ...origin, persona: { id, name, ...(icon ? { icon } : {}) } };
    },
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
      const linkedTo = source.sharedFrom && !source.forkedAt ? source.sharedFrom : id;
      const existing = (await deps.crons.copiesOf(linkedTo)).find((c) => samePerson(c.owner, recipient));
      if (existing) return { copy: existing, existed: true };
      const started = (await deps.admin?.adminStatusOf(tenant, { id: by, type: "internal" }))?.isAdmin === true;
      const ownerScopeId = scopeId("personal", recipient);
      const title = source.title ?? "Shared cron";
      const onChat = (await app.directoryMember(recipient)) !== null;
      const home = onChat ? null : await app.spawnSession(recipient, { scopeId: ownerScopeId, title });
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
        sharedFrom: linkedTo,
        title,
        ...(source.action !== undefined ? { action: source.action } : {}),
        ...(source.message !== undefined ? { message: source.message } : {}),
        ...(source.runtime ? { runtime: source.runtime } : {}),
        ...(home ? { sessionRef: home.session.threadRef } : {}),
      });
      const sharer = (await app.directoryMember(by))?.displayName ?? by;
      const origin = linkedTo === id ? source : ((await deps.crons.get(linkedTo)) ?? source);
      const { personaId } = await originOf(origin, ownerScopeId);
      const persona = await lendPersona(personaId, origin.ownerScopeId, recipient, by, sharer);
      const what = source.action ?? source.message ?? "";
      const linked = `${persona?.toRecipient ? `${persona.toRecipient} ` : ""}It stays linked to ${sharer}'s cron, so their edits reach it until it is edited here; then it is a separate copy of its own.`;
      const text = started
        ? `${sharer} shared their cron "${title}" with you, and it is on: it runs as you, ${scheduleText(source.schedule)}, posting here.\n> ${what}\n${linked} To stop it, pause or delete cron ${copy.id}.`
        : `${sharer} wants to share their cron "${title}" with you. It would run as you, ${scheduleText(source.schedule)}, posting here.\n> ${what}\nIt is in your crons, paused. Accept by turning cron ${copy.id} on (patch enabled: true); decline by deleting it. ${linked}`;
      await app.enqueueDelivery({
        destination: home ? { ...destination, webTranscript: { kind: "reply" } } : principalDestination(recipient, by),
        text,
        idempotencyKey: `cron-shared:${copy.id}`,
      });
      return { copy, existed: false, ...(persona ? { note: persona.toSharer } : {}) };
    },
  };
}
