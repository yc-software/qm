import type { ErrorLog } from "../admin/error-log.ts";
import type { Harness } from "../harness/harness.ts";
import type { SessionStateBus } from "../runs/session-state-bus.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { ScopeId } from "../types.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { headSlice } from "../util/text.ts";
import { stripTurnBoilerplate } from "./orchestrator/turn-helpers.ts";
import { TitleRejected } from "./turn-error.ts";

function fallbackSessionTitle(text: string): string | undefined {
  const clean = stripTurnBoilerplate(text).replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > 60 ? `${headSlice(clean, 59).trimEnd()}…` : clean;
}

export function createSessionTitles(deps: {
  sessions: SessionStore;
  harness: Harness;
  sessionStateBus?: SessionStateBus;
  errors?: ErrorLog;
}) {
  async function generateAndStore(
    sessionId: string,
    scopeId: ScopeId,
    transcript: string,
    principalId?: string,
    fallbackText?: string,
  ): Promise<string | undefined> {
    if (!transcript.trim()) return undefined;
    let title: string | undefined;
    try {
      title = await deps.harness.models.generateTitle?.(transcript);
    } catch (e) {
      deps.errors?.record(
        {
          category: "session_title",
          code: e instanceof TitleRejected ? `rejected_${e.rule}` : "generation_failed",
          message: errMessage(e),
          scopeLabel: scopeId,
          sessionId,
        },
        e,
      );
    }
    title ??= fallbackText ? fallbackSessionTitle(fallbackText) : undefined;
    if (title) {
      if (principalId) await deps.sessions.updateParticipantView(sessionId, principalId, { title });
      else await deps.sessions.updateTitle(sessionId, title);
    }
    return title;
  }

  const announce = async (session: { id: string; threadRef: string }) =>
    deps.sessionStateBus?.emit({
      threadRef: session.threadRef,
      sessionId: session.id,
      participants: await deps.sessions.participantsOf(session.id),
      state: "metadata",
      at: Date.now(),
    });

  function titleFromFirstMessage(
    session: { id: string; threadRef: string },
    scopeId: ScopeId,
    text: string,
  ): Promise<void> | undefined {
    const fallback = fallbackSessionTitle(text);
    if (!fallback) return undefined;
    const write = deps.sessions.updateTitle(session.id, fallback);
    void write
      .then(() => announce(session).catch(swallowAs("session title: sidebar refresh", undefined)))
      .then(async () => {
        if (!deps.harness.models.generateTitle) return;
        if (await generateAndStore(session.id, scopeId, `User:\n${stripTurnBoilerplate(text)}`))
          await announce(session);
      })
      .finally(() => deps.errors?.flush())
      .catch(swallowAs("session title", undefined));
    return write;
  }

  return { generateAndStore, titleFromFirstMessage };
}
