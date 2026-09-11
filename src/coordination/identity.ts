import { isDeepStrictEqual } from "node:util";
import type { ScopeId } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { CoordinationRepository, CoordinationRunFence } from "./repository.ts";
import { CoordinationError, publicPeer, type Character, type Peer, type PeerAuthority } from "./types.ts";

export const DEFAULT_DESCENDANT_LIMIT = 16;
const MAX_CHARACTER_BYTES = 16_384;

export function characterObject(input: unknown): Character {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CoordinationError(400, "invalid_character", "character must be a JSON object");
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new CoordinationError(400, "invalid_character", "character must be a JSON object");
  }
  const decoded: unknown = JSON.parse(encoded);
  if (!isDeepStrictEqual(input, decoded) || /\\u0000|\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/.test(encoded))
    throw new CoordinationError(400, "invalid_character", "character must contain portable JSON values");
  if (Buffer.byteLength(encoded) > MAX_CHARACTER_BYTES)
    throw new CoordinationError(400, "character_too_large", `character exceeds ${MAX_CHARACTER_BYTES} bytes`);
  return decoded as Character;
}

export function peerName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 120 || /[\u0000-\u001f]/.test(value))
    throw new CoordinationError(400, "invalid_name", "name must contain 1–120 printable characters");
  return value;
}

export function createPeerIdentity(
  repository: CoordinationRepository,
  history?: { sessions: SessionStore; runs: RunStore },
) {
  async function historicalAuthority(id: string, scopeId: ScopeId): Promise<PeerAuthority | null> {
    const session = await history!.sessions.get(id);
    if (!session || session.scopeId !== scopeId) return null;
    const run = await history!.runs.firstExecutedForSession(session.threadRef, session.id);
    if (!run) return null;
    const { actor, conversation, surface, scopeVersion } = run.request;
    if (
      actor.type !== "internal" ||
      conversation.threadRef !== session.threadRef ||
      conversation.kind !== session.type ||
      conversationScope(conversation, actor.id) !== scopeId
    )
      return null;
    return {
      actor,
      conversation,
      surface: surface ?? session.surface ?? "web",
      ...(scopeVersion ? { scopeVersion } : {}),
    };
  }
  return {
    async ensure(input: { id: string; scopeId: ScopeId; authority?: PeerAuthority; now?: number }): Promise<Peer> {
      const observed = await repository.get("peer", input.id);
      let authority: PeerAuthority | null | undefined;
      if (!observed?.authority)
        authority = history ? await historicalAuthority(input.id, input.scopeId) : input.authority;
      return repository.transaction([`peer:${input.id}`], async (tx) => {
        const existing = await tx.get("peer", input.id);
        if (existing) {
          if (existing.scopeId !== input.scopeId)
            throw new CoordinationError(409, "peer_scope_changed", "session scope differs from its peer identity");
          if (existing.state !== "deleted" && !existing.authority && authority) {
            const updated = { ...existing, authority };
            await tx.put("peer", updated);
            return updated;
          }
          return existing;
        }
        const now = input.now ?? Date.now();
        const peer: Peer = {
          id: input.id,
          scopeId: input.scopeId,
          name: `Agent ${input.id.slice(0, 8)}`,
          character: {},
          version: 1,
          parentId: null,
          rootId: input.id,
          ancestors: [],
          descendantLimit: DEFAULT_DESCENDANT_LIMIT,
          state: "active",
          authority: authority ?? null,
          sandboxId: null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.put("peer", peer);
        await tx.event("peer", peer.id, now);
        return peer;
      });
    },
    async get(id: string) {
      const peer = await repository.get("peer", id);
      return peer ? publicPeer(peer) : null;
    },
    async list() {
      return (await repository.list("peer")).filter((peer) => peer.state !== "deleted").map(publicPeer);
    },
    async replace(
      id: string,
      expectedVersion: number,
      input: { character: unknown; name?: string },
      fence?: CoordinationRunFence,
    ) {
      const character = characterObject(input.character);
      const name = input.name === undefined ? undefined : peerName(input.name);
      return repository.transaction(
        [`peer:${id}`],
        async (tx) => {
          const peer = await tx.get("peer", id);
          if (!peer || peer.state === "deleted") throw new CoordinationError(404, "peer_not_found", "agent not found");
          if (peer.version !== expectedVersion)
            throw new CoordinationError(
              409,
              "character_conflict",
              "character changed; read the current version before retrying",
              { version: peer.version },
            );
          const updated = {
            ...peer,
            character,
            name: name ?? peer.name,
            version: peer.version + 1,
            updatedAt: Date.now(),
          };
          await tx.put("peer", updated);
          await tx.event("peer", id, updated.updatedAt);
          return publicPeer(updated);
        },
        fence,
      );
    },
  };
}

export type PeerIdentity = ReturnType<typeof createPeerIdentity>;
