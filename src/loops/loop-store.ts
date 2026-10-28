import type {
  Loop,
  LoopCaps,
  LoopGovernorConfig,
  LoopHealth,
  LoopState,
  LoopTriageConfig,
  Destination,
  ShipActionPolicy,
} from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  contentPart,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";

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
  byCron(cronId: string): Promise<Loop | null>;
  update(id: string, patch: LoopPatch): Promise<Loop | null>;
  editPlaybook(id: string, edit: PlaybookEdit): Promise<Loop | null>;
  setState(id: string, state: LoopState): Promise<Loop | null>;
  setHealth(id: string, health: LoopHealth, reason?: string, throttle?: boolean): Promise<Loop | null>;
  recordFireOutcome(id: string, outcome: FireOutcome): Promise<Loop | null>;
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

export function createLoopStore(backing: DurableMap<Loop> = createMemoryMap<Loop>()): LoopStore {
  if (!backing.update) throw new Error("loops need atomic durable updates");
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
      if (backing.insertIfAbsent) {
        const created = await backing.insertIfAbsent(contentId, candidate);
        return { loop: created ? candidate : ((await backing.get(contentId)) ?? candidate), created };
      }
      const loop = await backing.putIfAbsent(contentId, candidate);
      return { loop, created: loop.createdAt === candidate.createdAt };
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
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
    delete: (id) => backing.delete(id),
  };
}
