import type { Destination } from "../types.ts";
import type {
  Loop,
  LoopCaps,
  LoopGovernorConfig,
  LoopHealth,
  LoopState,
  LoopTriageConfig,
  ShipActionPolicy,
} from "./types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  contentPart,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import { msOf } from "../sessions/items.ts";
import type { ClaimedRow } from "../tenants/claim.ts";

export interface CreateLoopInput extends CreateTriggerInput {
  name: string;
  icon?: string | null;
  surface?: string;
  sources?: string[];
  playbook: string;
  successCondition: string;
  purpose?: string;
  successChecks?: string[];
  shipActions?: ShipActionPolicy[];
  caps?: LoopCaps;
  governor?: LoopGovernorConfig;
  cronId?: string;
  schedule?: unknown;
}

export interface LoopPatch {
  name?: string;
  icon?: string | null;
  purpose?: string;
  successCondition?: string;
  successChecks?: string[];
  destination?: Destination | null;
  shipActions?: ShipActionPolicy[];
  caps?: LoopCaps;
  governor?: LoopGovernorConfig;
  triage?: LoopTriageConfig;
  cronId?: string;
  state?: LoopState;
  playbookEdit?: PlaybookEdit;
  taskAuthor?: "automation" | null;
  restore?: Loop;
  quarantineClearedBy?: string;
  quarantineClearedAt?: number;
}

interface PlaybookEdit {
  playbook: string;
  by: string;
  note?: string;
}

export interface LoopStore {
  create(input: CreateLoopInput): Promise<{ loop: Loop; created: boolean }>;
  get(id: string): Promise<Loop | null>;
  list(): Promise<Loop[]>;
  claimTenants(): Promise<ClaimedRow[]>;
  byCron(cronId: string): Promise<Loop | null>;
  update(id: string, patch: LoopPatch): Promise<Loop | null>;
  editPlaybook(id: string, edit: PlaybookEdit): Promise<Loop | null>;
  setState(id: string, state: LoopState): Promise<Loop | null>;
  setHealth(id: string, health: LoopHealth, reason?: string, throttle?: boolean): Promise<Loop | null>;
  recordFireOutcome(id: string, outcome: FireOutcome): Promise<Loop | null>;
  recordScan(id: string, startedAt: number): Promise<Loop | null>;
  delete(id: string): Promise<void>;
}

export type FireOutcome = "ok" | "failed" | "transient";

function nextFailedFires(previous: number, outcome: FireOutcome): number {
  if (outcome === "ok") return 0;
  return outcome === "failed" ? previous + 1 : previous;
}

const RUNNABLE_STATES: ReadonlySet<LoopState> = new Set<LoopState>(["enabled"]);

export function isRunnable(loop: Loop): boolean {
  return RUNNABLE_STATES.has(loop.state);
}

export const LOOP_ICON_ERROR =
  "icon must be a lowercase icon name, a PNG data URL up to 64 KiB and 128×128 pixels, or null for the default";

