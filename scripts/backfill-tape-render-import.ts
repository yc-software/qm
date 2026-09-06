import { openSessionStore, parseBackfillArgs, resolveSessions, runBackfill } from "./lib/backfill-runner.ts";
import {
  appendRenderImport,
  assertProjectionUnderstandsRenderImports,
  assessRenderImport,
} from "./lib/tape-retirement.ts";

const { apply, only, force } = parseBackfillArgs(
  "a forced re-import supersedes a session's existing anchor and doubles its mirror rows; target it, and re-run to completion after any interrupted --force (duplicate mirrors are visible to the full projection until a re-run's anchor supersedes them; parity flags it)",
);

assertProjectionUnderstandsRenderImports();
if (apply) {
  console.log(
    "render imports are served only by instances that understand render_import anchors — deploy the serving change before running --apply against a live fleet",
  );
}

const store = openSessionStore();
const sessions = await resolveSessions(store, only);

const detail = (plan: { latestSeq: number; needsFoldImport: boolean }): string =>
  `through seq ${plan.latestSeq}${plan.needsFoldImport ? ", with fold import" : ""}`;

await runBackfill({
  verb: { dry: "would import", done: "imported" },
  store,
  sessions,
  apply,
  preview: async (session) => {
    const plan = await assessRenderImport(store, session.id, { force });
    if (plan.action === "skip")
      return { action: "skip", reason: plan.reason, quiet: plan.reason === "covered" || plan.reason === "empty" };
    return { action: "work", detail: detail(plan) };
  },
  applyStep: async (session, lease) => {
    const plan = await assessRenderImport(store, session.id, { force });
    if (plan.action === "skip")
      return { action: "skip", reason: plan.reason, quiet: plan.reason === "covered" || plan.reason === "empty" };
    const outcome = await appendRenderImport(store, lease, plan.entries, session.scopeId, plan.needsFoldImport);
    if (outcome !== "imported") return { action: "skip", reason: outcome };
    return { action: "work", detail: `${plan.entries.length} mirrors, ${detail(plan)}` };
  },
});
