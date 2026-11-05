import { personIds, samePerson } from "../directory/person.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { TeamStore } from "../teams/teams.ts";
import type { Keychain } from "../credentials/keychain.ts";
import { parseScopeId, scopeId, type ScopeId, type Session } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import {
  PERSONA_ROLES,
  PersonaOwnerRequired,
  atLeast,
  type Persona,
  type PersonaAccess,
  type PersonaFields,
  type PersonaIcon,
  type PersonaRole,
  type PersonaStore,
} from "./persona-store.ts";

const personaScope = (id: string): ScopeId => scopeId("persona", id);

interface PersonaView extends Persona {
  role: PersonaRole;
}

interface PersonaDetail extends PersonaView {
  access: PersonaAccess[];
  credentials: Array<{ grantId: string; service: string; ownerId: string }>;
  forkedFromName?: string;
}

export type PersonaResult<T> =
  | { status: "ok"; value: T }
  | { status: "not_found" | "forbidden" | "disabled" }
  | { status: "invalid"; message: string };

export interface PersonaForTurn {
  persona: Persona;
  scope: ScopeId;
  role: PersonaRole;
}

export interface PersonaService {
  enabledFor(principalId: string): Promise<boolean>;
  role(principalId: string, personaId: string, contextScope?: ScopeId): Promise<PersonaRole | null>;
  list(principalId: string): Promise<PersonaResult<PersonaView[]>>;
  detail(principalId: string, id: string): Promise<PersonaResult<PersonaDetail>>;
  create(principalId: string, input: unknown): Promise<PersonaResult<PersonaView>>;
  update(principalId: string, id: string, input: unknown): Promise<PersonaResult<PersonaView>>;
  remove(principalId: string, id: string): Promise<PersonaResult<true>>;
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
const ONE_EMOJI = /^\p{RGI_Emoji}$/v;

function validIcon(value: unknown): value is PersonaIcon | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const icon = value as Record<string, unknown>;
  if (typeof icon.value !== "string" || !icon.value) return false;
  return icon.kind === "custom" || (icon.kind === "emoji" && ONE_EMOJI.test(icon.value));
}

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
  if (fields.name && fields.name.trim().length > 200) return "name must be at most 200 characters";
  if (requireName && !fields.name) return "name required";
  if (body.icon !== undefined) {
    if (!validIcon(body.icon))
      return 'icon must be {kind:"emoji",value:<one emoji>}, {kind:"custom",value:<custom emoji name>}, or null';
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
  keychain?: Pick<Keychain, "grantsForScope" | "createGrant" | "revokeGrant">;
}): PersonaService {
  const { store } = deps;
  const enabledFor = (principalId: string) => deps.flags.enabled("personas", scopeId("personal", principalId));

  async function granteeScopes(principalId: string, contextScope?: ScopeId): Promise<ScopeId[]> {
    const teams = (await deps.teams?.forTurn("", [principalId]).catch(() => [])) ?? [];
    return [
      ...personIds(principalId).map((id) => scopeId("personal", id)),
      deps.orgScope,
      ...teams.map((team) => scopeId("team", team.id)),
      ...(contextScope && parseScopeId(contextScope).kind === "channel" ? [contextScope] : []),
    ];
  }

  async function role(principalId: string, personaId: string, contextScope?: ScopeId) {
    return (await store.roles(await granteeScopes(principalId, contextScope), personaId)).get(personaId) ?? null;
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
    const grants = (await deps.keychain?.grantsForScope(personaScope(id))) ?? [];
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
      const roles = await store.roles(await granteeScopes(principalId));
      const personas = await Promise.all([...roles.keys()].map((id) => store.get(id)));
      return {
        status: "ok",
        value: personas
          .filter((persona): persona is Persona => persona !== null)
          .map((persona) => ({ ...persona, role: roles.get(persona.id)! }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    detail(principalId, id) {
      return guarded<PersonaDetail>(principalId, id, "read", async (persona, held) => {
        const source = persona.forkedFromId ? await store.get(persona.forkedFromId) : null;
        return {
          status: "ok",
          value: {
            ...persona,
            role: held,
            access: await store.access(id),
            credentials: await credentialsOf(id),
            ...(source ? { forkedFromName: source.name } : {}),
          },
        };
      });
    },
    async create(principalId, input) {
      if (!(await enabledFor(principalId))) return { status: "disabled" };
      const fields = fieldsFrom(input, true);
      if (typeof fields === "string") return { status: "invalid", message: fields };
      const forkedFromId = (input as Record<string, unknown>).forkedFromId;
      if (forkedFromId !== undefined) {
        if (typeof forkedFromId !== "string" || !(await role(principalId, forkedFromId)))
          return { status: "invalid", message: "forkedFromId must name a persona you can read" };
      }
      const persona = await store.create(
        { ...fields, name: fields.name!, ...(forkedFromId ? { forkedFromId } : {}) },
        scopeId("personal", principalId),
        principalId,
      );
      return { status: "ok", value: { ...persona, role: "owner" } };
    },
    update(principalId, id, input) {
      return guarded<PersonaView>(principalId, id, "write", async (_persona, held) => {
        const fields = fieldsFrom(input, false);
        if (typeof fields === "string") return { status: "invalid", message: fields };
        const updated = await store.update(id, fields);
        return updated ? { status: "ok", value: { ...updated, role: held } } : { status: "not_found" };
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
        const entries: Array<{ scopeId: ScopeId; role: PersonaRole }> = [];
        for (const entry of access as unknown[]) {
          const e = (entry ?? {}) as Record<string, unknown>;
          const target = typeof e.scopeId === "string" ? e.scopeId.trim() : "";
          const kind = parseScopeId(target).kind;
          if (!kind || !GRANTEE_KINDS.has(kind) || !parseScopeId(target).ref)
            return { status: "invalid", message: `scopeId must be personal:, team:, org: or channel: (got ${target})` };
          if (!PERSONA_ROLES.includes(e.role as PersonaRole))
            return { status: "invalid", message: "role must be owner, write or read" };
          entries.push({ scopeId: target, role: e.role as PersonaRole });
        }
        if (new Set(entries.map((entry) => entry.scopeId)).size !== entries.length)
          return { status: "invalid", message: "each scope may appear once" };
        try {
          await store.replaceAccess(id, entries, principalId);
        } catch (e) {
          if (e instanceof PersonaOwnerRequired) return { status: "invalid", message: e.message };
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
      if (!personaId) return null;
      if (!(await enabledFor(actorId)))
        return "Personas are turned off for this person, so this turn runs without one.";
      const persona = await store.get(personaId);
      if (!persona) return "This conversation's persona was deleted, so this turn runs without one.";
      const held = await role(actorId, personaId, contextScope);
      if (!held)
        return `This conversation uses the persona "${persona.name}", but the person who sent this message has no access to it, so this turn runs without it.`;
      return { persona, scope: personaScope(personaId), role: held };
    },
  };
}

export function personaPrompt(turn: PersonaForTurn, actorId: string): string {
  const { persona } = turn;
  const lines = [
    `## Persona: ${persona.name}`,
    `You are acting as the persona "${persona.name}" (${turn.scope}). Its skills, notes and credentials come from that scope; who is in the room and where your writes land still come from this conversation. Organization instructions take precedence over the persona's.`,
    `The sender's role on this persona is ${turn.role}${samePerson(persona.createdBy, actorId) ? " (they created it)" : ""}. Owners and writers may change it through the personas API, and add a skill to it by creating one with \`scopeId: "${turn.scope}"\` on \`POST /v1/skills\`; readers may only use it.`,
  ];
  if (persona.description.trim()) lines.push(`Purpose: ${persona.description.trim()}`);
  if (persona.instructions.trim()) lines.push("", persona.instructions.trim());
  return lines.join("\n");
}
