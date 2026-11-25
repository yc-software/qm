import { randomUUID } from "node:crypto";
import { runTrigger, type TriggerDeps } from "../triggers/run-trigger.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { buildEventWakeEnvelope } from "../wake/wake-envelope.ts";
import { scopeId } from "../types.ts";
import { reportFailureAs } from "../util/errors.ts";

interface NewConnection {
  principal: string;
  connector: string;
  linkId: string;
  sessionId?: string | null;
}

export type ConnectionWake = (connection: NewConnection) => void;

type WakeSessions = Pick<
  SessionStore,
  "getForParticipant" | "listParticipantPage" | "getOrCreateByThread" | "addParticipant"
>;

export function returnPathSession(path: string | null | undefined): string | null {
  if (!path) return null;
  const segments = new URL(path, "http://x").pathname.split("/");
  return segments.at(-2) === "s" && segments.at(-1) ? decodeURIComponent(segments.at(-1)!) : null;
}

function connectionWakeText(connector: string, at = new Date()): string {
  return buildEventWakeEnvelope({
    reason: "connection",
    surface: "connection",
    attrs: { connector },
    at,
    why: `The person just connected ${connector}.`,
    instructions:
      "Take a quick, read-only look at what this connection lets you see, such as recent email, upcoming events, channels or repositories. Then reply here with three or four concrete things you could help with, each tied to something specific you found, and ask which to start on. Change nothing in the connected app.",
  });
}

export function createConnectionWake(deps: TriggerDeps & { sessions: WakeSessions }): ConnectionWake {
  const conversation = async (principal: string, sessionId: string | null): Promise<string> => {
    const home = scopeId("personal", principal);
    const from = sessionId ? await deps.sessions.getForParticipant(sessionId, principal) : null;
    if (from?.scopeId === home && !from.parentSessionId && from.surface === "web") return from.threadRef;
    const page = await deps.sessions.listParticipantPage(principal, { limit: 1, surface: "web", scopeId: home });
    if (page.sessions[0]) return page.sessions[0].threadRef;
    const created = await deps.sessions.getOrCreateByThread(
      `web:${principal}:${randomUUID()}`,
      "dm",
      home,
      undefined,
      "web",
    );
    await deps.sessions.addParticipant(created.id, principal);
    return created.threadRef;
  };
  return (connection) =>
    void conversation(connection.principal, connection.sessionId ?? null)
      .then((threadRef) =>
        runTrigger(deps, {
          owner: connection.principal,
          ownerScopeId: scopeId("personal", connection.principal),
          input: connectionWakeText(connection.connector),
          displayText: `Connected ${connection.connector}`,
          fireKey: `connection:${connection.linkId}`,
          surface: "connection",
          threadRef,
        }),
      )
      .then((outcome) => {
        if (outcome.note) console.warn(`[connection-wake] ${connection.connector}: ${outcome.note}`);
      })
      .catch(reportFailureAs("connection wake", undefined, `connector=${connection.connector}`));
}
