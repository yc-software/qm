import { asArray, asRecord, f1, parseJson, str } from "../../core/text.ts";
import type { Check, Outputs } from "../../core/types.ts";
import type { BriefKey, Slot } from "./generate.ts";

export async function verify(outputs: Outputs, key: BriefKey): Promise<Check[]> {
  const o = asRecord(parseJson(await outputs.read("output/brief.json")));
  const slots = asArray(o.slots).map(asRecord);
  const by = new Map(slots.map((s) => [str(s.company).toLowerCase(), s] as const));
  const hit = (pick: (s: Slot) => string, field: string): number =>
    key.finalSlots.filter((s) => str(by.get(s.company.toLowerCase())?.[field]).toUpperCase() === pick(s).toUpperCase())
      .length / key.finalSlots.length;
  const keyOf = (s: Record<string, unknown>): string => `${str(s.time)}${str(s.room)}`;
  const inOrder = slots.every((s, i) => i === 0 || keyOf(slots[i - 1]!) <= keyOf(s));
  return [
    {
      id: "schedule-after-changes",
      score:
        slots.length === key.finalSlots.length && by.size === slots.length
          ? f1(
              key.finalSlots.map((s) => s.company),
              slots.map((s) => str(s.company)),
            )
          : 0,
    },
    {
      id: "removed-left-out",
      score: slots.length > 0 && key.removed.every((c) => !by.has(c.toLowerCase())) ? 1 : 0,
    },
    { id: "times", score: hit((s) => s.time, "time") },
    { id: "rooms-after-swap", score: hit((s) => s.room, "room") },
    { id: "attending-founder", score: hit((s) => s.founder, "founder") },
    { id: "current-tracking-ids", score: hit((s) => s.tracker, "tracking") },
    { id: "ordered", score: slots.length > 0 && inOrder ? 1 : 0 },
  ];
}
