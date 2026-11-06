import type { AuditLog } from "../audit/audit-log.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { DirectoryChannel, DirectoryStore } from "../directory/directory-store.ts";
import { canonicalPerson } from "../directory/person.ts";
import { isVisible } from "../directory/visibility.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { parseScopeId, scopeId, type ScopeId } from "../types.ts";
import { swallow } from "../util/errors.ts";
import { atLeast } from "./persona-schema.ts";
import type { PersonaService } from "./persona-service.ts";
import type { Persona, PersonaStore } from "./persona-store.ts";

export class PersonaLocked extends Error {
  readonly code = "persona_locked";
}

export interface ChannelPersonaDefault {
  scopeId: ScopeId;
  personaId: string;
  setBy: string;
  setAt: number;
}

interface Actor {
  id: string;
  live: boolean;
}

interface OwnerHandover {
  persona: Persona;
  to: string;
}

export type ChannelPersonaResult =
  | { status: "ok"; value: { channelId: string; channelName: string; persona: Persona | null } }
  | { status: "not_found" | "forbidden" | "disabled" | "invalid"; message: string };

export interface ChannelPersonas {
  current(scope: ScopeId): Promise<Persona | undefined>;
  all(): Promise<Array<{ channelId: string; persona: Persona }>>;
  get(actorId: string, channel: string): Promise<ChannelPersonaResult>;
  set(actor: Actor, channel: string, personaId: string | null): Promise<ChannelPersonaResult>;
  assertMayInstruct(scope: ScopeId, actor: Actor): Promise<void>;
  handovers(leaving: (principalId: string) => Promise<boolean>): Promise<OwnerHandover[]>;
  handOver(handover: OwnerHandover, by: string): Promise<void>;
  adoptOrphans(): Promise<OwnerHandover[]>;
}

export interface ChannelPersonasDeps {
  defaults: Pick<DurableMap<ChannelPersonaDefault>, "get" | "all" | "put" | "delete">;
  store: Pick<PersonaStore, "get" | "access" | "ownerGrants" | "addOwner">;
  personas: Pick<PersonaService, "role">;
  flags: Pick<FeatureFlagStore, "enabled">;
  orgScope: ScopeId;
  directory: Pick<
    DirectoryStore,
    "get" | "resolveChannel" | "channelMember" | "groupMember" | "channelMembership" | "listChannelsFor"
  >;
  isActive: (principalId: string) => boolean;
  isOrgAdmin: (principalId: string) => Promise<boolean>;
  orgAdmins: () => Promise<ReadonlyArray<{ principalId: string; createdAt?: number }>>;
  auditLog: Pick<AuditLog, "record">;
  deliveries: Pick<DeliveryStore, "enqueue">;
  now?: () => number;
}

const refuse = (status: "not_found" | "forbidden" | "disabled" | "invalid", message: string) =>
  ({ status, message }) as const;

