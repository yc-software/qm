import type { AttributedTurn, ParticipantWindow } from "../sessions/session-store.ts";

function groupWindowsBySession(participants: ParticipantWindow[]): Map<string, ParticipantWindow[]> {
  const winsBySession = new Map<string, ParticipantWindow[]>();
  for (const w of participants) {
    const arr = winsBySession.get(w.sessionId);
    if (arr) arr.push(w);
    else winsBySession.set(w.sessionId, [w]);
  }
  return winsBySession;
}

export interface AttributionInput {
  participants: ParticipantWindow[];
  turns: AttributedTurn[];
  sessionIds?: Iterable<string>;
}

export function forEachAttributedTurn(
  input: AttributionInput,
  visit: {
    onWindow: (sessionId: string, w: ParticipantWindow) => void;
    onTurn: (w: ParticipantWindow, turn: AttributedTurn) => void;
  },
): void {
  const winsBySession = groupWindowsBySession(input.participants);
  const allowed = input.sessionIds ? new Set(input.sessionIds) : null;
  for (const sessionId of allowed ?? winsBySession.keys()) {
    for (const w of winsBySession.get(sessionId) ?? []) visit.onWindow(sessionId, w);
  }
  for (const turn of input.turns) {
    if (allowed && !allowed.has(turn.sessionId)) continue;
    const w = winsBySession.get(turn.sessionId)?.find((x) => x.principalId === turn.principalId);
    if (w) visit.onTurn(w, turn);
  }
}
