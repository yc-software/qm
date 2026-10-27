import { SettingState, settingRegistry } from "./setting-state.ts";
export type Rule = { id: number; pattern: string; decision: string; reason: string };
export type Bot = { id: number; name: string; mode: string; hours: string };
let nextId = 0;
const fieldNames: Record<string, Record<string, string>> = {
  "org-ambient": { "governance-org-ambient": "on" },
  "auto-flagger": {
    "auto-flagger-model": "modelId",
    "auto-flagger-rubric": "rubric",
  },
  "ambient-policy": { "ambient-enabled": "ambientEnabled" },
  egress: { egress: "allowedHosts", "egress-deny": "deniedHosts" },
  "command-policy": {},
};
export class GovernanceState extends SettingState {
  rules: Rule[] = [];
  bots: Bot[] = [];
  expanded = false;
  disabled = false;
  allowEditor = false;
  denyEditor = false;
  scope = "";
  context: Record<string, any> = {};
  get dirty() {
    try {
      this.collect();
    } catch {
      return true;
    }
    return JSON.stringify(this.collect(false)) !== this.baseline;
  }
  value(id: string) {
    return this.draft[fieldNames[this.key]?.[id]] ?? "";
  }
  change(id: string, value: unknown) {
    this.draft[fieldNames[this.key][id]] = value;
    this.changed();
  }
  get models(): Array<{ id: string; name: string }> {
    const options = [...(this.context.baseModelOptions || [])];
    const configured = this.context.autoFlagger || this.context.autoFlaggerDefault;
    if (configured && !options.some((entry) => entry.id === configured.modelId)) {
      options.push({ id: configured.modelId, name: configured.modelId + " (configured; unavailable)" });
    }
    return options;
  }
  load(body: Record<string, any>, context = this.context, scope = this.scope) {
    this.context = context;
    this.scope = scope;
    this.draft = structuredClone(body);
    this.rules = (body.rules || []).map((r: any) => ({
      id: ++nextId,
      pattern: r.pattern || "",
      decision: r.decision || "deny",
      reason: r.reason || "",
    }));
    this.bots = Object.entries(body.bots || {}).map(([name, b]: [string, any]) => ({
      id: ++nextId,
      name,
      mode: b.mode || "ignore",
      hours: b.rollupHours == null ? "" : String(b.rollupHours),
    }));
    if (this.key === "egress") {
      this.draft.allowedHosts = (body.allowedHosts || []).join("\n");
      this.draft.deniedHosts = (body.deniedHosts || []).join("\n");
      this.allowEditor = !!this.draft.allowedHosts;
      this.denyEditor = !!this.draft.deniedHosts;
    }
    this.expanded = false;
    this.loaded();
  }
  collect(validate = true): Record<string, any> {
    if (this.key === "command-policy") {
      const rules = this.rules
        .filter((r) => r.pattern.trim())
        .map((r) => {
          if (validate) {
            const error = patternError(r.pattern);
            if (error) throw new Error("Fix the highlighted regular expression before saving: " + error);
          }
          return {
            pattern: r.pattern.trim(),
            decision: r.decision,
            ...(r.reason.trim() ? { reason: r.reason.trim() } : {}),
          };
        });
      return { mode: this.draft.mode || "denylist", rules };
    }
    if (this.key === "ambient-policy") {
      const bots: Record<string, any> = {};
      const seen = new Set();
      for (const bot of this.bots) {
        const name = bot.name.trim();
        if (validate && !name) throw new Error("Every bot ledger row needs a bot name.");
        if (validate && seen.has(name.toLowerCase()))
          throw new Error(`Duplicate bot "${name}". The ledger matches names case-insensitively.`);
        seen.add(name.toLowerCase());
        const entry: Record<string, any> = { mode: bot.mode };
        if (bot.mode === "rollup" && bot.hours.trim()) {
          const hours = Number(bot.hours);
          if (validate && (!Number.isFinite(hours) || hours <= 0))
            throw new Error(`Bot "${name}": rollup hours must be a positive number.`);
          entry.rollupHours = hours;
        }
        bots[name] = entry;
      }
      return {
        bots,
        ambientEnabled: this.draft.ambientEnabled ?? null,
        baseUpdatedAt: this.draft.baseUpdatedAt || 0,
      };
    }
    if (this.key === "egress") {
      const parse = (raw: string, label: string) =>
        [
          ...new Set(
            (raw || "")
              .split("\n")
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean),
          ),
        ].map((host) => {
          if (
            validate &&
            (/\s|:\/\/|[/@?#]/.test(host) ||
              host.startsWith(".") ||
              host.endsWith(".") ||
              !/^[a-z0-9:[\]._-]+$/.test(host))
          )
            throw new Error(label + ' contains invalid host "' + host + '". Use hostnames or IPs, not URLs.');
          return host;
        });
      const allowedHosts = parse(this.draft.allowedHosts, "Allowlist");
      const deniedHosts = parse(this.draft.deniedHosts, "Denylist");
      const overlap = allowedHosts.find((host) => deniedHosts.includes(host));
      if (validate && overlap)
        throw new Error(`Host "${overlap}" appears in both lists. Remove it from one list before saving.`);
      return { allowedHosts, deniedHosts };
    }
    return structuredClone(this.draft);
  }
  get warnings(): string[] {
    if (this.key === "egress") {
      try {
        this.collect();
        return [];
      } catch (error) {
        return [(error as Error).message];
      }
    }
    const warnings: string[] = [];
    const patterns = this.rules.map((r) => r.pattern.trim());
    patterns.forEach((pattern, i) => {
      if (!pattern) return;
      const duplicate = patterns.slice(0, i).indexOf(pattern);
      if (duplicate >= 0)
        warnings.push(`Rule ${i + 1} is unreachable because rule ${duplicate + 1} has the same pattern.`);
      const catchAll = patterns.slice(0, i).findIndex((p) => [".*", "^.*$", "[\\s\\S]*", "^[\\s\\S]*$"].includes(p));
      if (catchAll >= 0) warnings.push(`Rule ${i + 1} is shadowed by catch-all rule ${catchAll + 1}.`);
    });
    return warnings;
  }
}
export function patternError(pattern: string): string {
  try {
    new RegExp(pattern);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}
export const states = new Map(Object.keys(fieldNames).map((key) => [key, new GovernanceState(key)]));
export const { collect, capture, commit, status, statusKey } = settingRegistry(states);
export function load(data: Record<string, any>, scope: string, only?: string) {
  const resources: Record<string, [boolean, Record<string, any>]> = {
    "auto-flagger": [
      scope.startsWith("org:") && "autoFlagger" in data,
      data.autoFlagger || data.autoFlaggerDefault || {},
    ],
    "command-policy": [true, data.commandPolicy || { mode: "denylist", rules: [] }],
    "org-ambient": [scope.startsWith("org:") && "orgAmbient" in data, { on: data.orgAmbient !== false }],
    "ambient-policy": [
      "ambientPolicy" in data,
      { ...data.ambientPolicy, baseUpdatedAt: data.ambientPolicy?.updatedAt || 0 },
    ],
    egress: [true, data.egress || { allowedHosts: [], deniedHosts: [] }],
  };
  for (const [key, [available, body]] of Object.entries(resources)) {
    if (only && key !== only) continue;
    const state = states.get(key)!;
    state.available = available;
    state.disabled = key === "egress" && !data.egressEnforcement?.active;
    state.load(body, data, scope);
  }
}

export function updateCatalog(data: Record<string, any>) {
  const state = states.get("auto-flagger")!;
  state.context = {
    ...state.context,
    baseModelOptions: data.baseModelOptions || state.context.baseModelOptions,
  };
  state.render();
}
