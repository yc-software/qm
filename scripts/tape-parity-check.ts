import { sleep } from "../src/util/async.ts";
import { errMessage } from "../src/util/errors.ts";
import { argValue, openSessionStore, resolveSessions } from "./lib/backfill-runner.ts";
import {
  DIVERGENCE_CLASSES,
  emptyBenignCounts,
  limitedSessionParity,
  sessionParity,
  type RealDivergence,
} from "./lib/tape-retirement.ts";

function positiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} requires a positive integer`);
    process.exit(1);
  }
  return value;
}

const only = argValue("--session");
const sample = positiveInt("--sample", argValue("--sample"));
const detailCap = positiveInt("--details", argValue("--details")) ?? 20;
const LIMITED_READ_LIMIT = 50;

const store = openSessionStore();
const all = await resolveSessions(store, only);
all.sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
const sessions =
  sample !== undefined && sample < all.length
    ? Array.from({ length: sample }, (_, i) => all[Math.floor((i * all.length) / sample)]!)
    : all;

const benign = emptyBenignCounts();
const unservable = { blocked: 0, uncovered: 0 };
let compared = 0;
let cleanSessions = 0;
let realTotal = 0;
let realSessions = 0;
let limitedProjected = 0;
let limitedFallback = 0;
let limitedRealTotal = 0;
let detailsShown = 0;
let failed = 0;

const printReal = (sessionId: string, label: string, real: readonly RealDivergence[]): void => {
  console.error(`REAL MISMATCH ${sessionId}${label}: ${real.length} row(s)`);
  for (const d of real) {
    if (detailsShown >= detailCap) break;
    detailsShown++;
    console.error(
      `  seq ${d.seq} [${d.field}] entry=${JSON.stringify(d.entry)?.slice(0, 400)} projected=${JSON.stringify(d.projected)?.slice(0, 400)}`,
    );
  }
};

const SETTLE_MS = 15_000;

type Recheck =
  { status: "clean" } | { status: "reproduced"; rows: readonly RealDivergence[] } | { status: "inconclusive" };

async function settledRecheck(sessionId: string, mode: "full" | "limited"): Promise<Recheck> {
  await sleep(SETTLE_MS);
  const entries = await store.getEntries(sessionId);
  const rows = await store.getTape(sessionId);
  const real = (() => {
    if (mode === "full") {
      const again = sessionParity(sessionId, entries, rows);
      return again.status === "compared" ? again.report.real : null;
    }
    return limitedSessionParity(store, sessionId, entries, rows, LIMITED_READ_LIMIT).then((again) =>
      again.status === "projected" ? again.report.real : null,
    );
  })();
  const rows2 = await real;
  if (rows2 === null) return { status: "inconclusive" };
  return rows2.length ? { status: "reproduced", rows: rows2 } : { status: "clean" };
}

for (const session of sessions) {
  try {
    const entries = await store.getEntries(session.id);
    const rows = await store.getTape(session.id);
    const parity = sessionParity(session.id, entries, rows);
    if (parity.status === "unservable") {
      unservable[parity.reason]++;
      continue;
    }
    compared++;
    const { report } = parity;
    for (const cls of DIVERGENCE_CLASSES) benign[cls] += report.benign[cls];
    const benignHere = DIVERGENCE_CLASSES.reduce((n, cls) => n + report.benign[cls], 0);
    if (!report.real.length && !benignHere) cleanSessions++;
    if (report.real.length) {
      const recheck = await settledRecheck(session.id, "full");
      if (recheck.status === "reproduced") {
        realSessions++;
        realTotal += recheck.rows.length;
        printReal(session.id, "", recheck.rows);
      } else if (recheck.status === "inconclusive") {
        realSessions++;
        realTotal += report.real.length;
        console.log(
          `RECHECK INCONCLUSIVE ${session.id}: session unservable/busy at recheck — original mismatch stands`,
        );
        printReal(session.id, "", report.real);
      }
    }
    const limited = await limitedSessionParity(store, session.id, entries, rows, LIMITED_READ_LIMIT);
    if (limited.status === "fallback") {
      limitedFallback++;
    } else {
      limitedProjected++;
      if (limited.report.real.length) {
        const recheck = await settledRecheck(session.id, "limited");
        if (recheck.status === "reproduced") {
          limitedRealTotal += recheck.rows.length;
          printReal(session.id, " [limited read]", recheck.rows);
        } else if (recheck.status === "inconclusive") {
          limitedRealTotal += limited.report.real.length;
          console.log(`RECHECK INCONCLUSIVE ${session.id} [limited read]: original mismatch stands`);
          printReal(session.id, " [limited read]", limited.report.real);
        }
      }
    }
  } catch (err) {
    failed++;
    console.error(`failed ${session.id}: ${errMessage(err)}`);
  }
}

const vacuous = compared === 0 && sessions.length > 0;
if (vacuous) console.error("GATE VACUOUS: zero sessions compared — every session was unservable or failed to read");
console.log(
  [
    `sessions ${sessions.length}: compared ${compared} (exact ${cleanSessions}), ` +
      `unservable-blocked ${unservable.blocked}, unservable-uncovered ${unservable.uncovered}, failed ${failed}`,
    `limited reads: projected ${limitedProjected}, fallback ${limitedFallback}`,
    `benign divergences: ${DIVERGENCE_CLASSES.map((cls) => `${cls} ${benign[cls]}`).join(", ")}`,
    `real mismatches: ${realTotal} across ${realSessions} session(s), plus ${limitedRealTotal} on limited reads`,
  ].join("\n"),
);
process.exit(realTotal || limitedRealTotal || failed || vacuous ? 1 : 0);
