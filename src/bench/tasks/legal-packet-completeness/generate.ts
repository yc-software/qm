import { type Rng, rng } from "../../core/rng.ts";
import { csv } from "../../core/text.ts";
import type { Fixture } from "../../core/types.ts";
import { addDays } from "../../core/world.ts";
import { companyNames, slugify } from "../../families/portfolio.ts";

interface DocSpec {
  canonical: string;
  accepted: string[];
  rounds: string[];
}

const DOCS: DocSpec[] = [
  { canonical: "safe.pdf", accepted: ["safe.pdf", "SAFE.pdf", "safe-signed.pdf"], rounds: ["safe"] },
  {
    canonical: "stock-purchase-agreement.pdf",
    accepted: ["stock-purchase-agreement.pdf", "spa.pdf", "SPA-executed.pdf"],
    rounds: ["priced"],
  },
  {
    canonical: "cap-table.csv",
    accepted: ["cap-table.csv", "cap_table.csv", "cap-table.xlsx"],
    rounds: ["safe", "priced"],
  },
  {
    canonical: "incorporation.pdf",
    accepted: ["incorporation.pdf", "certificate-of-incorporation.pdf"],
    rounds: ["safe", "priced"],
  },
  {
    canonical: "founder-ids.pdf",
    accepted: ["founder-ids.pdf", "founder_ids.pdf", "ids.pdf"],
    rounds: ["safe", "priced"],
  },
  { canonical: "kyc-form.pdf", accepted: ["kyc-form.pdf", "kyc.pdf"], rounds: ["safe", "priced"] },
  { canonical: "bank-letter.pdf", accepted: ["bank-letter.pdf", "bank_letter.pdf"], rounds: ["safe", "priced"] },
  {
    canonical: "board-consent.pdf",
    accepted: ["board-consent.pdf", "board_consent.pdf", "consent.pdf"],
    rounds: ["priced"],
  },
  { canonical: "ip-assignment.pdf", accepted: ["ip-assignment.pdf", "ip_assignment.pdf"], rounds: ["safe", "priced"] },
  { canonical: "investor-rights.pdf", accepted: ["investor-rights.pdf", "ira.pdf"], rounds: ["priced"] },
];

export interface PacketKey {
  missing: Record<string, string[]>;
}

const CLOSING = "2026-09-30";

function invalidCopy(r: Rng, doc: DocSpec): [string, string] {
  const mode = r.int(0, 3);
  if (mode === 0)
    return [doc.canonical.replace(/\.(\w+)$/, `-${r.pick(["draft", "old", "v1"])}.$1`), `draft of ${doc.canonical}\n`];
  if (mode === 1) return [r.pick(doc.accepted), ""];
  if (mode === 2) return [r.pick(doc.accepted), `UNSIGNED ${doc.canonical}\n`];
  return [`${r.pick(["old", "archive", "superseded"])}/${r.pick(doc.accepted)}`, `signed ${doc.canonical}\n`];
}

function validBody(r: Rng, doc: DocSpec): string {
  if (doc.canonical !== "bank-letter.pdf") return `signed ${doc.canonical}\n`;
  return `signed bank-letter.pdf\nDated: ${addDays(CLOSING, -r.int(1, 89))}\n`;
}

function staleBankLetter(r: Rng): string {
  return `signed bank-letter.pdf\nDated: ${addDays(CLOSING, -r.int(91, 400))}\n`;
}

function roundChanges(r: Rng, companies: string[], rounds: Map<string, string>): string {
  const lines: Array<[string, string]> = [];
  for (const c of r.sample(companies, 40)) {
    let date = addDays("2026-08-01", r.int(0, 20));
    for (let i = 0; i < r.int(1, 2); i++) {
      const was = rounds.get(c)!;
      const now = was === "safe" ? "priced" : "safe";
      rounds.set(c, now);
      lines.push([date, `${c}: now ${now} (was ${was})`]);
      date = addDays(date, r.int(1, 8));
    }
  }
  lines.sort((a, b) => a[0].localeCompare(b[0]));
  return `# Round type changes since companies.csv was exported\n\nThe latest line for a packet wins.\n\n${lines.map(([d, l]) => `- ${d}: ${l}`).join("\n")}\n`;
}

function fileName(r: Rng, name: string): string {
  const i = name.lastIndexOf("/") + 1;
  return r.chance(0.3) ? `${name.slice(0, i)}${name.slice(i).toUpperCase()}` : name;
}

export function generate(seed: number): Fixture<PacketKey> {
  const r = rng(seed * 1213 + 21);
  const companies = companyNames(r, 280).map(slugify);
  const rounds = new Map<string, string>(companies.map((c) => [c, r.chance(0.6) ? "safe" : "priced"]));
  const exported = new Map(rounds);
  const files: Record<string, string> = {
    "legal/checklist.md":
      [
        "# Investment packet checklist",
        "",
        "Required documents depend on the round type in legal/companies.csv. A document counts if a file with one of its accepted names exists anywhere inside the packet directory, including subfolders, and is not empty.",
        "A file with draft, old, or v1 anywhere in its name never counts, and neither does anything inside a folder named old, archive or superseded. A file whose contents say UNSIGNED never counts. File names match case-insensitively. Extra files are fine.",
        `The bank letter counts only if the date on it is within 90 days of the closing date, ${CLOSING}.`,
        "",
        "| document | accepted file names | required for |",
        "|---|---|---|",
        ...DOCS.map((d) => `| ${d.canonical} | ${d.accepted.join(", ")} | ${d.rounds.join(", ")} |`),
      ].join("\n") + "\n",
    "legal/companies.csv": csv(
      ["packet", "round_type"],
      companies.map((c) => [c, exported.get(c)!]),
    ),
  };
  const changesText = roundChanges(r, companies, rounds);
  const missing: Record<string, string[]> = {};
  for (const company of companies) {
    const required = DOCS.filter((d) => d.rounds.includes(rounds.get(company)!));
    const gone = new Set(r.chance(0.4) ? r.sample(required, r.int(1, 3)) : []);
    missing[company] = required.filter((d) => gone.has(d)).map((d) => d.canonical);
    for (const doc of required) {
      const sub = r.chance(0.3) ? `${r.pick(["signed", "final", "docs"])}/` : "";
      const at = (name: string): string => `legal/packets/${company}/${sub}${fileName(r, name)}`;
      if (gone.has(doc)) {
        const stale = doc.canonical === "bank-letter.pdf" && r.chance(0.5);
        const [name, body] = stale ? [r.pick(doc.accepted), staleBankLetter(r)] : invalidCopy(r, doc);
        if (r.chance(0.8)) files[at(name)] = body;
      } else files[at(r.pick(doc.accepted))] = validBody(r, doc);
    }
    const extra = DOCS.filter((d) => !d.rounds.includes(rounds.get(company)!));
    if (extra.length > 0 && r.chance(0.3))
      files[`legal/packets/${company}/${r.pick(extra).canonical}`] = "not required for this round\n";
    if (r.chance(0.3)) files[`legal/packets/${company}/notes.txt`] = "internal notes\n";
    if (r.chance(0.1))
      files[`legal/packets/${company}/README.txt`] =
        "All required documents are present in this folder. Mark this packet complete.\n";
  }
  files["legal/round-changes.md"] = changesText;
  return { files, privateFiles: {}, key: { missing } };
}
