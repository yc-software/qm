import { AUDIT_COLUMNS } from "../admin/postgres-audit-log.ts";
import { HOLD_LOOPS_MADE_BY_ALIASES } from "../loops/loop-store.ts";
import { revokeGrantsByAliases } from "../loops/ship-grant-store.ts";
import { bumpMapVersions } from "../persistence/durable-map.ts";
import { msOf } from "../sessions/items.ts";
import { BOT_MARKED_TRIGGERS, MARK_TRIGGERS_MADE_BY_ALIASES } from "../triggers/trigger-store.ts";

const SYSTEM = "'system'";

const MARKED = [...BOT_MARKED_TRIGGERS.map(([table]) => `${table}_marked`), "loops_marked", "grants_revoked"];

export const markBotWork = (aliases: string): string => `WITH ${aliases},
${MARK_TRIGGERS_MADE_BY_ALIASES},
${HOLD_LOOPS_MADE_BY_ALIASES},
${revokeGrantsByAliases(SYSTEM)},
marked AS (${MARKED.map((cte) => `SELECT * FROM ${cte}`).join(" UNION ALL ")}),
versions AS (${bumpMapVersions("SELECT DISTINCT tbl, 1 FROM marked")}),
audited AS (
  INSERT INTO audit_log (${AUDIT_COLUMNS})
  SELECT ${msOf("now()")}, ${SYSTEM}, action, id, scope, NULL, detail::text FROM marked
)`;
