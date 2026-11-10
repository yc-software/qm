import { personIds } from "../directory/person.ts";
import { swallowAs } from "../util/errors.ts";
import { validProjectIcon } from "../projects/project-store.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { TeamStore } from "../teams/teams.ts";
import type { Keychain } from "../credentials/keychain.ts";
import { parseScopeId, scopeId, type ScopeId, type Session } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { PERSONA_ROLES, activeHolder, atLeast, type PersonaRole } from "./persona-schema.ts";
import {
  PersonaChannelPinned,
  PersonaOwnerRequired,
  type PersonaAccessEntry,
  type Persona,
  type PersonaAccess,
  type PersonaFields,
  type PersonaStore,
  type PersonaVersionPage,
} from "./persona-store.ts";

const personaScope = (id: string): ScopeId => scopeId("persona", id);

interface PersonaView extends Persona {
  role: PersonaRole;
}

interface PersonaDetail extends PersonaView {
  access: Array<PersonaAccess & { personasEnabled: boolean }>;
  credentials: Array<{ grantId: string; service: string; ownerId: string }>;
}

export type PersonaResult<T> =
  | { status: "ok"; value: T }
  | { status: "not_found" | "forbidden" | "disabled" }
  | { status: "invalid"; message: string };

export interface PersonaForTurn {
  persona: Persona;
  scope: ScopeId;
  pinned?: boolean;
}

export interface PersonaService {
  enabledFor(principalId: string): Promise<boolean>;
  role(principalId: string, personaId: string, contextScope?: ScopeId): Promise<PersonaRole | null>;
  list(principalId: string): Promise<PersonaResult<PersonaView[]>>;
  detail(principalId: string, id: string): Promise<PersonaResult<PersonaDetail>>;
  create(principalId: string, input: unknown): Promise<PersonaResult<PersonaView>>;
  update(principalId: string, id: string, input: unknown): Promise<PersonaResult<PersonaView>>;
  remove(principalId: string, id: string): Promise<PersonaResult<true>>;
  versions(
    principalId: string,
    id: string,
    page: { before?: number; limit: number; full?: boolean },
  ): Promise<PersonaResult<PersonaVersionPage>>;
  restore(principalId: string, id: string, version: number): Promise<PersonaResult<PersonaView>>;
  setAccess(principalId: string, id: string, access: unknown): Promise<PersonaResult<PersonaAccess[]>>;
  attachCredential(principalId: string, id: string, credentialId: unknown): Promise<PersonaResult<{ grantId: string }>>;
  detachCredential(principalId: string, id: string, grantId: string): Promise<PersonaResult<true>>;
  assign(
    principalId: string,
    session: Pick<Session, "id" | "scopeId">,
    personaId: string | null,
  ): Promise<PersonaResult<PersonaView | null>>;
  forTurn(
    personaId: string | undefined,
    actorId: string,
    contextScope: ScopeId,
  ): Promise<PersonaForTurn | string | null>;
}

