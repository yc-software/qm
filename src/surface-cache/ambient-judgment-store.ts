import { orgId as configOrgId } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";

type AmbientDecisionKind = "act" | "ignore" | "fastlane";

type AmbientJudgment = {
  id?: number;
  orgId?: string;
  surface: string;
  container: string;
  decision: AmbientDecisionKind;
  reason?: string;
  askedBy?: string;
  prompt?: string;
  model?: string;
  latencyMs?: number;
  tsFrom?: string;
  tsTo?: string;
  createdAt: number;
};

type AmbientJudgmentCounts = Record<AmbientDecisionKind, number>;

type AmbientJudgmentSummary = Omit<AmbientJudgment, "prompt">;

export interface AmbientJudgmentStore {
  record(j: AmbientJudgment): Promise<void>;
  list(opts?: {
    container?: string;
    decision?: AmbientDecisionKind[];
    before?: number;
    beforeId?: number;
    limit?: number;
  }): Promise<AmbientJudgmentSummary[]>;
  get(id: number): Promise<AmbientJudgment | null>;
  counts(opts?: { container?: string }): Promise<AmbientJudgmentCounts>;
  close(): Promise<void>;
}

const emptyCounts = (): AmbientJudgmentCounts => ({ act: 0, ignore: 0, fastlane: 0 });

export function createPostgresAmbientJudgmentStore(connectionString: string): AmbientJudgmentStore {
  const orgId = configOrgId();
  const { q, close } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS ambient_judgments(
        id BIGSERIAL PRIMARY KEY,
        org_id TEXT NOT NULL, surface TEXT NOT NULL, container TEXT NOT NULL,
        decision TEXT NOT NULL, reason TEXT, asked_by TEXT, prompt TEXT, model TEXT,
        latency_ms INT, ts_from TEXT, ts_to TEXT, created_at BIGINT NOT NULL
      )`,
    `ALTER TABLE ambient_judgments ADD COLUMN IF NOT EXISTS asked_by TEXT`,
    `CREATE INDEX IF NOT EXISTS ambient_judgments_org_container_created
        ON ambient_judgments(org_id, container, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ambient_judgments_org_created
        ON ambient_judgments(org_id, created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS ambient_judgments_org_decision
        ON ambient_judgments(org_id, decision)`,
  ]);
  const row = (r: Record<string, unknown>): AmbientJudgment => ({
    id: Number(r.id),
    orgId: r.org_id as string,
    surface: r.surface as string,
    container: r.container as string,
    decision: r.decision as AmbientDecisionKind,
    ...(r.reason != null ? { reason: r.reason as string } : {}),
    ...(r.asked_by != null ? { askedBy: r.asked_by as string } : {}),
    ...(r.prompt != null ? { prompt: r.prompt as string } : {}),
    ...(r.model != null ? { model: r.model as string } : {}),
    ...(r.latency_ms != null ? { latencyMs: Number(r.latency_ms) } : {}),
    ...(r.ts_from != null ? { tsFrom: r.ts_from as string } : {}),
    ...(r.ts_to != null ? { tsTo: r.ts_to as string } : {}),
    createdAt: Number(r.created_at),
  });
  return {
    async record(j) {
      await q(
        `INSERT INTO ambient_judgments(org_id, surface, container, decision, reason, asked_by, prompt, model, latency_ms, ts_from, ts_to, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          configOrgId(),
          j.surface,
          j.container,
          j.decision,
          j.reason ?? null,
          j.askedBy ?? null,
          j.prompt ?? null,
          j.model ?? null,
          j.latencyMs ?? null,
          j.tsFrom ?? null,
          j.tsTo ?? null,
          j.createdAt,
        ],
      );
    },
    async list(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
      const where = ["org_id = $1"];
      const args: unknown[] = [orgId];
      if (opts?.container) {
        args.push(opts.container);
        where.push(`container = $${args.length}`);
      }
      if (opts?.decision?.length) {
        const ph = opts.decision.map((d) => {
          args.push(d);
          return `$${args.length}`;
        });
        where.push(`decision IN (${ph.join(",")})`);
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
        `SELECT id, org_id, surface, container, decision, reason, asked_by, model, latency_ms, ts_from, ts_to, created_at
         FROM ambient_judgments WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`,
        args,
      );
      return rows.map(row);
    },
    async get(id) {
      const rows = await q("SELECT * FROM ambient_judgments WHERE org_id = $1 AND id = $2", [orgId, id]);
      return rows[0] ? row(rows[0]) : null;
    },
    async counts(opts) {
      const args: unknown[] = [orgId];
      let where = "org_id = $1";
      if (opts?.container) {
        args.push(opts.container);
        where += ` AND container = $${args.length}`;
      }
      const rows = await q(
        `SELECT decision, COUNT(*)::int AS n FROM ambient_judgments WHERE ${where} GROUP BY decision`,
        args,
      );
      const out = emptyCounts();
      for (const r of rows) if ((r.decision as string) in out) out[r.decision as AmbientDecisionKind] = Number(r.n);
      return out;
    },
    close,
  };
}

export function createMemoryAmbientJudgmentStore(): AmbientJudgmentStore {
  const judgments: AmbientJudgment[] = [];
  let seq = 0;
  const filtered = (opts?: { container?: string }) =>
    judgments.filter((j) => !opts?.container || j.container === opts.container);
  return {
    async record(j) {
      const a = judgments;
      a.push({ ...j, id: ++seq });
      if (a.length > 5000) a.splice(0, a.length - 5000);
    },
    async list(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
      const all = filtered(opts)
        .filter(
          (j) =>
            (!opts?.decision?.length || opts.decision.includes(j.decision)) &&
            (opts?.before == null ||
              (opts.beforeId != null
                ? j.createdAt < opts.before || (j.createdAt === opts.before && (j.id ?? 0) < opts.beforeId)
                : j.createdAt < opts.before)),
        )
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt || (b.id ?? 0) - (a.id ?? 0));
      return all.slice(0, limit).map(({ prompt: _p, ...rest }) => rest);
    },
    async get(id) {
      return judgments.find((j) => j.id === id) ?? null;
    },
    async counts(opts) {
      const out = emptyCounts();
      for (const j of filtered(opts)) if (j.decision in out) out[j.decision] += 1;
      return out;
    },
    async close() {},
  };
}
