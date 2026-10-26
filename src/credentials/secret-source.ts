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
