import type { DirectoryStore, DirectoryChannel, DirectoryMember } from "../directory/directory-store.ts";
import { isOverheard, isUserMessage } from "../sessions/items.ts";
import { securityScreenChunks } from "../security/security-screen.ts";
import { createPerTurnStrategy } from "../memory/strategies/per-turn.ts";
import { DEFAULT_MEMORY_POLICY } from "../memory/policy.ts";
import { createTranscriptSource } from "../sessions/transcript-source.ts";
import { personKey } from "../directory/person.ts";
import { LRUCache } from "lru-cache";
import { perTenant } from "../tenant.ts";
import type { Orchestrator, OrchestratorDeps } from "./orchestrator/types.ts";
import { createSessionTitles } from "./session-title.ts";
import { renderTitleTranscript, visibleTitleItemText } from "./orchestrator/turn-helpers.ts";
import { createCompaction } from "./orchestrator/compaction.ts";
import { createSecurityObserver } from "./orchestrator/security-screen.ts";
import { handleTurn, type OrchestratorInstance } from "./orchestrator/handle-turn.ts";

export { egressClaimAllowingControlPlane, filterConnectorSkills } from "./orchestrator/turn-helpers.ts";
export type { Orchestrator, OrchestratorDeps, OrchestratorInput, SurfaceContextPuller } from "./orchestrator/types.ts";

const MIN_SESSION_LEASE_TTL_MS = 15_000;

const INSTANCE_CACHE_MAX_ENTRIES = 5_000;
const DIRECTORY_INDEX_CACHE_MAX_ENTRIES = 100;

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  if (deps.sessions.leaseTtlMs < MIN_SESSION_LEASE_TTL_MS) {
    throw new Error(
      `session lease TTL ${deps.sessions.leaseTtlMs}ms is below the ${MIN_SESSION_LEASE_TTL_MS}ms floor the turn keepalive needs`,
    );
  }
  const transcripts = createTranscriptSource(deps.sessions);
  const memoryPolicy = deps.memoryPolicy ?? DEFAULT_MEMORY_POLICY;
  const memoryStrategy =
    deps.memoryStrategy ?? createPerTurnStrategy({ harness: deps.harness.models, memory: deps.memory });
  const blobTransfer = deps.blobTransfer;

  const REACH_ROSTER_TTL_MS = 5 * 60_000;
  const reachRosterCache = perTenant(
    () =>
      new LRUCache<string, DirectoryChannel[]>({
        max: INSTANCE_CACHE_MAX_ENTRIES,
        ttl: REACH_ROSTER_TTL_MS,
      }),
  );
  async function reachableChannelsFor(directory: DirectoryStore, principalId: string): Promise<DirectoryChannel[]> {
    const cached = reachRosterCache().get(principalId);
    if (cached) return cached;
    const channels = await directory.listChannelsFor(principalId);
    reachRosterCache().set(principalId, channels);
    return channels;
  }

  const DIRECTORY_INDEX_TTL_MS = REACH_ROSTER_TTL_MS;
  const directoryIndexCache = perTenant(
    () =>
      new LRUCache<string, Map<string, DirectoryMember>>({
        max: DIRECTORY_INDEX_CACHE_MAX_ENTRIES,
        ttl: DIRECTORY_INDEX_TTL_MS,
      }),
  );
  async function directoryIndexFor(directory: DirectoryStore): Promise<Map<string, DirectoryMember>> {
    const cached = directoryIndexCache().get("org");
    if (cached) return cached;
    const byId = new Map<string, DirectoryMember>();
    for (const m of await directory.list()) byId.set(personKey(m.principalId), m);
    directoryIndexCache().set("org", byId);
    return byId;
  }

  const compaction = createCompaction(deps);

  const observeSecurityData = createSecurityObserver(deps);

  const titles = createSessionTitles({
    sessions: deps.sessions,
    harness: deps.harness,
    ...(deps.sessionStateBus ? { sessionStateBus: deps.sessionStateBus } : {}),
    ...(deps.errors ? { errors: deps.errors } : {}),
  });

  const instance: OrchestratorInstance = {
    deps,
    transcripts,
    memoryPolicy,
    memoryStrategy,
    blobTransfer,
    reachableChannelsFor,
    directoryIndexFor,
    compaction,
    observeSecurityData,
    titles,
  };
  const orchestrator: Orchestrator = {
    observeSecuritySteer({ payload, actor, conversation, sessionId }) {
      for (const chunk of securityScreenChunks("external", payload))
        void observeSecurityData(chunk, actor.id, deps.resolution.scopeFor(conversation, actor), {
          hook: "user_input",
          surface: "steer",
          origin: "ambient",
          thread: conversation.threadRef,
          ...(sessionId ? { sessionId } : {}),
        });
    },

    async regenerateTitle(sessionId, principalId, participantIds) {
      const session = await deps.sessions.get(sessionId);
      if (!session) return null;
      let entries = (await transcripts.forViewer(sessionId, principalId)).items;
      if (participantIds?.length) {
        const views = await Promise.all(
          participantIds.map(async (memberId) => (await transcripts.forViewer(sessionId, memberId)).items),
        );
        const common = new Set(views[0]!.map((entry) => entry.seq));
        for (const view of views.slice(1)) {
          const visible = new Set(view.map((entry) => entry.seq));
          for (const seq of common) if (!visible.has(seq)) common.delete(seq);
        }
        entries = entries.filter((entry) => common.has(entry.seq));
      }
      if (entries.length === 0) return null;
      const transcript = renderTitleTranscript(entries);
      const fallbackEntry = entries.find((entry) => isUserMessage(entry) && !isOverheard(entry));
      const title = await titles.generateAndStore(
        session.id,
        session.scopeId,
        transcript,
        participantIds?.length ? principalId : undefined,
        fallbackEntry ? visibleTitleItemText(fallbackEntry) : undefined,
      );
      return { title: title ?? (participantIds ? null : (session.title ?? null)) };
    },

    handleTurn: (requested) => handleTurn(instance, requested),
  };
  return orchestrator;
}
