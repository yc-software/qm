import type { AttributedTurn, Participant } from "../sessions/session-store.ts";

function groupBySession(participants: Participant[]): Map<string, Participant[]> {
  const bySession = new Map<string, Participant[]>();
  for (const p of participants) {
    const arr = bySession.get(p.sessionId);
    if (arr) arr.push(p);
    else bySession.set(p.sessionId, [p]);
  }
  return bySession;
}

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
  const bySession = groupBySession(input.participants);
  for (const [sessionId, members] of bySession) {
    for (const p of members) visit.onParticipant(sessionId, p);
  }
  for (const turn of input.turns) {
    const p = bySession.get(turn.sessionId)?.find((x) => x.principalId === turn.principalId);
    if (p) visit.onTurn(p, turn);
  }
}
