import type { App } from "./app-types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { parseScopeId, type ScopeId, type Session } from "../types.ts";

export async function startSession(
  app: Pick<App, "turn" | "forkSession" | "spawnSession" | "discardSession">,
  sessions: Pick<SessionStore, "get" | "updateTitle">,
  actorId: string,
  input: { scopeId: ScopeId; forkOf?: string; text?: string; title?: string },
): Promise<{ session: Session; refused?: string } | { error: string }> {
  const out = input.forkOf
    ? await app.forkSession(input.forkOf, actorId)
    : await app.spawnSession(actorId, { scopeId: input.scopeId, ...(input.title ? { title: input.title } : {}) });
  if (!out) return { error: "cannot start a session in this context" };
  if (input.forkOf && input.title) await sessions.updateTitle(out.session.id, input.title);
  const current = async () => (await sessions.get(out.session.id)) ?? out.session;
  if (!input.text) return { session: await current() };
  const scope = parseScopeId(out.session.scopeId);
  const turn = await app.turn({
    surface: "web",
    actor: { externalId: actorId },
    conversation: {
      kind: out.session.type,
      threadRef: out.session.threadRef,
      ...(scope.kind === "channel" || scope.kind === "group" ? { channelRef: scope.ref } : {}),
      ...(out.session.channelName ? { channelName: out.session.channelName } : {}),
    },
    text: input.text,
    spawned: true,
    async: true,
  });
  if (turn.status !== "refused") return { session: await current() };
  const reason = (turn as { reason?: string }).reason ?? "the first message was refused";
  if (input.forkOf) return { session: await current(), refused: reason };
  await app.discardSession(out.session.id, actorId);
  return { error: reason };
}
