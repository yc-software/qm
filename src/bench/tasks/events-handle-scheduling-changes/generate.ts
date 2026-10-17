import { rng } from "../../core/rng.ts";
import { csv } from "../../core/text.ts";
import type { Fixture } from "../../core/types.ts";
import { personName } from "../../core/world.ts";
import { greedy, improve, top2Rate } from "../../families/events-assign.ts";
import {
  type Assignment,
  type Attendee,
  SLOTS,
  type World,
  assignmentCsv,
  buildWorld,
  companyCap,
  worldFiles,
} from "../../families/events.ts";

export interface ChangesKey {
  before: Record<string, string>;
  finalWorld: World;
  dropped: string[];
  cancelled: string[];
  lateCancel: string;
  merged: [string, string];
  mustMove: string[];
  baselineTop2: number;
}

export function generate(seed: number): Fixture<ChangesKey> {
  const r = rng(seed * 4423 + 12);
  const world = buildWorld(r, r.int(5000, 7000));
  const before = greedy(world);
  const cancelled = r.sample(
    world.sessions.map((s) => s.id),
    2,
  );
  const lateCancel = r.pick(world.sessions.filter((s) => !cancelled.includes(s.id))).id;
  const allCancelled = [...cancelled, lateCancel];
  const dropped = r.sample(
    world.attendees.map((a) => a.id),
    r.int(150, 300),
  );
  const cuts = r
    .sample(
      world.sessions.filter((s) => !allCancelled.includes(s.id)),
      2,
    )
    .map((s) => ({ id: s.id, to: Math.max(8, Math.floor(s.capacity * 0.85)) }));
  const companies = [...new Set(world.attendees.map((a) => a.company))];
  const merged = r.sample(companies, 2) as [string, string];
  const late: Attendee[] = Array.from({ length: r.int(100, 200) }, (_, i) => {
    const slots = SLOTS.filter(() => r.chance(0.7));
    if (slots.length === 0) slots.push(r.pick(SLOTS));
    const prefs = new Set<string>();
    while (prefs.size < 6) prefs.add(r.pick(world.sessions.filter((s) => !allCancelled.includes(s.id))).id);
    return {
      id: `L${String(i + 1).padStart(4, "0")}`,
      name: personName(r),
      company: r.pick(companies),
      slots,
      prefs: [...prefs],
    };
  });
  const finalSessions = world.sessions
    .filter((s) => !allCancelled.includes(s.id))
    .map((s) => {
      const cut = cuts.find((c) => c.id === s.id);
      return cut ? { ...s, capacity: cut.to } : { ...s };
    });
  const remaining = world.attendees
    .filter((a) => !dropped.includes(a.id))
    .map((a) => (a.company === merged[1] ? { ...a, company: merged[0] } : a));
  const finalWorld: World = {
    sessions: finalSessions,
    attendees: [...remaining, ...late.map((a) => (a.company === merged[1] ? { ...a, company: merged[0] } : a))],
  };
  for (const slot of SLOTS) {
    const need = finalWorld.attendees.filter((a) => a.slots.includes(slot)).length * 1.05;
    const inSlot = finalWorld.sessions.filter((s) => s.slot === slot);
    const total = inSlot.reduce((sum, s) => sum + s.capacity, 0);
    if (total < need) {
      const biggest = inSlot
        .filter((s) => !cuts.some((c) => c.id === s.id))
        .sort((a, b) => b.capacity - a.capacity)[0]!;
      biggest.capacity += Math.ceil(need - total);
    }
  }
  const kept: Assignment = new Map();
  const mustMove = new Set<string>();
  const load = new Map<string, number>();
  const companyLoad = new Map<string, number>();
  const byId = new Map(finalWorld.attendees.map((a) => [a.id, a] as const));
  const capOf = new Map(finalWorld.sessions.map((s) => [s.id, s.capacity] as const));
  const rankOf = (a: Attendee, sid: string): number => {
    const i = a.prefs.indexOf(sid);
    return i === -1 ? a.prefs.length : i;
  };
  const seated = new Map<string, Array<[string, Attendee]>>();
  for (const [k, sid] of before) {
    const a = byId.get(k.split("|")[0]!);
    if (!a) continue;
    if (allCancelled.includes(sid)) {
      mustMove.add(k);
      continue;
    }
    if (!seated.has(sid)) seated.set(sid, []);
    seated.get(sid)!.push([k, a]);
  }
  for (const [sid, entries] of seated) {
    entries.sort(([ka, a], [kb, b]) => rankOf(a, sid) - rankOf(b, sid) || ka.localeCompare(kb));
    for (const [k, a] of entries) {
      const ck = `${sid}|${a.company}`;
      if (
        (load.get(sid) ?? 0) >= (capOf.get(sid) ?? 0) ||
        (companyLoad.get(ck) ?? 0) >= companyCap(capOf.get(sid) ?? 0)
      ) {
        mustMove.add(k);
        continue;
      }
      kept.set(k, sid);
      load.set(sid, (load.get(sid) ?? 0) + 1);
      companyLoad.set(ck, (companyLoad.get(ck) ?? 0) + 1);
    }
  }
  const files = {
    ...worldFiles(world),
    "events/assignments.csv": assignmentCsv(before),
    "events/late-registrations.csv": csv(
      ["attendee_id", "name", "company", "registered_slots", "pref1", "pref2", "pref3", "pref4", "pref5", "pref6"],
      late.map((a) => [a.id, a.name, a.company, a.slots.join(";"), ...a.prefs]),
    ),
    "events/changes.md":
      [
        "# Overnight changes",
        "",
        `1. Sessions ${cancelled.join(" and ")} are cancelled.`,
        `2. These attendees withdrew: ${dropped.join(", ")}.`,
        ...cuts.map((c, i) => `${3 + i}. ${c.id} moved rooms; its capacity is now ${c.to}.`),
        `${3 + cuts.length}. Late registrations in events/late-registrations.csv need seats too.`,
        `${4 + cuts.length}. ${
          finalWorld.sessions
            .filter(
              (s) =>
                s.capacity !== world.sessions.find((w) => w.id === s.id)!.capacity && !cuts.some((c) => c.id === s.id),
            )
            .map((s) => `${s.id} moved to a bigger room and now holds ${s.capacity}`)
            .join("; ") || "No other room changes"
        }.`,
        "",
        "When a session is over its limit after these changes, move the attendees who ranked it lowest, breaking ties by the lowest attendee_id staying.",
      ].join("\n") + "\n",
  };
  const baselineTop2 = top2Rate(finalWorld, improve(finalWorld, greedy(finalWorld, kept), new Set(kept.keys())));
  return {
    files,
    privateFiles: {},
    key: {
      before: Object.fromEntries(before),
      finalWorld,
      dropped,
      cancelled,
      lateCancel,
      merged,
      mustMove: [...mustMove],
      baselineTop2,
    },
  };
}
