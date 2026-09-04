import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAwsSecretsManagerSource,
  createEnvSecretSource,
  createLayeredSecretSource,
} from "../src/credentials/secret-source.ts";

test("env source reads the provided env; a missing or blank var is a miss", async () => {
  const src = createEnvSecretSource({ FOO: "bar", BLANK: "" } as NodeJS.ProcessEnv);
  assert.equal(await src.get("FOO"), "bar");
  assert.equal(await src.get("MISSING"), undefined);
  assert.equal(await src.get("BLANK"), undefined);
});

test("layered source: a blank env var doesn't shadow the source underneath", async () => {
  const src = createLayeredSecretSource(
    createEnvSecretSource({ A: "" } as NodeJS.ProcessEnv),
    createEnvSecretSource({ A: "aws-a" } as NodeJS.ProcessEnv),
  );
  assert.equal(await src.get("A"), "aws-a");
});

test("layered source: first defined value wins, later sources fill gaps", async () => {
  const src = createLayeredSecretSource(
    createEnvSecretSource({ A: "env-a" } as NodeJS.ProcessEnv),
    createEnvSecretSource({ A: "aws-a", B: "aws-b" } as NodeJS.ProcessEnv),
  );
  assert.equal(await src.get("A"), "env-a");
  assert.equal(await src.get("B"), "aws-b");
  assert.equal(await src.get("C"), undefined);
});

function fakeClient(values: Record<string, string>, log: string[]) {
  return {
    async send(cmd: { input: { SecretId?: string } }) {
      const id = cmd.input.SecretId ?? "";
      log.push(id);
      if (!(id in values)) {
        const err = new Error("not found");
        err.name = "ResourceNotFoundException";
        throw err;
      }
      return { SecretString: values[id] };
    },
  };
}

test("aws source prefixes names, caches hits and misses with a TTL", async () => {
  let at = 0;
  const log: string[] = [];
  const src = createAwsSecretsManagerSource({
    prefix: "qm-prod-",
    client: fakeClient({ "qm-prod-VAULT_TOKEN_X": "tok" }, log),
    ttlMs: 1_000,
    now: () => at,
  });
  assert.equal(await src.get("VAULT_TOKEN_X"), "tok");
  assert.equal(await src.get("VAULT_TOKEN_X"), "tok");
  assert.equal(await src.get("NOPE"), undefined);
  assert.equal(await src.get("NOPE"), undefined);
  assert.deepEqual(log, ["qm-prod-VAULT_TOKEN_X", "qm-prod-NOPE"]);
  at = 1_500;
  assert.equal(await src.get("VAULT_TOKEN_X"), "tok");
  assert.equal(log.length, 3);
});

test("aws source: a transient error serves the last known value within the stale bound, then stops", async () => {
  let fail = false;
  let calls = 0;
  const client = {
    async send(cmd: { input: { SecretId?: string } }) {
      calls++;
      if (fail) throw new Error("throttled");
      return { SecretString: `v${calls}:${cmd.input.SecretId}` };
    },
  };
  let at = 0;
  const src = createAwsSecretsManagerSource({ client, ttlMs: 1_000, maxStaleMs: 10_000, now: () => at });
  assert.equal(await src.get("S"), "v1:S");
  at = 2_000;
  fail = true;
  assert.equal(await src.get("S"), "v1:S");
  assert.equal(await src.get("S"), "v1:S");
  assert.equal(calls, 2, "the error result is cached for a TTL — no hammering");
  at = 20_000;
  assert.equal(await src.get("S"), undefined, "past maxStaleMs the stale value stops flowing");
  fail = false;
  at = 22_000;
  assert.equal(await src.get("S"), `v${calls}:S`);
});