const GRANTEE_KINDS = new Set(["personal", "team", "org", "channel"]);
function fieldsFrom(input: unknown, requireName: boolean): PersonaFields | string {
  if (!input || typeof input !== "object") return "expected an object";
  const body = input as Record<string, unknown>;
  const fields: PersonaFields = {};
  for (const key of ["name", "description", "instructions"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") return `${key} must be a string`;
    fields[key] = body[key];
  }
  if (fields.name !== undefined && !fields.name.trim()) return "name must not be empty";
  if (requireName && !fields.name) return "name required";
  if (body.icon !== undefined) {
    if (!validProjectIcon(body.icon))
      return 'icon must be {kind:"emoji",value:<one emoji>}, {kind:"custom",name:<custom emoji name>}, or null';
    fields.icon = body.icon;
  }
  return fields;
}

export function createPersonaService(deps: {
  store: PersonaStore;
  flags: Pick<FeatureFlagStore, "enabled">;
  orgScope: ScopeId;
  teams?: Pick<TeamStore, "forTurn">;
  sessions: Pick<SessionStore, "setPersona">;
  isActive: (principalId: string) => boolean;
  channelMember: (channelId: string, principalId: string) => Promise<boolean>;
  keychain?: Pick<Keychain, "grantsForScope" | "createGrant" | "revokeGrant">;
}): PersonaService {
  const { store } = deps;
  const enabledFor = (principalId: string) => deps.flags.enabled("personas", scopeId("personal", principalId));

  async function granteeScopes(principalId: string, contextScope?: ScopeId): Promise<ScopeId[]> {
    const teams = (await deps.teams?.forTurn("", [principalId])) ?? [];
    return [
      ...personIds(principalId).map((id) => scopeId("personal", id)),
      deps.orgScope,
      ...teams.map((team) => scopeId("team", team.id)),
      ...(contextScope && parseScopeId(contextScope).kind === "channel" ? [contextScope] : []),
    ];
  }

  async function editorChannels(principalId: string): Promise<ScopeId[]> {
    if (!deps.isActive(principalId)) return [];
    const channels = await store.writerChannels();
    const member = await Promise.all(
      channels.map((channel) =>
        deps
          .channelMember(parseScopeId(channel).ref!, principalId)
          .catch(swallowAs("personas: channel editors", false)),
      ),
    );
    return channels.filter((_, i) => member[i]);
  }

  async function role(principalId: string, personaId: string, contextScope?: ScopeId) {
    const [direct, viaChannel] = await Promise.all([
      store.roles(await granteeScopes(principalId, contextScope), personaId),
      editorChannels(principalId).then((channels) => (channels.length ? store.roles(channels, personaId) : new Map())),
    ]);
    const held = direct.get(personaId) ?? null;
    return viaChannel.get(personaId) === "write" && !atLeast(held, "write") ? "write" : held;
  }

  async function guarded<T>(
    principalId: string,
    id: string,
    floor: PersonaRole,
    fn: (persona: Persona, role: PersonaRole) => Promise<PersonaResult<T>>,
  ): Promise<PersonaResult<T>> {
    if (!(await enabledFor(principalId))) return { status: "disabled" };
    const persona = await store.get(id);
    const held = persona ? await role(principalId, id) : null;
    if (!persona || !held) return { status: "not_found" };
    if (!atLeast(held, floor)) return { status: "forbidden" };
    return fn(persona, held);
  }

  async function credentialsOf(id: string) {
    const grants = (await deps.keychain?.grantsForScope(personaScope(id), { includePersonGrants: true })) ?? [];
    return grants.map(({ grant, credential }) => ({
      grantId: grant.id,
      service: credential.service,
      ownerId: credential.ownerId,
    }));
  }

  return {
    enabledFor,
    role,
    async list(principalId) {
      if (!(await enabledFor(principalId))) return { status: "disabled" };
      const [direct, channels] = await Promise.all([granteeScopes(principalId), editorChannels(principalId)]);
      const listed = new Map((await store.listFor(direct)).map((persona) => [persona.id, persona]));
      for (const persona of channels.length ? await store.listFor(channels) : [])
        if (persona.role === "write" && !atLeast(listed.get(persona.id)?.role, "write"))
          listed.set(persona.id, persona);
      return { status: "ok", value: [...listed.values()] };
    },
    detail(principalId, id) {
      return guarded<PersonaDetail>(principalId, id, "read", async (persona, held) => {
        const orgEnabled = await deps.flags.enabled("personas", deps.orgScope);
        const access = await Promise.all(
          (await store.access(id)).map(async (grant) => {
            const { kind, ref } = parseScopeId(grant.scopeId);
            return { ...grant, personasEnabled: kind === "personal" ? await enabledFor(ref) : orgEnabled };
          }),
        );
        return { status: "ok", value: { ...persona, role: held, access, credentials: await credentialsOf(id) } };
      });
    },
    async create(principalId, input) {
      if (!(await enabledFor(principalId))) return { status: "disabled" };
      const fields = fieldsFrom(input, true);
      if (typeof fields === "string") return { status: "invalid", message: fields };
      const persona = await store.create(
        { ...fields, name: fields.name! },
        scopeId("personal", principalId),
        principalId,
      );
      return { status: "ok", value: { ...persona, role: "owner" } };
    },
    update(principalId, id, input) {
      return guarded<PersonaView>(principalId, id, "write", async (_persona, held) => {
        const fields = fieldsFrom(input, false);
        if (typeof fields === "string") return { status: "invalid", message: fields };
        const updated = await store.update(id, fields, principalId);
        return updated ? { status: "ok", value: { ...updated, role: held } } : { status: "not_found" };
      });
    },
    versions(principalId, id, page) {
      return guarded<PersonaVersionPage>(principalId, id, "read", async () => ({
        status: "ok",
        value: await store.versions(id, page),
      }));
    },
    restore(principalId, id, version) {
      return guarded<PersonaView>(principalId, id, "write", async (_persona, held) => {
        const snapshot = await store.version(id, version);
        if (!snapshot) return { status: "not_found" };
        const { name, description, instructions, icon } = snapshot;
        const restored = await store.update(
          id,
          { name, description, instructions, icon: icon ?? null },
          principalId,
          version,
        );
        return restored ? { status: "ok", value: { ...restored, role: held } } : { status: "not_found" };
      });
    },
    remove(principalId, id) {
      return guarded<true>(principalId, id, "owner", async () => {
        for (const credential of await credentialsOf(id))
          await deps.keychain?.revokeGrant(credential.ownerId, credential.grantId);
        return (await store.remove(id)) ? { status: "ok", value: true } : { status: "not_found" };
      });
    },
    setAccess(principalId, id, access) {
      return guarded<PersonaAccess[]>(principalId, id, "owner", async () => {
        if (!Array.isArray(access)) return { status: "invalid", message: "access must be an array" };
        const entries: PersonaAccessEntry[] = [];
        for (const entry of access as unknown[]) {
          const e = (entry ?? {}) as Record<string, unknown>;
          const target = typeof e.scopeId === "string" ? e.scopeId.trim() : "";
          const kind = parseScopeId(target).kind;
          if (!kind || !GRANTEE_KINDS.has(kind) || !parseScopeId(target).ref)
            return { status: "invalid", message: `scopeId must be personal:, team:, org: or channel: (got ${target})` };
          if (!PERSONA_ROLES.includes(e.role as PersonaRole))
            return { status: "invalid", message: "role must be owner, write or read" };
          if (kind === "channel" && e.role === "owner")
            return { status: "invalid", message: "a Slack channel can be given read or write access, not owner" };
          if (e.pinned !== undefined && typeof e.pinned !== "boolean")
            return { status: "invalid", message: "pinned must be a boolean" };
          if (e.pinned && kind !== "channel")
            return { status: "invalid", message: "only a Slack channel can be pinned" };
          entries.push({ scopeId: target, role: e.role as PersonaRole, ...(e.pinned ? { pinned: true } : {}) });
        }
        if (new Set(entries.map((entry) => entry.scopeId)).size !== entries.length)
          return { status: "invalid", message: "each scope may appear once" };
        const staysOwner = ({ scopeId: holder, role }: { scopeId: ScopeId; role: PersonaRole }) =>
          role === "owner" && activeHolder(holder, deps.isActive);
        if (entries.some((entry) => entry.role === "owner") && !entries.some(staysOwner))
          return { status: "invalid", message: "a persona needs at least one active owner" };
        try {
          await store.replaceAccess(id, entries, principalId);
        } catch (e) {
          if (e instanceof PersonaOwnerRequired || e instanceof PersonaChannelPinned)
            return { status: "invalid", message: e.message };
          throw e;
        }
        return { status: "ok", value: await store.access(id) };
      });
    },
    attachCredential(principalId, id, credentialId) {
      return guarded<{ grantId: string }>(principalId, id, "owner", async (persona) => {
        if (!deps.keychain) return { status: "invalid", message: "keychain unavailable" };
        if (typeof credentialId !== "string" || !credentialId)
          return { status: "invalid", message: "credentialId required" };
        const grant = await deps.keychain.createGrant({
          credentialId,
          ownerId: principalId,
          audienceScopeId: personaScope(id),
          mode: "standing",
          purpose: `attached to persona "${persona.name}" by its owner`,
        });
        return { status: "ok", value: { grantId: grant.id } };
      });
    },
    detachCredential(principalId, id, grantId) {
      return guarded<true>(principalId, id, "owner", async () => {
        const credential = (await credentialsOf(id)).find((c) => c.grantId === grantId);
        if (!credential) return { status: "not_found" };
        await deps.keychain?.revokeGrant(credential.ownerId, grantId);
        return { status: "ok", value: true };
      });
    },
    async assign(principalId, session, personaId) {
      if (!(await enabledFor(principalId))) return { status: "disabled" };
      if (personaId === null) {
        await deps.sessions.setPersona(session.id, null);
        return { status: "ok", value: null };
      }
      const persona = await store.get(personaId);
      const held = persona ? await role(principalId, personaId, session.scopeId) : null;
      if (!persona || !held) return { status: "not_found" };
      await deps.sessions.setPersona(session.id, personaId);
      return { status: "ok", value: { ...persona, role: held } };
    },
    async forTurn(personaId, actorId, contextScope) {
      let pinned = false;
      if (!personaId && parseScopeId(contextScope).kind === "channel" && (await enabledFor(actorId))) {
        personaId = (await store.pinnedIn(contextScope)) ?? undefined;
        pinned = Boolean(personaId);
      }
      if (!personaId) return null;
      if (!(await enabledFor(actorId)))
        return "Personas are turned off for this person, so this turn runs without one.";
      const persona = await store.get(personaId);
      if (!persona) return "This conversation's persona was deleted, so this turn runs without one.";
      const held = await role(actorId, personaId, contextScope);
      if (!held)
        return `This conversation uses the persona "${persona.name}", but the person who sent this message has no access to it, so this turn runs without it.`;
      return { persona, scope: personaScope(personaId), ...(pinned ? { pinned: true } : {}) };
    },
  };
}

export function personaPrompt({ persona, scope, pinned }: PersonaForTurn): string {
  const lines = [
    `## Persona: ${persona.name}`,
    `You are acting as the persona "${persona.name}" (${scope}). Its skills, notes and credentials come from that scope; who is in the room and where your writes land still come from this conversation. Organization instructions take precedence over the persona's.`,
  ];
  if (pinned)
    lines.push(
      `This channel pinned ${persona.name}. An owner can unpin it on the persona page; one conversation can pick another persona.`,
    );
  if (persona.description.trim()) lines.push(`Purpose: ${persona.description.trim()}`);
  if (persona.instructions.trim()) lines.push("", persona.instructions.trim());
  return lines.join("\n");
}
