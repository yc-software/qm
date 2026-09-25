export const SWARM_DEFAULTS = {
  agents: 32,
  depth: 4,
  messages: 128,
  notifications: 256,
  spawnRequests: 32,
  contextBytes: 8_192,
  textBytes: 8_192,
  waitMs: 10_000,
  turnMs: 600_000,
  lifetimeMs: 3_600_000,
};

export type SwarmSettings = typeof SWARM_DEFAULTS;

export const SWARM_MAXIMUMS: Readonly<SwarmSettings> = {
  agents: 64,
  depth: 8,
  messages: 256,
  notifications: 1_024,
  spawnRequests: 64,
  contextBytes: 16_384,
  textBytes: 16_384,
  waitMs: 30_000,
  turnMs: 3_600_000,
  lifetimeMs: 86_400_000,
};

export function resolveSwarmSettings(input: unknown = {}, defaults: SwarmSettings = SWARM_DEFAULTS): SwarmSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid swarm settings");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(SWARM_DEFAULTS, key)) throw new Error(`unknown swarm setting: ${key}`);
  }
  const settings = { ...defaults, ...input };
  for (const key of Object.keys(SWARM_DEFAULTS) as Array<keyof SwarmSettings>) {
    const value = settings[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > SWARM_MAXIMUMS[key])
      throw new Error(`invalid swarm setting: ${key}`);
  }
  if (settings.agents < 2) throw new Error("swarm settings must allow the root and a worker");
  return settings;
}
