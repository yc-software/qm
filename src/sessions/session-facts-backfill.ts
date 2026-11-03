import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "./session-store.ts";
import { ownsSessionContext, sessionContextOf } from "./session-syscalls.ts";
import type { Session } from "../types.ts";

const BACKFILL_PAGE = 200;
const BACKFILL_CONCURRENCY = 8;

export type SessionFactsBackfillDeps = {
  sessions: Pick<SessionStore, "sessionFactsCursor" | "saveSessionFactsCursor" | "sessionsAfter" | "fillFacts">;
  runs: Pick<RunStore, "latestForThreads">;
};

export async function pruneRunsAfterFactsBackfill(
  deps: SessionFactsBackfillDeps & { runs: Pick<RunStore, "pruneFinished"> },
  cutoff: number,
  opts: { deadline: number; stop: () => boolean },
): Promise<number> {
  return (await backfillSessionFacts(deps, opts)) ? deps.runs.pruneFinished(cutoff, opts) : 0;
}

export async function backfillSessionFacts(
  deps: SessionFactsBackfillDeps,
  opts: { deadline: number; stop: () => boolean },
): Promise<boolean> {
  let cursor = await deps.sessions.sessionFactsCursor();
  if (cursor === "done") return true;
  while (Date.now() < opts.deadline && !opts.stop()) {
    const page = await deps.sessions.sessionsAfter(cursor, BACKFILL_PAGE);
    if (!page.length) {
      if (cursor?.copied) {
        console.log(`[session-facts] pass copied facts for ${cursor.copied} session(s); checking again`);
        cursor = { id: "", copied: 0 };
        await deps.sessions.saveSessionFactsCursor(cursor);
        continue;
      }
      await deps.sessions.saveSessionFactsCursor("done");
      console.log("[session-facts] backfill complete");
      return true;
    }
    const refs = page.map((session) => session.threadRef);
    const [latest, latestPublic] = await Promise.all([
      deps.runs.latestForThreads(refs),
      deps.runs.latestForThreads(refs, { excludePrivateMessages: true }),
    ]);
    let copied = 0;
    for (let i = 0; i < page.length; i += BACKFILL_CONCURRENCY)
      for (const wrote of await Promise.all(
        page.slice(i, i + BACKFILL_CONCURRENCY).map((session) =>
          fillSession(deps, session, latest.get(session.threadRef), latestPublic.get(session.threadRef)).catch(
            (cause: unknown) => {
              throw new Error(`session facts backfill failed for session ${session.id}`, { cause });
            },
          ),
        ),
      ))
        if (wrote) copied++;
    cursor = { id: page[page.length - 1]!.id, copied: (cursor?.copied ?? 0) + copied };
    await deps.sessions.saveSessionFactsCursor(cursor);
  }
  return false;
}

async function fillSession(
  deps: SessionFactsBackfillDeps,
  session: Session,
  latest: Run | undefined,
  latestPublic: Run | undefined,
): Promise<boolean> {
  const context =
    latestPublic && ownsSessionContext(session.threadRef, latestPublic.request)
      ? sessionContextOf({ ...latestPublic.request, origin: resolveTurnOrigin(latestPublic.request) })
      : undefined;
  const slackBinding = latest?.request.slackSource;
  const runtime = latest?.result?.runtime;
  if (!context && !slackBinding && !runtime) return false;
  return deps.sessions.fillFacts(session.id, {
    ...(slackBinding ? { slackBinding } : {}),
    ...(runtime ? { runtime } : {}),
    ...(context ? { spawnMeta: context } : {}),
  });
}
