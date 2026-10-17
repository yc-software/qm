import { type Rng, rng } from "../../core/rng.ts";
import { csv, emailThread, list } from "../../core/text.ts";
import type { Fixture } from "../../core/types.ts";
import { COMPANY_WORDS, addDays, personName, randomPath } from "../../core/world.ts";

export interface Slot {
  time: string;
  room: string;
  company: string;
  founder: string;
  tracker: string;
}

export interface BriefKey {
  date: string;
  finalSlots: Slot[];
  removed: string[];
}

const BLOCKERS = list(`
  security review before renewal, founding designer search, pilot stuck in procurement, GPU quota,
  payments partner compliance, cofounder disagreement on roadmap, churn in the mid-market segment,
  SOC 2 audit timeline
`);

const TIMES = list(`
  09:00, 09:30, 10:00, 10:30, 11:00, 11:30, 13:00, 13:30, 14:00, 14:30, 15:00, 15:30
`);

const ROOMS = ["Room A", "Room B", "Room C", "Room D"];

interface Company {
  name: string;
  founder: string;
  domain: string;
}

interface Latest {
  date: string;
  attendee: string;
  tracker: string;
}

function tracker(r: Rng): string {
  return `OH-${1000 + r.int(1, 8999)}`;
}

function swapRoom(slot: Slot, pair: [Slot, Slot]): Slot {
  if (slot.company === pair[0].company) return { ...slot, room: pair[1].room };
  if (slot.company === pair[1].company) return { ...slot, room: pair[0].room };
  return slot;
}

function thread(r: Rng, c: Company, latestDate: string): { text: string; latest: Latest } {
  const cofounder = personName(r);
  const swapFounder = r.chance(0.35);
  const current = tracker(r);
  const from = `${c.founder} <${c.founder.split(" ")[0]!.toLowerCase()}@${c.domain}>`;
  const text = emailThread([
    {
      from,
      date: addDays(latestDate, -r.int(6, 12)),
      subject: "Update",
      body: `Blocker: ${r.pick(BLOCKERS)}.\nTracking: ${tracker(r)}${r.chance(0.3) ? `\n${cofounder} (my cofounder) will attend office hours instead of me.` : ""}`,
    },
    {
      from: "Dana <partners@lumen.example>",
      date: addDays(latestDate, -5),
      subject: "Update",
      body: "Thanks, noted. Anything new before office hours?",
    },
    {
      from,
      date: latestDate,
      subject: "Update",
      body: `Blocker now: ${r.pick(BLOCKERS)}.\nTracking: ${current}${swapFounder ? `\n${cofounder} (my cofounder) will attend office hours instead of me.` : "\nI will be there myself."}`,
    },
  ]);
  return { text, latest: { date: latestDate, attendee: swapFounder ? cofounder : c.founder, tracker: current } };
}

function updates(r: Rng, companies: Company[], date: string, files: Record<string, string>): Map<string, Latest> {
  const latest = new Map<string, Latest>();
  for (const c of companies) {
    const dates = r.sample([1, 2, 3, 4, 5], r.chance(0.4) ? 2 : 1).map((d) => addDays(date, -d));
    for (const d of dates) {
      const t = thread(r, c, d);
      files[randomPath(r, files, "updates")] = t.text;
      const prev = latest.get(c.name);
      if (!prev || prev.date < d) latest.set(c.name, t.latest);
    }
  }
  return latest;
}

