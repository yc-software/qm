import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { Client } = require("pg") as typeof import("pg");

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const DAYS = Number(arg("days", "21"));
const MIN_HUMANS = Number(arg("min-humans", "2"));
const PER_CLUSTER = Number(arg("limit", "4"));
const OUT = arg("out", "");

interface ItemRow {
  kind: string;
  variant: string | null;
  text: string | null;
  author: string | null;
  name: string | null;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (run inside the core box)");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const since = Date.now() - DAYS * 86_400_000;
    const { rows: sessions } = await client.query<{
      id: string;
      thread_ref: string;
      channel_name: string | null;
      created_at: number;
    }>(
      `SELECT id, thread_ref, channel_name, created_at FROM sessions
       WHERE thread_ref LIKE 'ch:%' AND created_at >= $1 ORDER BY created_at DESC`,
      [since],
    );

    interface Mined {
      id: string;
      channel: string;
      humans: string[];
      turns: number;
      botReplied: boolean;
      transcript: Array<{ author: string; text: string }>;
    }
    const mined: Mined[] = [];
    for (const s of sessions) {
      const { rows } = await client.query<ItemRow>(
        `SELECT kind, variant, text, author, body ->> 'name' AS name FROM items WHERE session_id = $1 ORDER BY seq`,
        [s.id],
      );
      const transcript: Array<{ author: string; text: string }> = [];
      const humans = new Set<string>();
      let botReplied = false;
      for (const r of rows) {
        if (r.kind === "UserMessage" || r.kind === "SteeringMessage") {
          const author = r.name ?? r.author ?? "unknown";
          humans.add(author);
          transcript.push({ author, text: r.text ?? "" });
        } else if (r.kind === "AgentMessage" && r.variant === null) {
          botReplied = true;
          transcript.push({ author: "agent", text: r.text ?? "" });
        }
      }
      if (humans.size >= MIN_HUMANS) {
        mined.push({
          id: s.id,
          channel: s.channel_name ?? s.thread_ref,
          humans: [...humans],
          turns: transcript.length,
          botReplied,
          transcript,
        });
      }
    }

    const clusters = new Map<string, Mined[]>();
    for (const m of mined) {
      const key = `${m.humans.length} humans · bot ${m.botReplied ? "replied" : "stayed silent"}`;
      (clusters.get(key) ?? clusters.set(key, []).get(key)!).push(m);
    }

    const lines: string[] = [
      `# Multi-user channel sessions — last ${DAYS}d (${mined.length} of ${sessions.length} channel sessions have ≥${MIN_HUMANS} humans)`,
      "",
      "Hand-author live-e2e scenarios from these. Bias to the 8 ergonomic modes: addressing,",
      "attribution/splice, threading, bystander restraint, interruption, correction/override,",
      "authority, audience-of-output.",
      "",
    ];
    for (const [key, group] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`## ${key} — ${group.length} session${group.length === 1 ? "" : "s"}`, "");
      for (const m of group.slice(0, PER_CLUSTER)) {
        lines.push(`### ${m.channel} (${m.id}) — ${m.humans.join(", ")}`);
        for (const t of m.transcript.slice(0, 12)) {
          lines.push(`- **${t.author}:** ${t.text.replace(/\s+/g, " ").slice(0, 240)}`);
        }
        if (m.transcript.length > 12) lines.push(`- … (${m.transcript.length - 12} more)`);
        lines.push("");
      }
    }
    const out = lines.join("\n");
    if (OUT) {
      writeFileSync(OUT, out);
      console.log(`wrote ${OUT} (${mined.length} multi-user sessions across ${clusters.size} clusters)`);
    } else {
      console.log(out);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
