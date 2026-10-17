import { type Rng, rng } from "../../core/rng.ts";
import type { Fixture } from "../../core/types.ts";
import { addDays, personName } from "../../core/world.ts";
import { list } from "../../core/text.ts";

interface Section {
  title: string;
  body: string;
}

export interface RefreshKey {
  original: Section[];
  changed: Record<string, { from: string; to: string }>;
  untouchedTitles: string[];
}

const TITLE_WORDS = list(`
  Office, Expenses, Office hours, Holidays, Security, Travel, Equipment, Onboarding, Wifi,
  Insurance, Parental leave, Remote work, Meetings, Interviews, Payroll, Reimbursements, Visitors,
  Mail, Printing, Calendar, Slack norms, Code review, On-call, Incident process, Data retention,
  Passwords, Laptops, Software requests, Learning budget, Conference travel, Referrals,
  Performance reviews, Promotions, Feedback, All hands, Offsites, Snacks, Bike storage, Pets,
  Guests, Badges, Desks, Lockers, Kitchen, Recycling, Phones, Email, Documents, Contracts, Vendors
`);

function splitByStamp(r: Rng, lines: string[]): [string[], string[]] {
  const ops: string[] = [];
  const people: string[] = [];
  for (const line of lines) (r.chance(0.5) ? ops : people).push(line);
  return [ops, people];
}

export function generate(seed: number): Fixture<RefreshKey> {
  const r = rng(seed * 2731 + 37);
  const titles = [...TITLE_WORDS, ...TITLE_WORDS.map((t) => `${t} (legacy)`), ...TITLE_WORDS.map((t) => `${t} FAQ`)];
  const original: Section[] = titles.map((title) => ({
    title,
    body: `${title} policy: the current value is ${r.pick(["A", "B", "C"])}${r.int(100, 999)} and the owner is ${personName(r)}.`,
  }));
  const aliasOf = new Map<string, string>();
  const aliasLines: string[] = [];
  for (const s of r.sample(original, 36)) {
    const alias = `${r.pick(["Spend", "People", "Site", "Ops", "Team"])} ${s.title.toLowerCase().replace(/[()]/g, "")}`;
    aliasLines.push(`- "${alias}" means the section "${s.title}"`);
    if (r.chance(0.4)) {
      const outer = `${r.pick(["Old", "Wiki", "Legacy"])} ${alias.toLowerCase()}`;
      aliasLines.push(`- "${outer}" means "${alias}"`);
      aliasOf.set(s.title, outer);
    } else aliasOf.set(s.title, alias);
  }
  const asOf = "2026-10-01";
  const picks = r.sample(original, 48);
  const changed: RefreshKey["changed"] = {};
  const announcements: string[] = [];
  let day = 0;
  const stamp = (): string => addDays("2026-07-01", day++);
  picks.forEach((s, i) => {
    const from = s.body.match(/[ABC]\d{3}/)![0];
    const to = `${r.pick(["D", "E", "F"])}${r.int(100, 999)}`;
    const name = aliasOf.get(s.title) ?? s.title;
    const effective = i % 4 === 3 ? addDays(asOf, r.int(5, 60)) : addDays(asOf, -r.int(0, 25));
    announcements.push(`- ${stamp()}: ${name}: the value changes from ${from} to ${to}, effective ${effective}.`);
    if (i % 5 === 1) announcements.push(`- ${stamp()}: ${name}: scratch that, the value stays at ${from}.`);
    else if (effective <= asOf) changed[s.title] = { from, to };
  });
  const [ops, people] = splitByStamp(r, announcements);
  const header = `Apply as of ${asOf}. Announcements are split across the files in updates/; apply all of them in stamp order. An announcement with a later effective date has not happened yet.`;
  const files = {
    "knowledge/handbook.md": `# Team handbook\n\n${original.map((s) => `## ${s.title}\n${s.body}\n`).join("\n")}`,
    "knowledge/aliases.md": `# Section aliases used in announcements\n\nAn alias can point at another alias.\n\n${r.shuffle(aliasLines).join("\n")}\n`,
    "updates/announcements-ops.md": `# Ops announcements\n\n${header}\n\n${ops.join("\n")}\n`,
    "updates/announcements-people.md": `# People announcements\n\n${header}\n\n${people.join("\n")}\n`,
  };
  return {
    files,
    privateFiles: {},
    key: { original, changed, untouchedTitles: original.filter((s) => !changed[s.title]).map((s) => s.title) },
  };
}
