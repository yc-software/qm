export const SWARM_DEFAULTS = {
  agents: 32,
  depth: 4,
  contextBytes: 8_192,
  textBytes: 8_192,
  waitMs: 10_000,
  turnMs: 600_000,
};

export type SwarmSettings = typeof SWARM_DEFAULTS;

// Settings that used to cap a swarm's message, notification, spawn and lifetime budgets. They are
// still accepted (and ignored) so stored swarms, SWARM_DEFAULTS and existing callers keep working.
const RETIRED_SETTINGS = new Set(["messages", "notifications", "spawnRequests", "lifetimeMs"]);

const MAX_TIMER_MS = 2_147_483_647;

export function normalizeSwarmSettings(stored: Record<string, unknown>): SwarmSettings {
  return Object.fromEntries(
    Object.keys(SWARM_DEFAULTS).map((key) => [key, stored[key] ?? SWARM_DEFAULTS[key as keyof SwarmSettings]]),
  ) as SwarmSettings;
}

export function resolveSwarmSettings(input: unknown = {}, defaults: SwarmSettings = SWARM_DEFAULTS): SwarmSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid swarm settings");
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (RETIRED_SETTINGS.has(key)) continue;
    if (!Object.hasOwn(SWARM_DEFAULTS, key)) throw new Error(`unknown swarm setting: ${key}`);
    overrides[key] = value;
  }
  const settings = { ...normalizeSwarmSettings(defaults), ...overrides } as SwarmSettings;
  for (const key of Object.keys(SWARM_DEFAULTS) as Array<keyof SwarmSettings>) {
    const value = settings[key];
    if (!Number.isSafeInteger(value) || value < 1 || (key === "turnMs" && value > MAX_TIMER_MS))
      throw new Error(`invalid swarm setting: ${key}`);
  }
  if (settings.agents < 2) throw new Error("swarm settings must allow the root and a worker");
  return settings;
}
