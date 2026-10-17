import type { Check, Outputs } from "../../core/types.ts";
import { constraintChecks } from "../../families/events-assign.ts";
import { readAssignments } from "../../families/events.ts";
import { type AssignKey, fixedSeats } from "./generate.ts";

export async function verify(outputs: Outputs, key: AssignKey): Promise<Check[]> {
  const { assign, rows } = readAssignments(await outputs.read("output/assignments.csv"));
  const fixed = fixedSeats(key);
  const seated = [...fixed].filter(([k, sid]) => assign.get(k) === sid).length;
  return [
    ...constraintChecks(key.world, assign, rows, key.baselineTop2),
    { id: "speakers-in-their-session", score: seated === fixed.size ? 1 : 0, detail: `${seated}/${fixed.size}` },
  ];
}