export function createChannelPersonas(deps: ChannelPersonasDeps): ChannelPersonas {
  const now = deps.now ?? Date.now;
  const orgOn = () => deps.flags.enabled("personas", deps.orgScope);
  const channelScope = (channelId: string) => scopeId("channel", channelId);
  const seesChannel = (channel: DirectoryChannel, principalId: string) =>
    isVisible(deps.directory, principalId, {
      kind: "channel",
      channelId: channel.channelId,
      isPrivate: channel.isPrivate,
    });

  async function channelOf(channelId: string): Promise<DirectoryChannel> {
    const found = await deps.directory.resolveChannel(channelId);
    return found.kind === "one" && found.channel.channelId === channelId
      ? found.channel
      : { channelId, name: channelId };
  }

  async function visibleChannel(
    actorId: string,
    query: string,
  ): Promise<{ channel: DirectoryChannel } | ReturnType<typeof refuse>> {
    const found = await deps.directory.resolveChannel(query);
    const matches: DirectoryChannel[] = found.kind === "one" ? [found.channel] : [];
    if (found.kind === "ambiguous") matches.push(...found.candidates);
    const visible: DirectoryChannel[] = [];
    for (const channel of matches) if (await seesChannel(channel, actorId)) visible.push(channel);
    if (!visible.length) return refuse("not_found", `no channel matches "${query}"`);
    if (found.kind === "ambiguous")
      return refuse("invalid", `"${query}" matches ${visible.map((c) => `#${c.name}`).join(", ")}; name one`);
    return { channel: visible[0]! };
  }

  async function current(scope: ScopeId): Promise<Persona | undefined> {
    const { kind, ref } = parseScopeId(scope);
    if (kind !== "channel" || !ref) return undefined;
    const row = await deps.defaults.get(scope);
    if (!row || !(await orgOn())) return undefined;
    return (await deps.store.get(row.personaId)) ?? undefined;
  }

  async function mayGovern(personaId: string, actor: Actor): Promise<boolean> {
    if (!actor.live || !deps.isActive(actor.id)) return false;
    return (await deps.isOrgAdmin(actor.id)) || atLeast(await deps.personas.role(actor.id, personaId), "write");
  }

  async function displayNameOf(principalId: string): Promise<string> {
    return (await deps.directory.get(principalId))?.displayName || principalId;
  }

  async function activeOwnerName(personaId: string): Promise<string | undefined> {
    for (const grant of await deps.store.access(personaId)) {
      const { kind, ref } = parseScopeId(grant.scopeId);
      if (grant.role === "owner" && kind === "personal" && ref && deps.isActive(ref)) return displayNameOf(ref);
    }
    return undefined;
  }

  function audit(principalId: string, action: string, resource: string, scope: ScopeId, detail?: string): void {
    deps.auditLog.record({
      at: now(),
      principalId,
      action,
      resource,
      scopeLabel: scope,
      ...(detail ? { detail } : {}),
    });
  }

  async function announce(channelId: string, text: string, setAt: number): Promise<void> {
    try {
      await deps.deliveries.enqueue({
        destination: { type: "slack", target: channelId, audienceScopeId: channelScope(channelId) },
        text,
        idempotencyKey: `persona-default:${channelId}:${setAt}`,
      });
    } catch (error) {
      swallow("channel personas: channel notice", error);
    }
  }

  async function defaultAdmin(leaving: (principalId: string) => Promise<boolean>): Promise<string | undefined> {
    const admins = [...(await deps.orgAdmins())].sort(
      (a, b) =>
        (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        a.principalId.localeCompare(b.principalId),
    );
    for (const admin of admins)
      if (deps.isActive(admin.principalId) && !(await leaving(admin.principalId))) return admin.principalId;
    return undefined;
  }

  async function handovers(leaving: (principalId: string) => Promise<boolean>): Promise<OwnerHandover[]> {
    const owners = new Map<string, ScopeId[]>();
    for (const { personaId, scopeId: owner } of await deps.store.ownerGrants())
      owners.set(personaId, [...(owners.get(personaId) ?? []), owner]);
    const stays = async (owner: ScopeId) => {
      const { kind, ref } = parseScopeId(owner);
      return kind !== "personal" || (!!ref && deps.isActive(ref) && !(await leaving(ref)));
    };
    const orphaned: string[] = [];
    for (const [personaId, grants] of owners) {
      const kept = await Promise.all(grants.map(stays));
      if (!kept.includes(true)) orphaned.push(personaId);
    }
    const to = orphaned.length ? await defaultAdmin(leaving) : undefined;
    if (!to) return [];
    const result: OwnerHandover[] = [];
    for (const personaId of orphaned) {
      const persona = await deps.store.get(personaId);
      if (persona) result.push({ persona, to });
    }
    return result;
  }

  async function handOver({ persona, to }: OwnerHandover, by: string): Promise<void> {
    await deps.store.addOwner(persona.id, scopeId("personal", canonicalPerson(to)), by);
    audit(by, "persona_owner_handover", persona.id, scopeId("persona", persona.id), canonicalPerson(to));
  }

  return {
    current,

    async all() {
      const rows = await deps.defaults.all();
      if (!rows.length || !(await orgOn())) return [];
      const ids = [...new Set(rows.map((row) => row.personaId))];
      const found = new Map(await Promise.all(ids.map(async (id) => [id, await deps.store.get(id)] as const)));
      return rows.flatMap((row) => {
        const persona = found.get(row.personaId);
        const { ref } = parseScopeId(row.scopeId);
        return persona && ref ? [{ channelId: ref, persona }] : [];
      });
    },

    async get(actorId, query) {
      if (!(await orgOn())) return refuse("disabled", "channel personas need personas on for the whole organization");
      const found = await visibleChannel(actorId, query);
      if (!("channel" in found)) return found;
      const { channel } = found;
      return {
        status: "ok",
        value: {
          channelId: channel.channelId,
          channelName: channel.name,
          persona: (await current(channelScope(channel.channelId))) ?? null,
        },
      };
    },

    async set(actor, query, personaId) {
      if (!(await orgOn())) return refuse("disabled", "channel personas need personas on for the whole organization");
      const found = await visibleChannel(actor.id, query);
      if (!("channel" in found)) return found;
      const { channel } = found;
      const scope = channelScope(channel.channelId);
      const label = `#${channel.name}`;
      if (!actor.live || !deps.isActive(actor.id))
        return refuse("forbidden", `${label}'s persona is changed only by an active person, on a turn they sent`);
      const row = await deps.defaults.get(scope);
      const worn = row ? await deps.store.get(row.personaId) : null;
      if (worn && worn.id !== personaId && !(await mayGovern(worn.id, actor)))
        return refuse(
          "forbidden",
          `${label} wears the persona ${worn.name}; only its owners and writers, or an org admin, can change that`,
        );
      const setAt = now();
      const value = (persona: Persona | null) =>
        ({ status: "ok", value: { channelId: channel.channelId, channelName: channel.name, persona } }) as const;
      if (personaId === null) {
        if (!row) return value(null);
        await deps.defaults.delete(scope);
        audit(actor.id, "persona_channel_default_clear", row.personaId, scope);
        if (worn)
          await announce(
            channel.channelId,
            `This channel no longer wears the persona ${worn.name}. Its instructions, standing orders and skills are open to its members again.`,
            setAt,
          );
        return value(null);
      }
      if ((await deps.directory.channelMembership(channel.channelId, actor.id)) !== true)
        return refuse("forbidden", `only a member of ${label} can give it a persona`);
      const persona = await deps.store.get(personaId);
      const held = persona ? await deps.personas.role(actor.id, personaId) : null;
      if (!persona || !held) return refuse("not_found", "no persona with that id that you hold a role on");
      if (!atLeast(held, "owner"))
        return refuse(
          "forbidden",
          `only an owner of ${persona.name} can make it ${label}'s persona, because that shares it, with its skills, notes and credentials, with everyone in ${label}`,
        );
      if (worn?.id === persona.id) return value(persona);
      await deps.defaults.put(scope, { scopeId: scope, personaId, setBy: canonicalPerson(actor.id), setAt });
      audit(actor.id, "persona_channel_default_set", personaId, scope);
      await announce(
        channel.channelId,
        `This channel now wears the persona ${persona.name}. Only ${persona.name}'s owners and writers, and org admins, can change this channel's instructions, standing orders and skills.`,
        setAt,
      );
      return value(persona);
    },

    async assertMayInstruct(scope, actor) {
      const persona = await current(scope);
      if (!persona || (await mayGovern(persona.id, actor))) return;
      audit(actor.id, "persona_lock_refused", persona.id, scope);
      const channel = await channelOf(parseScopeId(scope).ref!);
      if (!(await seesChannel(channel, actor.id)))
        throw new PersonaLocked(
          "This change reaches a channel that wears a persona, so only that persona's owners and writers, or an org admin, can change its instructions, standing orders or skills.",
        );
      if (!actor.live)
        throw new PersonaLocked(
          `#${channel.name} wears the persona ${persona.name}, so its instructions, standing orders and skills change only on a turn that one of ${persona.name}'s owners or writers, or an org admin, sent themselves, never from an automation, a scheduled run or a forwarded request.`,
        );
      const owner = await activeOwnerName(persona.id);
      throw new PersonaLocked(
        `#${channel.name} wears the persona ${persona.name}. Only ${persona.name}'s owners and writers, or an org admin, can change its instructions, standing orders or skills; ${owner ? `ask ${owner}` : "ask an org admin"}.`,
      );
    },

    handovers,
    handOver,

    async adoptOrphans() {
      const found = await handovers(async () => false);
      for (const handover of found) await handOver(handover, handover.to);
      return found;
    },
  };
}
