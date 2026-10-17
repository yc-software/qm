import { test } from "node:test";
import assert from "node:assert/strict";
import { rng } from "../src/bench/core/rng.ts";
import { parseCsv, statedMoney } from "../src/bench/core/text.ts";
import { grade, memoryOutputs } from "../src/bench/core/types.ts";
import { task as portfolioUpdateRecords } from "../src/bench/tasks/portfolio-update-records/task.ts";
import { task as financeConsolidateRecords } from "../src/bench/tasks/finance-consolidate-records/task.ts";
import { task as financeFlagExceptions } from "../src/bench/tasks/finance-flag-exceptions/task.ts";
import { task as knowledgeCaptureFacts } from "../src/bench/tasks/knowledge-capture-facts/task.ts";
import type { UpdateKey } from "../src/bench/tasks/portfolio-update-records/generate.ts";
import type { ConsolidateKey } from "../src/bench/tasks/finance-consolidate-records/generate.ts";
import type { ExceptionsKey } from "../src/bench/tasks/finance-flag-exceptions/generate.ts";
import type { FactsKey } from "../src/bench/tasks/knowledge-capture-facts/generate.ts";

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

const SMALL: Record<string, number> = Object.fromEntries(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
    .split(" ")
    .map((w, i) => [w, i]),
);
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function wordsToNumber(text: string): number {
  let total = 0;
  let current = 0;
  for (const w of text
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)) {
    if (w in SMALL) current += SMALL[w]!;
    else if (w in TENS) current += TENS[w]!;
    else if (w === "hundred") current *= 100;
    else if (w === "thousand" || w === "million") {
      total += current * (w === "thousand" ? 1000 : 1000000);
      current = 0;
    } else throw new Error(`unknown number word ${w}`);
  }
  return total + current;
}

function moneyValue(text: string): number {
  let m: RegExpExecArray | null;
  if ((m = /^\$([\d.]+) thousand$/.exec(text))) return Math.round(Number(m[1]) * 1000);
  if ((m = /^\$([\d.]+)k$/.exec(text))) return Math.round(Number(m[1]) * 1000);
  if ((m = /^\$([\d,]+)$/.exec(text))) return Number(m[1]!.replace(/,/g, ""));
  if ((m = /^USD (\d+)$/.exec(text))) return Number(m[1]);
  if ((m = /^(.+) dollars$/.exec(text))) return wordsToNumber(m[1]!);
  throw new Error(`unreadable money phrase: ${text}`);
}

test("a money phrase states exactly the value the generator keys, in every style", () => {
  const r = rng(99);
  for (let i = 0; i < 2000; i++) {
    const n = r.chance(0.5) ? r.int(5, 900) * 100 : r.int(1000, 99999);
    const stated = statedMoney(r, n);
    assert.equal(moneyValue(stated.text), stated.value, stated.text);
    assert.ok(Math.abs(stated.value - n) <= 50, `${stated.text} strays from ${n}`);
  }
  assert.deepEqual(moneyValue("$83.5k"), 83500);
});

interface Mail {
  from: string;
  date: string;
  body: string;
}

function parseThread(text: string): Mail[] {
  const mails: Mail[] = [];
  for (const block of text.split(/^-----$/m)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.startsWith("From: "));
    if (at < 0) continue;
    const from = lines[at]!.slice(6);
    const sent = lines.find((l) => l.startsWith("Sent: "));
    assert.ok(sent, "every message carries a Sent line");
    const date = sent.slice(6);
    const bodyStart = lines.findIndex((l, i) => i > at && l === "") + 1;
    const body: string[] = [];
    for (const l of lines.slice(bodyStart)) {
      if (l.startsWith(">")) break;
      body.push(l);
    }
    mails.push({ from, date, body: body.join("\n").trim() });
  }
  return mails;
}

const domainOf = (from: string): string => /@([^>]+)>/.exec(from)?.[1] ?? "";

function statedValues(body: string, eurRate: number): { mrr?: number; head?: number } {
  const out: { mrr?: number; head?: number } = {};
  let m: RegExpExecArray | null;
  if ((m = /€([\d,]+(?:\.\d+)?) MRR/.exec(body))) out.mrr = Math.round(Number(m[1]!.replace(/,/g, "")) * eurRate);
  else if ((m = /MRR (\$[\d.]+ thousand|\$[\d.]+k|\$[\d,]+|USD \d+|[a-z -]+ dollars)/.exec(body)))
    out.mrr = moneyValue(m[1]!);
  if ((m = /Team is (\d+) now\./.exec(body))) out.head = Number(m[1]);
  else if ((m = /Headcount ([a-z -]+)\./.exec(body))) out.head = wordsToNumber(m[1]!);
  else if ((m = /We are (\d+) people\./.exec(body))) out.head = Number(m[1]);
  return out;
}

