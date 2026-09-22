import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecryptedServiceCredential, ServiceCredentialReader } from "../src/credentials/keychain.ts";
import {
  FACTORY_LINEAR_SLUG,
  readFactoryCredentials,
  type FactoryCredentials,
} from "../src/loops/factory/credentials.ts";

const LINEAR_SECRET = "lin_FAKE_SECRET_1";
const PASTED_GITHUB_SECRET = "ghp_FAKE_PASTED_SECRET_2";
const PASTED_SLACK_SECRET = "xoxb-FAKE_PASTED_SECRET_4";
const SECRET_BY_SLUG: Record<string, string> = {
  [FACTORY_LINEAR_SLUG]: LINEAR_SECRET,
  "factory-github": PASTED_GITHUB_SECRET,
  "factory-slack": PASTED_SLACK_SECRET,
};
const ORG = "org:acme";

function record(slug: string, over: Partial<DecryptedServiceCredential> = {}): DecryptedServiceCredential {
  return {
    slug,
    name: slug,
    secret: SECRET_BY_SLUG[slug] ?? "",
    delivery: "broker",
    host: "api.example.com",
    deployments: false,
    enabled: true,
    ...over,
  };
}

function fakeReader(records: DecryptedServiceCredential[]): {
  reader: ServiceCredentialReader;
  calls: [string, string][];
} {
  const bySlug = new Map(records.map((rec) => [rec.slug, rec]));
  const calls: [string, string][] = [];
  return {
    reader: {
      getServiceCredentialSecret: async (orgScopeId, slug) => {
        calls.push([orgScopeId, slug]);
        return bySlug.get(slug) ?? null;
      },
    },
    calls,
  };
}

test("only factory-linear is read, so leftover factory-github and factory-slack records are never consulted", async () => {
  const { reader, calls } = fakeReader([
    record(FACTORY_LINEAR_SLUG, { secret: `  ${LINEAR_SECRET}\n`, delivery: "env", envKey: "FACTORY_LINEAR_ENV_KEY" }),
    record("factory-github"),
    record("factory-slack"),
  ]);

  const result = await readFactoryCredentials(reader, ORG);

  assert.deepEqual(result, { ok: true, linearApiKey: LINEAR_SECRET });
  assert.deepEqual(calls, [[ORG, FACTORY_LINEAR_SLUG]]);
});

const unusable: { label: string; over: Partial<DecryptedServiceCredential> | null }[] = [
  { label: "an absent", over: null },
  { label: "a disabled", over: { enabled: false } },
  { label: "a blank-secret", over: { secret: " \t\n" } },
  { label: "an empty-secret", over: { secret: "" } },
];

for (const { label, over } of unusable) {
  test(`${label} factory-linear credential is reported missing by slug`, async () => {
    const { reader } = fakeReader(over ? [record(FACTORY_LINEAR_SLUG, over)] : []);

    const result = await readFactoryCredentials(reader, ORG);

    assert.deepEqual(result, { ok: false, missing: [FACTORY_LINEAR_SLUG] });
    assert.deepEqual(Object.keys(result), ["ok", "missing"]);
  });
}

test("an unusable credential's secret never reaches the failure result or the console", async () => {
  const { reader } = fakeReader([record(FACTORY_LINEAR_SLUG, { enabled: false })]);
  const levels = ["log", "warn", "error", "info", "debug"] as const;
  const original = levels.map((level) => [level, console[level]] as const);
  const logged: string[] = [];
  let result: FactoryCredentials;
  try {
    for (const level of levels) {
      console[level] = (...args: unknown[]) => {
        logged.push(args.join(" "));
      };
    }
    result = await readFactoryCredentials(reader, ORG);
  } finally {
    for (const [level, fn] of original) console[level] = fn;
  }

  assert.deepEqual(result, { ok: false, missing: [FACTORY_LINEAR_SLUG] });
  assert.ok(!JSON.stringify(result).includes(LINEAR_SECRET), "result carries a secret");
  assert.deepEqual(logged, []);
});
