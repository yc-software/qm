import type { App } from "./app-types.ts";
import { parseScopeId, type Session } from "../types.ts";

export async function seedSessionTurn(
  app: Pick<App, "turn">,
  actorId: string,
  session: Session,
  text: string,
): Promise<Awaited<ReturnType<App["turn"]>>> {
  const sessionScope = parseScopeId(session.scopeId);
  return app.turn({
    surface: session.surface ?? "web",
    actor: { externalId: actorId },
    conversation: {
      kind: session.type,
      threadRef: session.threadRef,
      ...(sessionScope.kind === "channel" || sessionScope.kind === "group" ? { channelRef: sessionScope.ref } : {}),
      ...(session.channelName ? { channelName: session.channelName } : {}),
    },
    text,
    spawned: true,
    async: true,
  });
}
