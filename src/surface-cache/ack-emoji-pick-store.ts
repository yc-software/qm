import { orgId as configOrgId } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";

type AckPickOutcome = "picked" | "declined";

type AckEmojiPick = {
  id?: number;
  orgId?: string;
  surface: string;
  channel: string;
  ts: string;
  outcome: AckPickOutcome;
  picked?: string;
  icon?: string;
  message?: string;
  candidates?: string;
  model?: string;
  latencyMs?: number;
  createdAt: number;
};

type AckPickCounts = Record<AckPickOutcome, number>;

type AckEmojiPickSummary = Omit<AckEmojiPick, "candidates">;

export interface AckEmojiPickStore {
  record(p: AckEmojiPick): Promise<void>;
  list(opts?: {
    channel?: string;
    outcome?: AckPickOutcome[];
    before?: number;
    beforeId?: number;
    limit?: number;
  }): Promise<AckEmojiPickSummary[]>;
  get(id: number): Promise<AckEmojiPick | null>;
  counts(opts?: { channel?: string }): Promise<AckPickCounts>;
  close(): Promise<void>;
}

const emptyCounts = (): AckPickCounts => ({ picked: 0, declined: 0 });

export function createPostgresAckEmojiPickStore(connectionString: string): AckEmojiPickStore {
  const orgId = configOrgId();
  const { q, close } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS ack_emoji_picks(
        id BIGSERIAL PRIMARY KEY,
        org_id TEXT NOT NULL, surface TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL,
        outcome TEXT NOT NULL, picked TEXT, icon TEXT, message TEXT, candidates TEXT, model TEXT,
        latency_ms INT, created_at BIGINT NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS ack_emoji_picks_org_channel_created
        ON ack_emoji_picks(org_id, channel, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ack_emoji_picks_org_created
        ON ack_emoji_picks(org_id, created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS ack_emoji_picks_org_outcome
        ON ack_emoji_picks(org_id, outcome)`,
  ]);
  const row = (r: Record<string, unknown>): AckEmojiPick => ({
    id: Number(r.id),
    orgId: r.org_id as string,
    surface: r.surface as string,
    channel: r.channel as string,
    ts: r.ts as string,
    outcome: r.outcome as AckPickOutcome,
    ...(r.picked != null ? { picked: r.picked as string } : {}),
    ...(r.icon != null ? { icon: r.icon as string } : {}),
    ...(r.message != null ? { message: r.message as string } : {}),
    ...(r.candidates != null ? { candidates: r.candidates as string } : {}),
    ...(r.model != null ? { model: r.model as string } : {}),
    ...(r.latency_ms != null ? { latencyMs: Number(r.latency_ms) } : {}),
    createdAt: Number(r.created_at),
  });
  return {
    async record(p) {
      await q(
        `INSERT INTO ack_emoji_picks(org_id, surface, channel, ts, outcome, picked, icon, message, candidates, model, latency_ms, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          configOrgId(),
          p.surface,
          p.channel,
          p.ts,
          p.outcome,
          p.picked ?? null,
          p.icon ?? null,
          p.message ?? null,
          p.candidates ?? null,
          p.model ?? null,
          p.latencyMs ?? null,
          p.createdAt,
        ],
      );
    },
    async list(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
      const where = ["org_id = $1"];
      const args: unknown[] = [orgId];
      if (opts?.channel) {
        args.push(opts.channel);
        where.push(`channel = $${args.length}`);
      }
      if (opts?.outcome?.length) {
        const ph = opts.outcome.map((d) => {
          args.push(d);
          return `$${args.length}`;
        });
        where.push(`outcome IN (${ph.join(",")})`);
      }
      if (opts?.before != null) {
        args.push(opts.before);
        const c = `$${args.length}`;
        if (opts.beforeId != null) {
          args.push(opts.beforeId);
          where.push(`(created_at < ${c} OR (created_at = ${c} AND id < $${args.length}))`);
        } else {
          where.push(`created_at < ${c}`);
        }
      }
      args.push(limit);
      const rows = await q(
        `SELECT id, org_id, surface, channel, ts, outcome, picked, icon, message, model, latency_ms, created_at
         FROM ack_emoji_picks WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`,
        args,
      );
      return rows.map(row);
    },
    async get(id) {
      const rows = await q("SELECT * FROM ack_emoji_picks WHERE org_id = $1 AND id = $2", [orgId, id]);
      return rows[0] ? row(rows[0]) : null;
    },
    async counts(opts) {
      const args: unknown[] = [orgId];
      let where = "org_id = $1";
      if (opts?.channel) {
        args.push(opts.channel);
        where += ` AND channel = $${args.length}`;
      }
      const rows = await q(
        `SELECT outcome, COUNT(*)::int AS n FROM ack_emoji_picks WHERE ${where} GROUP BY outcome`,
        args,
      );
      const out = emptyCounts();
      for (const r of rows) if ((r.outcome as string) in out) out[r.outcome as AckPickOutcome] = Number(r.n);
      return out;
    },
    close,
  };
}

export function createMemoryAckEmojiPickStore(): AckEmojiPickStore {
  const picks: AckEmojiPick[] = [];
  let seq = 0;
  const filtered = (opts?: { channel?: string }) => picks.filter((p) => !opts?.channel || p.channel === opts.channel);
  return {
    async record(p) {
      const a = picks;
      a.push({ ...p, id: ++seq });
      if (a.length > 5000) a.splice(0, a.length - 5000);
    },
    async list(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
      const all = filtered(opts)
        .filter(
          (p) =>
            (!opts?.outcome?.length || opts.outcome.includes(p.outcome)) &&
            (opts?.before == null ||
              (opts.beforeId != null
                ? p.createdAt < opts.before || (p.createdAt === opts.before && (p.id ?? 0) < opts.beforeId)
                : p.createdAt < opts.before)),
        )
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt || (b.id ?? 0) - (a.id ?? 0));
      return all.slice(0, limit).map(({ candidates: _c, ...rest }) => rest);
    },
    async get(id) {
      return picks.find((p) => p.id === id) ?? null;
    },
    async counts(opts) {
      const out = emptyCounts();
      for (const p of filtered(opts)) if (p.outcome in out) out[p.outcome] += 1;
      return out;
    },
    async close() {},
  };
}
