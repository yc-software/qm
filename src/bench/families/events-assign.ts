import type { Check } from "../core/types.ts";
import { type Assignment, type Attendee, SLOTS, type Session, type World, assignKey, companyCap } from "./events.ts";

export function greedy(world: World, fixed: Assignment = new Map()): Assignment {
  const bySession = new Map(world.sessions.map((s) => [s.id, s] as const));
  const free = new Map(world.sessions.map((s) => [s.id, s.capacity]));
  const companyLoad = new Map<string, number>();
  const assign: Assignment = new Map();
  const place = (a: Attendee, s: Session): boolean => {
    const ck = `${s.id}|${a.company}`;
    if ((free.get(s.id) ?? 0) <= 0 || (companyLoad.get(ck) ?? 0) >= companyCap(s.capacity)) return false;
    assign.set(assignKey(a.id, s.slot), s.id);
    free.set(s.id, free.get(s.id)! - 1);
    companyLoad.set(ck, (companyLoad.get(ck) ?? 0) + 1);
    return true;
  };
  const byId = new Map(world.attendees.map((a) => [a.id, a] as const));
  for (const [k, sid] of fixed) {
    const a = byId.get(k.split("|")[0]!);
    const s = bySession.get(sid);
    if (a && s) place(a, s);
  }
  for (const slot of SLOTS) {
    for (let level = 0; level < 6; level++) {
      for (const a of world.attendees) {
        if (!a.slots.includes(slot) || assign.has(assignKey(a.id, slot))) continue;
        const s = bySession.get(a.prefs[level]!);
        if (s && s.slot === slot) place(a, s);
      }
    }
    for (const a of world.attendees) {
      if (!a.slots.includes(slot) || assign.has(assignKey(a.id, slot))) continue;
      const candidates = world.sessions
        .filter((s) => s.slot === slot)
        .sort((x, y) => free.get(y.id)! - free.get(x.id)!);
      if (!candidates.some((s) => place(a, s))) {
        const s = candidates[0]!;
        assign.set(assignKey(a.id, slot), s.id);
        free.set(s.id, free.get(s.id)! - 1);
      }
    }
  }
  return assign;
}

function seatFits(s: Session, company: string, load: Map<string, number>, companyLoad: Map<string, number>): boolean {
  return (load.get(s.id) ?? 0) < s.capacity && (companyLoad.get(`${s.id}|${company}`) ?? 0) < companyCap(s.capacity);
}

export function improve(world: World, start: Assignment, locked: Set<string> = new Set()): Assignment {
  const assign: Assignment = new Map(start);
  const bySession = new Map(world.sessions.map((s) => [s.id, s] as const));
  const byId = new Map(world.attendees.map((a) => [a.id, a] as const));
  const load = new Map<string, number>();
  const companyLoad = new Map<string, number>();
  const members = new Map<string, Set<string>>();
  const bump = (sid: string, company: string, delta: number): void => {
    load.set(sid, (load.get(sid) ?? 0) + delta);
    companyLoad.set(`${sid}|${company}`, (companyLoad.get(`${sid}|${company}`) ?? 0) + delta);
  };
  for (const [k, sid] of assign) {
    const a = byId.get(k.split("|")[0]!);
    if (!a) continue;
    bump(sid, a.company, 1);
    if (!members.has(sid)) members.set(sid, new Set());
    members.get(sid)!.add(k);
  }
  const top2 = (a: Attendee, slot: string): string[] =>
    a.prefs.filter((p) => bySession.get(p)?.slot === slot).slice(0, 2);
  const move = (k: string, a: Attendee, from: string, to: string): void => {
    assign.set(k, to);
    bump(from, a.company, -1);
    bump(to, a.company, 1);
    members.get(from)!.delete(k);
    members.get(to)!.add(k);
  };
  for (let pass = 0; pass < 8; pass++) {
    let moved = 0;
    for (const a of world.attendees) {
      for (const slot of a.slots) {
        const k = assignKey(a.id, slot);
        const cur = assign.get(k);
        if (!cur || locked.has(k)) continue;
        const wants = top2(a, slot);
        if (wants.includes(cur)) continue;
        for (const tid of wants) {
          const t = bySession.get(tid)!;
          if (seatFits(t, a.company, load, companyLoad)) {
            move(k, a, cur, tid);
            moved++;
            break;
          }
          const partner = [...(members.get(tid) ?? [])].find((mk) => {
            if (locked.has(mk)) return false;
            const m = byId.get(mk.split("|")[0]!)!;
            if (!top2(m, slot).includes(cur) || top2(m, slot).includes(tid)) return false;
            const curS = bySession.get(cur)!;
            return (
              m.company === a.company ||
              ((companyLoad.get(`${tid}|${a.company}`) ?? 0) < companyCap(t.capacity) &&
                (companyLoad.get(`${cur}|${m.company}`) ?? 0) < companyCap(curS.capacity))
            );
          });
          if (partner) {
            const m = byId.get(partner.split("|")[0]!)!;
            move(partner, m, tid, cur);
            move(k, a, cur, tid);
            moved++;
            break;
          }
        }
      }
    }
    if (moved === 0) break;
  }
  return assign;
}

