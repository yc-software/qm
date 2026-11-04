import type { MonitorStore } from "../../monitors/monitor-store.ts";
import type { ProcessRegistry } from "../../processes/process-registry.ts";
import { swallowAs } from "../../util/errors.ts";

const NEXT_STEP_OPENINGS = [
  "i'll now",
  "i will now",
  "now i'll",
  "now i will",
  "next i'll",
  "next, i'll",
  "next i will",
  "next, i will",
  "let me",
  "now let me",
];
const SENTENCE_BREAKS = [". ", "! ", "? ", "\n"];

const NEXT_STEP_ENDING =
  "Your message above announces a next step but makes no tool call, and no one is waiting to prompt you.";
const unwatchedJobsEnding = (processIds: string[]): string =>
  `Background jobs you started this turn may still be running, and with no watch nothing will wake you when they finish: ${processIds.join(", ")}.`;
const ENDING_CHECK_CLOSE =
  "If work remains, do it now; otherwise end with a final answer that stands on its own, since only your last message is delivered.";

function lastSentence(text: string): string {
  const start = Math.max(
    0,
    ...SENTENCE_BREAKS.map((mark) => {
      const at = text.lastIndexOf(mark);
      return at < 0 ? 0 : at + mark.length;
    }),
  );
  let letter = start;
  while (letter < text.length && !(text.charAt(letter) >= "a" && text.charAt(letter) <= "z")) letter++;
  return text.slice(letter);
}

export function announcesNextStep(reply: string): boolean {
  const text = reply.trim().toLowerCase().replaceAll("\u2019", "'");
  if (text.endsWith(":")) return true;
  const sentence = lastSentence(text);
  return !sentence.startsWith("let me know") && NEXT_STEP_OPENINGS.some((opening) => sentence.startsWith(opening));
}

interface TurnStores {
  processes?: Pick<ProcessRegistry, "liveByScope">;
  monitors?: Pick<MonitorStore, "ownedBy">;
}

interface TurnPlace {
  processScopeId: string;
  monitorScopeId: string;
  threadRef: string;
  turnStartedAt: number;
}

async function unwatchedJobs(stores: TurnStores, place: TurnPlace): Promise<string[]> {
  if (!stores.processes) return [];
  const now = Date.now();
  const [live, watches] = await Promise.all([
    stores.processes.liveByScope(place.processScopeId, now),
    stores.monitors?.ownedBy(place.monitorScopeId) ?? [],
  ]);
  const watched = new Set(watches.filter((m) => m.enabled && m.expiresAt > now).map((m) => m.processId));
  return live
    .filter(
      (job) =>
        job.kind === "background" &&
        job.sessionRef === place.threadRef &&
        job.startedAt >= place.turnStartedAt &&
        !watched.has(job.processId),
    )
    .map((job) => job.processId);
}

export function turnEndCheck(stores: TurnStores, place: TurnPlace): (reply: string) => Promise<string | undefined> {
  return async (reply) => {
    const jobs = await unwatchedJobs(stores, place).catch(swallowAs("turn end check: background jobs", []));
    const reasons = [
      ...(announcesNextStep(reply) ? [NEXT_STEP_ENDING] : []),
      ...(jobs.length ? [unwatchedJobsEnding(jobs)] : []),
    ];
    return reasons.length ? `[system] ${reasons.join(" ")} ${ENDING_CHECK_CLOSE}` : undefined;
  };
}
