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
}

export function forEachAttributedTurn(
  input: AttributionInput,
  visit: {
    onWindow: (sessionId: string, w: ParticipantWindow) => void;
    onTurn: (w: ParticipantWindow, turn: AttributedTurn) => void;
  },
): void {
  const winsBySession = groupWindowsBySession(input.participants);
  for (const [sessionId, wins] of winsBySession) {
    for (const w of wins) visit.onWindow(sessionId, w);
  }
  for (const turn of input.turns) {
    const w = winsBySession.get(turn.sessionId)?.find((x) => x.principalId === turn.principalId);
    if (w) visit.onTurn(w, turn);
  }
}