export function generate(seed: number): Fixture<BriefKey> {
  const r = rng(seed * 31337 + 3);
  const date = addDays("2026-09-08", r.int(0, 60));
  const companies: Company[] = r.sample(COMPANY_WORDS, 56).map((name) => ({
    name,
    founder: personName(r),
    domain: `${name.toLowerCase()}${r.chance(0.3) ? "hq" : ""}.example`,
  }));
  const scheduled = companies.slice(0, 40).map((c) => c.name);
  const pool = companies.slice(40).map((c) => c.name);
  const founders = new Map(companies.map((c) => [c.name, c.founder] as const));
  const slots: Slot[] = scheduled.map((company, i) => ({
    time: TIMES[Math.floor(i / 4)]!,
    room: ROOMS[i % 4]!,
    company,
    founder: founders.get(company)!,
    tracker: "",
  }));
  const [cancelA, cancelB, keepBack, reCancel, moved, movedAgain] = r.sample(scheduled, 6) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const [added, addedThenDropped] = r.sample(pool, 2) as [string, string];
  const swap1 = slots.filter((s) => s.time === TIMES[2] && s.room <= "Room B") as [Slot, Slot];
  const swap2 = slots.filter((s) => s.time === TIMES[5] && s.room >= "Room C") as [Slot, Slot];
  const chat = [
    `[08:02] Dana: ${cancelA} cancelled, founder is travelling.`,
    `[08:10] Priya: ${keepBack} asked to cancel too.`,
    `[08:14] Priya: ${reCancel} also wants out.`,
    `[08:31] Dana: Adding ${added} at ${TIMES[10]} in Room B.`,
    `[08:40] Priya: ${moved} needs to move to ${TIMES[10]}, Room A.`,
    `[08:52] Dana: ${movedAgain} moves to ${TIMES[11]}, Room C.`,
    `[09:05] Dana: Also adding ${addedThenDropped} at ${TIMES[11]} Room A.`,
    `[09:12] Priya: Actually keep ${keepBack} on the schedule, they sorted it out.`,
    `[09:15] Priya: Same for ${reCancel}, keep them.`,
    `[09:20] Dana: ${cancelB} is out, no reschedule.`,
    `[09:41] Priya: swap rooms for ${swap1[0].company} and ${swap1[1].company}, the projector is broken.`,
    `[09:50] Dana: swap ${swap2[0].company} and ${swap2[1].company} too, same reason.`,
    `[10:02] Dana: ${movedAgain} can't do ${TIMES[11]} after all, put them at ${TIMES[10]} Room C.`,
    `[10:15] Dana: ${addedThenDropped} can't make it after all, drop them.`,
    `[10:30] Priya: never mind the ${swap2[0].company} swap, that projector is fixed.`,
    `[10:44] Dana: ${reCancel} is definitely out now, founder is sick.`,
  ];
  const files: Record<string, string> = {
    "calendar/schedule.json":
      JSON.stringify({ date, slots: slots.map((s) => ({ time: s.time, room: s.room, company: s.company })) }, null, 2) +
      "\n",
    "calendar/changes-chat.md": `# #office-hours-ops, ${addDays(date, -1)}\n\n${chat.join("\n")}\n`,
    "directory/companies.csv": csv(
      ["company", "email_domain", "founder"],
      companies.map((c) => [c.name, c.domain, c.founder]),
    ),
  };
  const latest = updates(r, companies, date, files);
  const withAdds: Slot[] = [
    ...slots,
    { time: TIMES[10]!, room: "Room B", company: added, founder: founders.get(added)!, tracker: "" },
  ];
  const finalSlots = withAdds
    .filter((s) => ![cancelA, cancelB, reCancel].includes(s.company))
    .map((s) => (s.company === moved ? { ...s, time: TIMES[10]!, room: "Room A" } : s))
    .map((s) => (s.company === movedAgain ? { ...s, time: TIMES[10]!, room: "Room C" } : s))
    .map((s) => swapRoom(s, swap1))
    .map((s) => ({ ...s, founder: latest.get(s.company)!.attendee, tracker: latest.get(s.company)!.tracker }))
    .sort((a, b) => a.time.localeCompare(b.time) || a.room.localeCompare(b.room));
  return {
    files,
    privateFiles: {},
    key: { date, finalSlots, removed: [cancelA, cancelB, reCancel, addedThenDropped] },
  };
}