function solvePortfolio(files: Record<string, string>): Array<Record<string, string>> {
  const rows = parseCsv(files["portfolio/companies.csv"]!);
  const slugByDomain = new Map(
    parseCsv(files["portfolio/domains.csv"]!).map((r) => [r.email_domain!, r.slug!] as const),
  );
  const eurRate = Number(parseCsv(files["finance/fx.csv"]!).find((r) => r.currency === "EUR")!.usd_per_unit);
  const newest = new Map<string, { date: string; mrr?: number; head?: number }>();
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith("updates/") || path === "updates/README.md") continue;
    const mails = parseThread(text);
    const founderMails = mails.filter((m) => slugByDomain.has(domainOf(m.from)));
    if (founderMails.length === 0) continue;
    const slug = slugByDomain.get(domainOf(founderMails[0]!.from))!;
    const effective = mails[mails.length - 1]!.date;
    const stated: { mrr?: number; head?: number } = {};
    for (const m of founderMails) Object.assign(stated, statedValues(m.body, eurRate));
    const current = newest.get(slug);
    if (!current || effective > current.date) newest.set(slug, { date: effective, ...stated });
  }
  return rows.map((row) => {
    const u = newest.get(row.slug!);
    if (!u || (u.mrr === undefined && u.head === undefined)) return row;
    return {
      ...row,
      ...(u.mrr === undefined ? {} : { mrr_usd: String(u.mrr) }),
      ...(u.head === undefined ? {} : { headcount: String(u.head) }),
      last_update: u.date,
    };
  });
}

test("portfolio-update-records: a literal reader of the files reproduces the key on every seed", () => {
  for (const seed of SEEDS) {
    const f = portfolioUpdateRecords().generate(seed);
    const key = f.key as UpdateKey;
    const solved = solvePortfolio(f.files);
    assert.equal(solved.length, key.expected.length);
    for (let i = 0; i < key.expected.length; i++) {
      const e = key.expected[i]!;
      const got = solved[i]!;
      const where = `seed ${seed} ${e.slug}`;
      assert.equal(got.slug, e.slug, where);
      assert.equal(Number(got.mrr_usd), e.mrr_usd, `${where} mrr`);
      assert.equal(Number(got.headcount), e.headcount, `${where} headcount`);
      assert.equal(got.last_update, e.last_update, `${where} last_update`);
    }
  }
});

function readerEurToUsd(eur: number, rate: number): number {
  const product = Math.round(eur * 100) * Math.round(rate * 100);
  return Math.floor((product + 50) / 100) / 100;
}

interface LedgerRow {
  date: string;
  amount: number;
  vendor: string;
  source: string;
  ref: string;
}

function solveLedger(files: Record<string, string>): LedgerRow[] {
  const rate = Number(parseCsv(files["finance/fx.csv"]!)[0]!.usd_per_unit);
  const rows: LedgerRow[] = [];
  const bank = parseCsv(files["finance/bank-export.csv"]!);
  const bankRefs = new Set(bank.map((r) => r.Ref));
  for (const r of bank) {
    const [m, d, y] = r["Date (MM/DD/YYYY)"]!.split("/");
    const raw = r["Amount (accounting format)"]!;
    const amount = Number(raw.replace(/[(),]/g, "")) * (raw.startsWith("(") ? -1 : 1);
    rows.push({ date: `${y}-${m}-${d}`, amount, vendor: r.Description!, source: "bank", ref: r.Ref! });
  }
  for (const r of parseCsv(files["finance/card-export.csv"]!)) {
    if (bankRefs.has(r.ref!)) continue;
    const [d, m, y] = r["posted (DD.MM.YYYY)"]!.split(".");
    rows.push({
      date: `${y}-${m}-${d}`,
      amount: -Number(r.amount_cents) / 100,
      vendor: r.merchant!,
      source: "card",
      ref: r.ref!,
    });
  }
  for (const i of JSON.parse(files["finance/invoices.json"]!) as Array<Record<string, string | number>>) {
    const usd = i.currency === "EUR" ? readerEurToUsd(Number(i.total), rate) : Number(i.total);
    rows.push({
      date: String(i.issued),
      amount: i.direction === "payable" ? -usd : usd,
      vendor: String(i.counterparty),
      source: "invoice",
      ref: String(i.reference),
    });
  }
  const bankOut = rows.filter((r) => r.source === "bank" && r.amount < 0);
  for (const line of files["finance/paypal.csv"]!.split("\n").slice(1).filter(Boolean)) {
    const [date, merchant, amount, , ref] = line.split(";") as [string, string, string, string, string];
    const usd = readerEurToUsd(Number(amount.replace(",", ".")), rate);
    if (bankOut.some((b) => b.date === date && b.vendor === merchant && Math.abs(Math.abs(b.amount) - usd) <= 0.02))
      continue;
    rows.push({ date, amount: -usd, vendor: merchant, source: "paypal", ref });
  }
  for (const line of files["finance/payroll.txt"]!.split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(\d+)\.00\s+(TX\d+)$/.exec(line);
    if (m)
      rows.push({
        date: m[1]!,
        amount: -Number(m[3]),
        vendor: `Payroll ${m[2]!.trim()}`,
        source: "payroll",
        ref: m[4]!,
      });
  }
  return rows;
}