export function validLoopIcon(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  if (value.length <= 48 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) return true;
  if (value.length > 65_536 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const encoded = value.slice("data:image/png;base64,".length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length < 33) return false;
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 128 && height <= 128;
}

function normalizeIcon(value: string | null): string | undefined {
  if (!validLoopIcon(value)) throw new Error(LOOP_ICON_ERROR);
  return value ?? undefined;
}

function normalizeName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("a loop needs a name");
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}...` : trimmed;
}

function normalizeShipActions(actions: ShipActionPolicy[] | undefined): ShipActionPolicy[] {
  const byAction = new Map<string, ShipActionPolicy>();
  for (const policy of actions ?? []) {
    const action = policy.action.trim();
    if (action) byAction.set(action, { action, gate: policy.gate });
  }
  return [...byAction.values()];
}

function stateFields(state: LoopState): Pick<Loop, "state" | "enabled"> {
  return { state, enabled: state === "enabled" };
}

function mergeTriage(current: LoopTriageConfig | undefined, patch: LoopTriageConfig): LoopTriageConfig {
  const next: LoopTriageConfig = { ...current };
  for (const key of ["prioritize", "consolidate"] as const) {
    const change = patch[key];
    if (!change) continue;
    const { instructions, ...setting } = { ...current?.[key], ...change };
    next[key] = { ...setting, ...(instructions ? { instructions } : {}) };
  }
  return next;
}

export function createLoopStore(backing: DurableMap<Loop>): LoopStore {
  const atomicUpdate = backing.update.bind(backing);
  const merge = (id: string, fields: Partial<Loop>) => atomicUpdate(id, (loop) => ({ ...loop, ...fields }));

  return {
    async create(input) {
      assertNoEscalation(input);
      const now = Date.now();
      const name = normalizeName(input.name);
      const contentId = hashId([
        contentPart(input.owner),
        contentPart(input.ownerScopeId),
        contentPart(name),
        contentPart(input.surface),
        contentPart(input.sources),
        contentPart(input.playbook),
        contentPart(input.successCondition),
        contentPart(input.purpose),
        contentPart(input.successChecks),
        contentPart(input.shipActions),
        contentPart(input.caps),
        contentPart(input.governor),
        contentPart(input.destination),
        contentPart(input.ownerConsentedAt),
        contentPart(input.cronId),
        contentPart(input.schedule),
      ]);
      const candidate: Loop = {
        ...buildTriggerBase(input, contentId, now),
        ...stateFields("enabled"),
        name,
        ...(input.icon !== undefined ? { icon: normalizeIcon(input.icon) } : {}),
        playbook: input.playbook,
        playbookVersion: 1,
        playbookHistory: [{ version: 1, at: now, by: input.createdBy }],
        policyVersion: 1,
        successCondition: input.successCondition,
        health: "healthy" as LoopHealth,
        shipActions: normalizeShipActions(input.shipActions),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.surface !== undefined ? { surface: input.surface } : {}),
        ...(input.sources !== undefined ? { sources: input.sources } : {}),
        ...(input.successChecks ? { successChecks: input.successChecks } : {}),
        ...(input.caps ? { caps: input.caps } : {}),
        ...(input.governor ? { governor: input.governor } : {}),
        ...(input.cronId ? { cronId: input.cronId } : {}),
      };
      const created = await backing.insertIfAbsent(contentId, candidate);
      return { loop: created ? candidate : ((await backing.get(contentId)) ?? candidate), created };
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    claimTenants: () => backing.claimTenants(),
    async byCron(cronId) {
      return (await backing.all()).find((loop) => loop.cronId === cronId) ?? null;
    },
    async update(id, patch) {
      return atomicUpdate(id, (loop) => {
        if (patch.restore !== undefined) return patch.restore;
        const fields: Partial<Loop> = {};
        let policyChanged = false;
        if (patch.icon !== undefined) fields.icon = normalizeIcon(patch.icon);
        if (patch.name !== undefined) fields.name = normalizeName(patch.name);
        if (patch.purpose !== undefined) fields.purpose = patch.purpose;
        if (patch.successCondition !== undefined) fields.successCondition = patch.successCondition;
        if (patch.successChecks !== undefined) fields.successChecks = patch.successChecks;
        if (patch.destination !== undefined) fields.destination = patch.destination ?? undefined;
        if (patch.shipActions !== undefined) {
          const shipActions = normalizeShipActions(patch.shipActions);
          fields.shipActions = shipActions;
          policyChanged = canonicalJson(shipActions) !== canonicalJson(loop.shipActions);
        }
        if (patch.caps !== undefined) fields.caps = patch.caps;
        if (patch.governor !== undefined) fields.governor = patch.governor;
        if (patch.triage !== undefined) fields.triage = mergeTriage(loop.triage, patch.triage);
        if (patch.cronId !== undefined) fields.cronId = patch.cronId;
        if (patch.taskAuthor !== undefined) fields.taskAuthor = patch.taskAuthor ?? undefined;
        if (patch.state !== undefined) Object.assign(fields, stateFields(patch.state));
        if (patch.quarantineClearedBy !== undefined) fields.quarantineClearedBy = patch.quarantineClearedBy;
        if (patch.quarantineClearedAt !== undefined) fields.quarantineClearedAt = patch.quarantineClearedAt;
        if (patch.playbookEdit !== undefined && patch.playbookEdit.playbook !== loop.playbook) {
          const version = loop.playbookVersion + 1;
          fields.playbook = patch.playbookEdit.playbook;
          fields.playbookVersion = version;
          fields.playbookHistory = [
            ...loop.playbookHistory,
            {
              version,
              at: Date.now(),
              by: patch.playbookEdit.by,
              ...(patch.playbookEdit.note !== undefined ? { note: patch.playbookEdit.note } : {}),
            },
          ];
          policyChanged = true;
        }
        if (policyChanged) fields.policyVersion = (loop.policyVersion ?? 1) + 1;
        return { ...loop, ...fields };
      });
    },
    async editPlaybook(id, edit) {
      return this.update(id, { playbookEdit: edit });
    },
    setState: (id, state) => merge(id, stateFields(state)),
    async setHealth(id, health, reason, throttle) {
      return merge(id, {
        health,
        ...(reason !== undefined ? { healthReason: reason } : { healthReason: undefined }),
        ...(throttle ? { throttle: true } : { throttle: undefined }),
      });
    },
    async recordFireOutcome(id, outcome) {
      return atomicUpdate(id, (loop) => ({
        ...loop,
        consecutiveFailedFires: nextFailedFires(loop.consecutiveFailedFires ?? 0, outcome),
        lastFiredAt: Date.now(),
      }));
    },
    recordScan: (id, startedAt) => merge(id, { lastScanAt: startedAt }),
    delete: (id) => backing.delete(id),
  };
}

export const MARK_BOT_WRITTEN_LOOPS_MIGRATION = {
  id: "triggers/0002-mark-bot-written-loops",
  statements: [
    `DO $$
    BEGIN
      IF to_regclass('items') IS NULL OR to_regclass('runs') IS NULL OR to_regclass('loops') IS NULL
         OR to_regclass('crons') IS NULL OR to_regclass('loop_ship_grants') IS NULL OR to_regclass('audit_log') IS NULL THEN
        RETURN;
      END IF;
      WITH bot_calls AS MATERIALIZED (
        SELECT c.tenant_id, ${msOf("c.created_at")} AS started, ${msOf("res.created_at")} AS ended,
               jsonb_build_object('runId', r.id, 'threadRef', r.session_id) AS source,
               concat_ws(' ', c.body, c.text, res.body, res.text) AS evidence
          FROM items c
          JOIN items res ON res.tenant_id = c.tenant_id AND res.session_id = c.session_id AND res.kind = 'ToolResult'
                        AND md5(res.call_id) = md5(c.call_id) AND res.call_id = c.call_id
          JOIN runs r ON r.tenant_id = c.tenant_id AND r.id = c.turn_id::text
         WHERE c.kind = 'ToolCall'
           AND CASE WHEN pg_input_is_valid(r.request, 'jsonb') THEN r.request::jsonb ->> 'botActor' = 'true' END
      ), found AS (
        SELECT l.tenant_id, l.id, any_value(l.json ->> 'ownerScopeId') AS scope, any_value(l.json ->> 'cronId') AS cron_id,
               any_value(l.json @> '{"botActor": true}') AS marked,
               (array_agg(b.source ORDER BY b.started DESC) FILTER (WHERE h -> 'version' = '1'))[1] AS created_by,
               (array_agg(b.source ORDER BY b.started DESC) FILTER (WHERE h -> 'version' = l.json -> 'playbookVersion'
                 AND l.json ->> 'taskAuthor' IS DISTINCT FROM 'automation'))[1] AS rewritten_by
          FROM loops l
          CROSS JOIN LATERAL jsonb_array_elements(l.json -> 'playbookHistory') h
          JOIN bot_calls b ON b.tenant_id = l.tenant_id AND (h ->> 'at')::bigint BETWEEN b.started AND b.ended
                          AND strpos(b.evidence, l.id) > 0
         WHERE h -> 'version' = '1' OR h -> 'version' = l.json -> 'playbookVersion'
         GROUP BY l.tenant_id, l.id
      ), written AS (
        SELECT *, CASE WHEN created_by IS NULL THEN '{}' ELSE '{"botActor": true}'::jsonb END
                    || CASE WHEN rewritten_by IS NULL THEN '{}' ELSE '{"taskAuthor": "automation"}'::jsonb END AS patch
          FROM found WHERE NOT marked AND (created_by IS NOT NULL OR rewritten_by IS NOT NULL)
      ), granted AS (
        SELECT DISTINCT ON (g.tenant_id, g.id) g.tenant_id, g.id, l.json ->> 'ownerScopeId' AS scope,
               l.id AS loop_id, g.json ->> 'shipAction' AS ship_action, b.source
          FROM loop_ship_grants g
          JOIN bot_calls b ON b.tenant_id = g.tenant_id AND (g.json ->> 'createdAt')::bigint BETWEEN b.started AND b.ended
                          AND strpos(b.evidence, g.json ->> 'loopId') > 0
          JOIN loops l ON l.tenant_id = g.tenant_id AND l.id = g.json ->> 'loopId'
         WHERE NOT g.json ? 'revokedAt'
         ORDER BY g.tenant_id, g.id, b.started DESC
      ), holds AS (
        SELECT x.tenant_id, x.id, x.scope, x.source, jsonb_agg(DISTINCT p ->> 'action') AS actions
          FROM (SELECT tenant_id, loop_id AS id, scope, source, ship_action AS action FROM granted
                UNION ALL
                SELECT tenant_id, id, scope, created_by, NULL FROM found WHERE created_by IS NOT NULL) x
          JOIN loops l ON l.tenant_id = x.tenant_id AND l.id = x.id
          CROSS JOIN LATERAL jsonb_array_elements(l.json -> 'shipActions') p
         WHERE p ->> 'gate' = 'auto' AND (x.action IS NULL OR p ->> 'action' = x.action)
         GROUP BY x.tenant_id, x.id, x.scope, x.source
      ), gated AS (
        SELECT l.tenant_id, l.id,
               jsonb_agg(CASE WHEN h.actions ? (p ->> 'action') THEN p || '{"gate": "hold"}'::jsonb ELSE p END ORDER BY n)
                 AS ship_actions
          FROM (SELECT tenant_id, id, jsonb_agg(a) AS actions
                  FROM holds CROSS JOIN LATERAL jsonb_array_elements_text(actions) a GROUP BY tenant_id, id) h
          JOIN loops l ON l.tenant_id = h.tenant_id AND l.id = h.id
          CROSS JOIN LATERAL jsonb_array_elements(l.json -> 'shipActions') WITH ORDINALITY AS a(p, n)
         GROUP BY l.tenant_id, l.id
      ), changes AS (
        SELECT COALESCE(w.tenant_id, g.tenant_id) AS tenant_id, COALESCE(w.id, g.id) AS id,
               COALESCE(w.patch, '{}') || CASE WHEN g.id IS NULL THEN '{}' ELSE jsonb_build_object('shipActions', g.ship_actions) END
                 AS patch
          FROM written w FULL JOIN gated g ON g.tenant_id = w.tenant_id AND g.id = w.id
      ), marked AS (
        UPDATE loops l SET json = l.json || c.patch
          FROM changes c WHERE l.tenant_id = c.tenant_id AND l.id = c.id
        RETURNING l.tenant_id
      ), marked_crons AS (
        UPDATE crons k SET json = k.json || '{"botActor": true}'::jsonb
          FROM written w WHERE w.created_by IS NOT NULL AND k.tenant_id = w.tenant_id AND k.id = w.cron_id
           AND k.json ->> 'botActor' IS DISTINCT FROM 'true'
        RETURNING k.tenant_id, k.id, k.json ->> 'ownerScopeId' AS scope, w.created_by || '{"botActor": true}'::jsonb AS detail
      ), revoked AS (
        UPDATE loop_ship_grants g
           SET json = g.json || jsonb_build_object('revokedAt', ${msOf("now()")}, 'revokedBy', 'system:migration')
          FROM granted x WHERE g.tenant_id = x.tenant_id AND g.id = x.id
        RETURNING g.tenant_id
      ), versions AS (
        UPDATE durable_map_versions SET v = v + 1
         WHERE tbl = 'loops' AND tenant_id IN (SELECT tenant_id FROM marked)
            OR tbl = 'crons' AND tenant_id IN (SELECT tenant_id FROM marked_crons)
            OR tbl = 'loop_ship_grants' AND tenant_id IN (SELECT tenant_id FROM revoked)
      )
      INSERT INTO audit_log (tenant_id, at, principal_id, action, resource, scope_label, detail)
      SELECT tenant_id, ${msOf("now()")}, 'system:migration', action, id, scope, detail::text
        FROM (SELECT tenant_id, 'loop_update' AS action, id, scope, created_by || '{"botActor": true}'::jsonb AS detail
                FROM written WHERE created_by IS NOT NULL
              UNION ALL
              SELECT tenant_id, 'loop_update', id, scope, rewritten_by || '{"taskAuthor": "automation"}'::jsonb
                FROM written WHERE rewritten_by IS NOT NULL
              UNION ALL
              SELECT tenant_id, 'loop_update', id, scope, source || jsonb_build_object('heldShipActions', actions) FROM holds
              UNION ALL
              SELECT tenant_id, 'cron_update', id, scope, detail FROM marked_crons
              UNION ALL
              SELECT tenant_id, 'ship_grant_revoke', id, scope, source || jsonb_build_object('loopId', loop_id) FROM granted) entries;
    END $$`,
  ],
};
