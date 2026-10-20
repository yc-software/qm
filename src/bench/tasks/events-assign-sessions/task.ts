import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { assignmentCsv } from "../../families/events.ts";
import { type AssignKey, generate, solve } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<AssignKey>({
    id: "events-assign-sessions",
    difficulty: "easy",
    family: "events",
    origin: "research",
    evidence:
      "Garry Tan's Own Your Intelligence talk (18:27 to 19:13): scheduling roughly 6,000 attendees with scripts and a database.",
    sources: ["https://www.youtube.com/watch?v=eRrc1pUY5oU&t=1107s"],
    outputs: ["output/assignments.csv"],
    generate,
    prompt: (f) =>
      `Assign the ${f.key.world.attendees.length} attendees in events/attendees.csv to breakout sessions from events/sessions.csv following events/rules.md exactly. events/registration-changes.csv holds slot registrations added or dropped after attendees.csv was exported and overrides it. events/speakers.csv lists the attendee who speaks at each session; a speaker must be assigned to that session in its slot before anyone else is placed. Write output/assignments.csv with columns attendee_id,slot,session_id, one row per attendee per registered slot. Capacity and the per-company cap are hard limits. Maximize how many people get one of their top two preferences in each slot. Write a script.`,
    verify,
  });
}

export function gold(f: Fixture<AssignKey>): Record<string, string> {
  return { "output/assignments.csv": assignmentCsv(solve(f.key)) };
}
