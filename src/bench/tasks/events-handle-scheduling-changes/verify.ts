import type { Check, Outputs } from "../../core/types.ts";
import { constraintChecks } from "../../families/events-assign.ts";
import { readAssignments } from "../../families/events.ts";
import type { ChangesKey } from "./generate.ts";

export async function verify(outputs: Outputs, key: ChangesKey): Promise<Check[]> {
  const { assign, rows } = readAssignments(await outputs.read("output/assignments.csv"));
  const base = constraintChecks(key.finalWorld, assign, rows, key.baselineTop2);
  const mustMove = new Set(key.mustMove);
  const stayers = Object.keys(key.before).filter(
    (k) => key.finalWorld.attendees.some((a) => a.id === k.split("|")[0]) && !mustMove.has(k),
  );
  const unchanged = stayers.filter((k) => assign.get(k) === key.before[k]).length;
  const droppedGone =
    assign.size > 0 && key.dropped.every((d) => ![...assign.keys()].some((k) => k.startsWith(`${d}|`)));
  const lateCancelGone = assign.size > 0 && ![...assign.values()].includes(key.lateCancel);
  return [
    ...base,
    { id: "minimal-churn", score: stayers.length === 0 ? 1 : unchanged / stayers.length },
    { id: "withdrawn-removed", score: droppedGone ? 1 : 0 },
    { id: "late-cancel-applied", score: lateCancelGone ? 1 : 0 },
  ];
}
