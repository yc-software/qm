import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { greedy, improve } from "../../families/events-assign.ts";
import { type Assignment, assignmentCsv } from "../../families/events.ts";
import { type ChangesKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<ChangesKey>({
    id: "events-handle-scheduling-changes",
    difficulty: "hard",
    family: "events",
    origin: "research",
    evidence:
      "Garry Tan's Own Your Intelligence talk (18:27 to 19:13): scheduling attendees at scale, including re-planning when the schedule changes.",
    sources: ["https://www.youtube.com/watch?v=eRrc1pUY5oU&t=1107s"],
    outputs: ["output/assignments.csv"],
    generate,
    prompt: () =>
      "Yesterday's breakout assignments are in events/assignments.csv. Apply everything in events/changes.md following events/rules.md and write the revised list to output/assignments.csv (attendee_id,slot,session_id). " +
      "Only move people who must move: anyone whose session still exists, still has room, and still satisfies the company cap keeps their seat. Moved and late attendees get their best remaining preference. Write a script.",
    followUp: (f) =>
      `Two more changes: session ${f.key.lateCancel} is cancelled as well, and ${f.key.merged[1]} has been acquired by ${f.key.merged[0]}, so for the company cap treat everyone from ${f.key.merged[1]} as ${f.key.merged[0]}. Reseat whoever must move and rewrite output/assignments.csv.`,
    verify,
  });
}

export function gold(f: Fixture<ChangesKey>): Record<string, string> {
  const mustMove = new Set(f.key.mustMove);
  const kept: Assignment = new Map(
    Object.entries(f.key.before).filter(
      ([k]) => f.key.finalWorld.attendees.some((a) => a.id === k.split("|")[0]) && !mustMove.has(k),
    ),
  );
  return {
    "output/assignments.csv": assignmentCsv(
      improve(f.key.finalWorld, greedy(f.key.finalWorld, kept), new Set(kept.keys())),
    ),
  };
}
