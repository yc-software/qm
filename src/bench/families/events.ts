import type { Rng } from "../core/rng.ts";
import { csv, list, parseCsv } from "../core/text.ts";
import { COMPANY_WORDS, personName } from "../core/world.ts";

export const SLOTS = ["T1", "T2", "T3"];

const COMPANY_SHARE = 0.15;

export function companyCap(capacity: number): number {
  return Math.max(2, Math.ceil(capacity * COMPANY_SHARE));
}

export interface Session {
  id: string;
  slot: string;
  title: string;
  capacity: number;
}

export interface Attendee {
  id: string;
  name: string;
  company: string;
  slots: string[];
  prefs: string[];
}

export interface World {
  sessions: Session[];
  attendees: Attendee[];
}

const TITLES = list(`
  Pricing and packaging, Enterprise sales, Hiring your first ten, Fundraising, Infrastructure
  costs, Founder mental health, Design partners, Compliance early, Developer marketing, Cofounder
  dynamics, Board management, Churn analysis, Outbound that works, Hardware supply chains,
  Regulated markets, Community led growth, Support at scale, International expansion, Payments and
  billing, Data rooms, Security posture, Open source business, Consumer retention, Agents in
  production
`);

export function buildWorld(r: Rng, attendeeCount: number): World {
  const sessions: Session[] = TITLES.map((title, i) => ({
    id: `S${i + 1}`,
    slot: SLOTS[i % 3]!,
    title,
    capacity: r.int(40, 140),
  }));
  const companies = COMPANY_WORDS.flatMap((w) => [w, `${w} Labs`, `${w} Systems`]);
  const attendees: Attendee[] = [];
  for (let i = 1; i <= attendeeCount; i++) {
    const slots = SLOTS.filter(() => r.chance(0.75));
    if (slots.length === 0) slots.push(r.pick(SLOTS));
    const prefs = new Set<string>();
    while (prefs.size < 6) prefs.add(r.pick(sessions).id);
    attendees.push({
      id: `A${String(i).padStart(5, "0")}`,
      name: personName(r),
      company: r.pick(companies),
      slots,
      prefs: [...prefs],
    });
  }
  for (const slot of SLOTS) {
    const need = attendees.filter((a) => a.slots.includes(slot)).length * 1.08;
    const inSlot = sessions.filter((s) => s.slot === slot);
    const total = inSlot.reduce((sum, s) => sum + s.capacity, 0);
    for (const s of inSlot) s.capacity = Math.max(8, Math.round((s.capacity * need) / total));
  }
  return { sessions, attendees };
}

export type Assignment = Map<string, string>;

export function assignKey(attendee: string, slot: string): string {
  return `${attendee}|${slot}`;
}

export function readAssignments(text: string | null): { assign: Assignment; rows: number } {
  const assign: Assignment = new Map();
  const rows = parseCsv(text ?? "");
  for (const row of rows)
    assign.set(
      assignKey((row.attendee_id ?? "").toUpperCase(), (row.slot ?? "").toUpperCase()),
      (row.session_id ?? "").toUpperCase(),
    );
  return { assign, rows: rows.length };
}

function rules(): string {
  return (
    [
      "# Breakout assignment rules",
      "",
      "- The day has three time slots, T1, T2 and T3. Each session belongs to one slot.",
      "- Every attendee gets exactly one session in each slot they registered for, and none in slots they did not.",
      "- A session may not exceed its capacity.",
      `- No more than ${Math.round(COMPANY_SHARE * 100)}% of a session's capacity (rounded up, and never fewer than 2 seats) may come from the same company.`,
      "- Preferences are ranked across all slots; within a slot, honor the highest-ranked preference that fits, then the next.",
      "- Someone who can get none of their choices in a slot goes to that slot's session with the most free seats.",
    ].join("\n") + "\n"
  );
}

export function worldFiles(world: World): Record<string, string> {
  return {
    "events/rules.md": rules(),
    "events/sessions.csv": csv(
      ["session_id", "slot", "title", "capacity"],
      world.sessions.map((s) => [s.id, s.slot, s.title, s.capacity]),
    ),
    "events/attendees.csv": csv(
      ["attendee_id", "name", "company", "registered_slots", "pref1", "pref2", "pref3", "pref4", "pref5", "pref6"],
      world.attendees.map((a) => [a.id, a.name, a.company, a.slots.join(";"), ...a.prefs]),
    ),
  };
}

export function assignmentCsv(assign: Assignment): string {
  return csv(
    ["attendee_id", "slot", "session_id"],
    [...assign].sort().map(([k, sid]) => [...(k.split("|") as [string, string]), sid]),
  );
}
