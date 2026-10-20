export const SWARM_DEFAULTS = {
  agents: 32,
  depth: 4,
  contextBytes: 8_192,
  textBytes: 8_192,
  waitMs: 10_000,
  turnMs: 600_000,
};

const SWARM_CAPS = ["messages", "notifications", "spawnRequests", "lifetimeMs"] as const;

export type SwarmSettings = typeof SWARM_DEFAULTS & Partial<Record<(typeof SWARM_CAPS)[number], number>>;

const MAX_TIMER_MS = 2_147_483_647;

export function resolveSwarmSettings(input: unknown = {}, defaults: SwarmSettings = SWARM_DEFAULTS): SwarmSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid swarm settings");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(SWARM_DEFAULTS, key) && !SWARM_CAPS.includes(key as never))
      throw new Error(`unknown swarm setting: ${key}`);
  }
  const settings: SwarmSettings = { ...defaults, ...input };
  for (const key of [...Object.keys(SWARM_DEFAULTS), ...SWARM_CAPS] as Array<keyof SwarmSettings>) {
    const value = settings[key];
    if (value === undefined && SWARM_CAPS.includes(key as never)) continue;
    if (!Number.isSafeInteger(value) || value! < 1 || (key === "turnMs" && value! > MAX_TIMER_MS))
      throw new Error(`invalid swarm setting: ${key}`);
  }
  if (settings.agents < 2) throw new Error("swarm settings must allow the root and a worker");
  return settings;
}
