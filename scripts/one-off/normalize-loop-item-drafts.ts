import { parseArgs } from "node:util";
import pg from "pg";
import type { LoopItem } from "../../src/types.ts";
import { wireMentionKeys } from "../../src/slack/mrkdwn.ts";
import { canonicalJson } from "../../src/util/objects.ts";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("LOCK TABLE loop_items IN SHARE ROW EXCLUSIVE MODE");
  const { rows } = await client.query<{ id: string; json: LoopItem }>("SELECT id, json FROM loop_items");
  const updates: Array<{ id: string; json: LoopItem }> = [];
  for (const { id, json: item } of rows) {
    const next = { ...item };
    if (!Array.isArray(next.agentDrafts)) {
      next.agentDrafts = item.proposal?.by === "agent" ? [item.proposal] : [];
      if (item.proposal?.by === "human")
        next.agentMentionKeys = [
          ...new Set([...(item.agentMentionKeys ?? []), ...wireMentionKeys(canonicalJson(item.proposal.data))]),
        ];
    }
    if (canonicalJson(next) !== canonicalJson(item)) updates.push({ id, json: next });
  }
  for (const { id, json } of updates)
    await client.query("UPDATE loop_items SET json = $2::jsonb WHERE id = $1", [id, JSON.stringify(json)]);
  await client.query(values.apply ? "COMMIT" : "ROLLBACK");
  console.log(JSON.stringify({ applied: values.apply, changed: updates.length }));
} finally {
  await client.end();
}
