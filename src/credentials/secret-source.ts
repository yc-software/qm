import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface SecretSource {
  get(name: string): Promise<string | undefined>;
}

export function createEnvSecretSource(env: NodeJS.ProcessEnv = globalThis.process.env): SecretSource {
  return {
    async get(name) {
      const value = env[name];
      return value === "" ? undefined : value;
    },
  };
}

interface SecretValueClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

export function createAwsSecretsManagerSource(opts: {
  prefix?: string;
  client?: SecretValueClient;
  ttlMs?: number;
  maxStaleMs?: number;
  now?: () => number;
}): SecretSource {
  const client = opts.client ?? new SecretsManagerClient({});
  const ttlMs = opts.ttlMs ?? 60_000;
  const maxStaleMs = opts.maxStaleMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: string | undefined; at: number; fetchedAt: number }>();
  return {
    async get(name) {
      const t = now();
      const hit = cache.get(name);
      if (hit && t - hit.at < ttlMs) return hit.value;
      let value: string | undefined;
      try {
        const res = await client.send(new GetSecretValueCommand({ SecretId: `${opts.prefix ?? ""}${name}` }));
        value = res.SecretString;
      } catch (err) {
        if ((err as { name?: string }).name !== "ResourceNotFoundException") {
          console.warn(`[secrets] failed to read '${name}' from Secrets Manager: ${(err as Error).message}`);
          const stale = hit && t - hit.fetchedAt < maxStaleMs ? hit : undefined;
          cache.set(name, { value: stale?.value, at: t, fetchedAt: stale?.fetchedAt ?? t });
          return stale?.value;
        }
      }
      cache.set(name, { value, at: t, fetchedAt: t });
      return value;
    },
  };
}

export function createLayeredSecretSource(...sources: SecretSource[]): SecretSource {
  return {
    async get(name) {
      for (const source of sources) {
        const value = await source.get(name);
        if (value !== undefined) return value;
      }
      return undefined;
    },
  };
}
