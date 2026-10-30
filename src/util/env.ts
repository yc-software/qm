export function boolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off", "none"].includes(v)) return false;
  return undefined;
}

export function numEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function boolEnvStrict(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = boolEnv(value);
  if (parsed === undefined) {
    throw new Error(
      `${name}=${JSON.stringify(value)} is not a recognized boolean — use 1/true/yes/on or 0/false/no/off/none (case-insensitive), or unset it.`,
    );
  }
  return parsed;
}

export function optNum<K extends string>(env: NodeJS.ProcessEnv, name: string, key: K): { [P in K]?: number } {
  const value = numEnvStrict(name, env[name]);
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: number });
}

export function numEnvStrict(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = numEnv(value);
  if (parsed === undefined) {
    throw new Error(`${name}=${JSON.stringify(value)} is not a number — set a finite numeric value, or unset it.`);
  }
  return parsed;
}
