import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { Run } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { CoordinationRepository } from "./repository.ts";

export function createCoordinationPauseGate(deps: {
  enabled: boolean;
  repository: CoordinationRepository;
  sessions: SessionStore;
}): (run: Run) => Promise<boolean> {
  return async (run) => {
    if (deps.enabled) return false;
    if (resolveTurnOrigin(run.request).kind === "peer") return true;
    const boundId = run.sessionRecordId ?? run.result?.sessionId;
    if (boundId && (await deps.repository.get("peer", boundId))?.parentId) return true;
    const session = await deps.sessions.getByThread(run.sessionId);
    return !!(session && (await deps.repository.get("peer", session.id))?.parentId);
  };
}
