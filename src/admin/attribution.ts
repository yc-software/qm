import type { AttributedTurn, Participant } from "../sessions/session-store.ts";

export interface AttributionInput {
  participants: Participant[];
  turns: AttributedTurn[];
}

export function forEachAttributedTurn(
  input: AttributionInput,
  visit: {
    onParticipant: (sessionId: string, p: Participant) => void;
    onTurn: (p: Participant, turn: AttributedTurn) => void;
  },
): void {
  const bySession = Map.groupBy(input.participants, (p) => p.sessionId);
  for (const [sessionId, members] of bySession) {
    for (const p of members) visit.onParticipant(sessionId, p);
  }
  for (const turn of input.turns) {
    const p = bySession.get(turn.sessionId)?.find((x) => x.principalId === turn.principalId);
    if (p) visit.onTurn(p, turn);
  }
}