export function top2Rate(world: World, assign: Assignment): number {
  let total = 0;
  let hits = 0;
  const bySession = new Map(world.sessions.map((s) => [s.id, s] as const));
  for (const a of world.attendees) {
    for (const slot of a.slots) {
      total++;
      const top = a.prefs.filter((p) => bySession.get(p)?.slot === slot).slice(0, 2);
      if (top.includes(assign.get(assignKey(a.id, slot)) ?? "")) hits++;
    }
  }
  return total === 0 ? 0 : hits / total;
}

export function constraintChecks(world: World, assign: Assignment, rows: number, baselineTop2: number): Check[] {
  const bySession = new Map(world.sessions.map((s) => [s.id, s] as const));
  const expectedKeys = world.attendees.flatMap((a) => a.slots.map((slot) => assignKey(a.id, slot)));
  const complete =
    expectedKeys.every((k) => assign.has(k)) && assign.size === expectedKeys.length && rows === expectedKeys.length;
  const load = new Map<string, number>();
  const companyLoad = new Map<string, number>();
  const byId = new Map(world.attendees.map((a) => [a.id, a] as const));
  let wrongSlot = 0;
  for (const [k, sid] of assign) {
    const [aid, slot] = k.split("|") as [string, string];
    const s = bySession.get(sid);
    if (!s || s.slot !== slot) wrongSlot++;
    load.set(sid, (load.get(sid) ?? 0) + 1);
    const company = byId.get(aid)?.company ?? "?";
    companyLoad.set(`${sid}|${company}`, (companyLoad.get(`${sid}|${company}`) ?? 0) + 1);
  }
  const overCap = world.sessions.filter((s) => (load.get(s.id) ?? 0) > s.capacity).length;
  const overCompany = [...companyLoad].filter(
    ([k, n]) => n > companyCap(bySession.get(k.split("|")[0]!)?.capacity ?? 0),
  ).length;
  const top2 = top2Rate(world, assign);
  return [
    { id: "one-session-per-registered-slot", score: complete ? 1 : 0, detail: `${assign.size}/${expectedKeys.length}` },
    { id: "session-in-right-slot", score: assign.size > 0 && wrongSlot === 0 ? 1 : 0, detail: `${wrongSlot} wrong` },
    { id: "capacity", score: assign.size > 0 && overCap === 0 ? 1 : 0, detail: `${overCap} over` },
    { id: "company-cap", score: assign.size > 0 && overCompany === 0 ? 1 : 0, detail: `${overCompany} over` },
    {
      id: "top2-vs-baseline",
      score: baselineTop2 === 0 || top2 >= 0.995 * baselineTop2 ? 1 : top2 / baselineTop2,
      detail: `${top2.toFixed(3)} vs ${baselineTop2.toFixed(3)}`,
    },
  ];
}
