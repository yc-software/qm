import type { DurableMap } from "../persistence/durable-map.ts";
import { orgId as configOrgId } from "../config.ts";
import type { ScopeId } from "../types.ts";
import type { PeerIdentity } from "./types.ts";

interface RegisterPeerInput {
  sessionId: string;
  scopeId: ScopeId;
  agentName: string;
  character: Record<string, unknown>;
  executionActorId: string;
  parentSessionId?: string | null;
  swarmId?: string | null;
  depth?: number;
}

type CharacterUpdate =
  | { ok: true; identity: PeerIdentity }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "version_conflict"; characterVersion: number };

export interface PeerDirectory {
  get(sessionId: string): Promise<PeerIdentity | null>;
  list(): Promise<PeerIdentity[]>;
  register(input: RegisterPeerInput): Promise<PeerIdentity | null>;
  updateCharacter(sessionId: string, character: Record<string, unknown>, ifVersion: number): Promise<CharacterUpdate>;
  joinSwarm(
    sessionId: string,
    membership: { swarmId: string; depth: number; parentSessionId: string | null },
  ): Promise<PeerIdentity | null>;
  remove(sessionId: string): Promise<void>;
}

export function createPeerDirectory(
  backing: DurableMap<PeerIdentity>,
  opts: { now?: () => number } = {},
): PeerDirectory {
  const now = opts.now ?? Date.now;
  const mine = (identity: PeerIdentity | null): PeerIdentity | null =>
    identity && identity.orgId === configOrgId() ? identity : null;

  return {
    async get(sessionId) {
      return mine(await backing.get(sessionId));
    },
    async list() {
      const org = configOrgId();
      return (await backing.all()).filter((identity) => identity.orgId === org);
    },
    async register(input) {
      const at = now();
      const identity: PeerIdentity = {
        sessionId: input.sessionId,
        orgId: configOrgId(),
        scopeId: input.scopeId,
        agentName: input.agentName,
        character: input.character,
        characterVersion: 1,
        parentSessionId: input.parentSessionId ?? null,
        swarmId: input.swarmId ?? null,
        depth: input.depth ?? 0,
        executionActorId: input.executionActorId,
        createdAt: at,
        updatedAt: at,
      };
      return (await backing.insertIfAbsent!(input.sessionId, identity)) ? identity : null;
    },
    async updateCharacter(sessionId, character, ifVersion) {
      let conflict: number | null = null;
      const updated = await backing.update!(sessionId, (current) => {
        if (current.orgId !== configOrgId()) return current;
        if (current.characterVersion !== ifVersion) {
          conflict = current.characterVersion;
          return current;
        }
        return { ...current, character, characterVersion: current.characterVersion + 1, updatedAt: now() };
      });
      if (!updated || updated.orgId !== configOrgId()) return { ok: false, error: "not_found" };
      if (conflict !== null) return { ok: false, error: "version_conflict", characterVersion: conflict };
      return { ok: true, identity: updated };
    },
    async joinSwarm(sessionId, membership) {
      const updated = await backing.update!(sessionId, (current) =>
        current.orgId === configOrgId()
          ? {
              ...current,
              swarmId: membership.swarmId,
              depth: membership.depth,
              parentSessionId: membership.parentSessionId,
              updatedAt: now(),
            }
          : current,
      );
      return mine(updated);
    },
    async remove(sessionId) {
      await backing.deleteIf!(sessionId, (current) => current.orgId === configOrgId());
    },
  };
}