const ledgerKey = (r: LedgerRow): string =>
  `${r.date}|${r.amount.toFixed(2)}|${r.vendor.toLowerCase()}|${r.source}|${r.ref}`;

test("finance-consolidate-records: a literal reader of the exports reproduces every key row on every seed", () => {
  for (const seed of SEEDS) {
    const f = financeConsolidateRecords().generate(seed);
    const key = f.key as ConsolidateKey;
    const solved = solveLedger(f.files).map(ledgerKey).sort();
    const expected = key.rows.map(ledgerKey).sort();
    assert.deepEqual(solved, expected, `seed ${seed}`);
  }
});

function solveExceptions(files: Record<string, string>): {
  mealLimit: number;
  receiptFloor: number;
  travelFloor: number;
  pairs: string[];
} {
  const audit = parseCsv(files["audit/reviewed.csv"]!);
  const ok = audit.filter((r) => r.verdict === "ok");
  const mealLimit = Math.max(
    ...ok.filter((r) => r.category === "meal" && r.attendees !== "").map((r) => Number(r.amount) / Number(r.attendees)),
  );
  const receiptFloor = Math.max(...ok.filter((r) => r.receipt === "no").map((r) => Number(r.amount)));
  const travelFloor = Math.max(
    ...ok.filter((r) => r.category === "travel" && r.approved === "no").map((r) => Number(r.amount)),
  );
  const current = parseCsv(files["finance/expenses.csv"]!);
  const seen = new Map<string, number>();
  for (const e of current) {
    const k = `${e.employee}|${e.date}|${e.amount}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const pairs: string[] = [];
  for (const e of current) {
    const amount = Number(e.amount);
    const blank = e.attendees === "";
    if (e.category === "meal" && blank && amount > mealLimit) pairs.push(`${e.id}|needs-info`);
    if (e.category === "meal" && !blank && amount / Number(e.attendees) > mealLimit) pairs.push(`${e.id}|meal-limit`);
    if (amount > receiptFloor && e.receipt === "no") pairs.push(`${e.id}|missing-receipt`);
    if ((seen.get(`${e.employee}|${e.date}|${e.amount}`) ?? 0) > 1) pairs.push(`${e.id}|duplicate`);
    if (e.category === "travel" && amount > travelFloor && e.approved !== "yes") pairs.push(`${e.id}|travel-approval`);
  }
  return { mealLimit, receiptFloor, travelFloor, pairs };
}

test("finance-flag-exceptions: the audit's verdicts pin the thresholds and the rules reproduce the key on every seed", () => {
  for (const seed of SEEDS) {
    const f = financeFlagExceptions().generate(seed);
    const key = f.key as ExceptionsKey;
    const solved = solveExceptions(f.files);
    assert.equal(solved.mealLimit, key.mealLimit, `seed ${seed} meal limit`);
    assert.equal(solved.receiptFloor, key.receiptFloor, `seed ${seed} receipt floor`);
    assert.equal(solved.travelFloor, key.travelFloor, `seed ${seed} travel floor`);
    assert.deepEqual([...solved.pairs].sort(), [...key.expected].sort(), `seed ${seed} pairs`);
  }
});

test("knowledge-capture-facts: naming a corrected value as history is not the same as asserting it", async () => {
  for (const seed of SEEDS.slice(0, 5)) {
    const t = knowledgeCaptureFacts();
    const f = t.generate(seed);
    const key = f.key as FactsKey;
    const stale = key.durable.filter((d) => d.stale !== undefined);
    assert.ok(stale.length >= 2, `seed ${seed} has corrected facts`);
    const withHistory = key.durable.map((d) =>
      d.stale ? `${d.gold} (the earlier ${d.stale} notice was corrected.)` : d.gold,
    );
    const honoured = await grade(t, memoryOutputs({ "output/facts.json": JSON.stringify(withHistory) }), key);
    assert.equal(
      honoured.checks.find((c) => c.id === "corrections-and-reversals")!.score,
      1,
      `seed ${seed} history mention`,
    );
    assert.equal(honoured.reward, 1, `seed ${seed} history mention still passes`);
    const asserted = key.durable.map((d) => (d.stale ? d.gold.replace(d.token, d.stale) : d.gold));
    const kept = await grade(t, memoryOutputs({ "output/facts.json": JSON.stringify(asserted) }), key);
    assert.equal(
      kept.checks.find((c) => c.id === "corrections-and-reversals")!.score,
      0,
      `seed ${seed} stale asserted`,
    );
  }
});
