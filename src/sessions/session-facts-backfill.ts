import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "./session-store.ts";
import { delegatedAuthorizationOrigin, isSubagentThreadRef, sessionContextOf } from "./session-syscalls.ts";
import type { Session } from "../types.ts";

const BACKFILL_PAGE = 200;

export type SessionFactsBackfillDeps = {
  sessions: Pick<
    SessionStore,
    | "sessionFactsCursor"
    | "saveSessionFactsCursor"
    | "sessionsAfter"
    | "fillFacts"
    | "setSpawnMeta"
    | "getByThread"
    | "getForParticipant"
  >;
  runs: Pick<RunStore, "latestForThreads" | "getByDedupKey" | "get">;
};

export async function backfillSessionFacts(
  deps: SessionFactsBackfillDeps,
  opts: { deadline: number; stop: () => boolean },
): Promise<boolean> {
  let cursor = await deps.sessions.sessionFactsCursor();
  if (cursor === "done") return true;
  while (Date.now() < opts.deadline && !opts.stop()) {
    const page = await deps.sessions.sessionsAfter(cursor, BACKFILL_PAGE);
    if (!page.length) {
      await deps.sessions.saveSessionFactsCursor("done");
      console.log("[session-facts] backfill complete");
      return true;
    }
    const refs = page.map((session) => session.threadRef);
    const [latest, latestPublic] = await Promise.all([
      deps.runs.latestForThreads(refs),
      deps.runs.latestForThreads(refs, { excludePrivateMessages: true }),
    ]);
    for (const session of page)
      await fillSession(deps, session, latest.get(session.threadRef), latestPublic.get(session.threadRef));
    const last = page[page.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    await deps.sessions.saveSessionFactsCursor(cursor);
  }
  return false;
}

async function fillSession(
  deps: SessionFactsBackfillDeps,
  session: Session,
  latest: Run | undefined,
  latestPublic: Run | undefined,
): Promise<void> {
  const subagent = isSubagentThreadRef(session.threadRef);
  if (subagent && session.spawnMeta && !session.spawnMeta.authority) {
    const first = (await deps.runs.getByDedupKey(`subagent-open:${session.threadRef}`)) ?? latestPublic;
    const authority = first
      ? await delegatedAuthorizationOrigin({ ...first.request, origin: resolveTurnOrigin(first.request) }, deps)
      : undefined;
    if (authority) await deps.sessions.setSpawnMeta(session.id, { ...session.spawnMeta, authority });
  }
  const context =
    latestPublic && !subagent && !session.threadRef.startsWith("swarm:")
      ? sessionContextOf({ ...latestPublic.request, origin: resolveTurnOrigin(latestPublic.request) })
      : undefined;
  const slackBinding = latest?.request.slackSource;
  const runtime = latest?.result?.runtime;
  if (!context && !slackBinding && !runtime) return;
  await deps.sessions.fillFacts(session.id, {
    ...(slackBinding ? { slackBinding } : {}),
    ...(runtime ? { runtime } : {}),
    ...(context ? { spawnMeta: context } : {}),
  });
}
