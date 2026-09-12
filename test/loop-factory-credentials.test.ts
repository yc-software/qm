import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecryptedServiceCredential, ServiceCredentialReader } from "../src/credentials/keychain.ts";
import {
  FACTORY_ANTHROPIC_SLUG,
  FACTORY_GITHUB_SLUG,
  FACTORY_LINEAR_SLUG,
  FACTORY_SLACK_SLUG,
  readFactoryCredentials,
  type FactoryCredentials,
} from "../src/loops/factory/credentials.ts";

const LINEAR_SECRET = "lin_FAKE_SECRET_1";
const GITHUB_SECRET = "ghp_FAKE_SECRET_2";
const ANTHROPIC_SECRET = "sk-ant-FAKE_SECRET_3";
const SLACK_SECRET = "xoxb-FAKE_SECRET_4";
const SECRET_BY_SLUG: Record<string, string> = {
  [FACTORY_LINEAR_SLUG]: LINEAR_SECRET,
  [FACTORY_GITHUB_SLUG]: GITHUB_SECRET,
  [FACTORY_ANTHROPIC_SLUG]: ANTHROPIC_SECRET,
  [FACTORY_SLACK_SLUG]: SLACK_SECRET,
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

test("returns each trimmed secret in its own field whatever the delivery mode", async () => {
  const { reader, calls } = fakeReader([
    record(FACTORY_LINEAR_SLUG, { secret: `  ${LINEAR_SECRET}\n`, delivery: "env", envKey: "FACTORY_LINEAR_ENV_KEY" }),
    record(FACTORY_GITHUB_SLUG),
    record(FACTORY_ANTHROPIC_SLUG),
    record(FACTORY_SLACK_SLUG, { secret: `  ${SLACK_SECRET}\n` }),
  ]);

  const result = await readFactoryCredentials(reader, ORG, { slack: true });

  assert.deepEqual(result, {
    ok: true,
    linearApiKey: LINEAR_SECRET,
    githubToken: GITHUB_SECRET,
    anthropicApiKey: ANTHROPIC_SECRET,
    slackBotToken: SLACK_SECRET,
  });
  assert.deepEqual(calls, [
    [ORG, "factory-linear"],
    [ORG, "factory-github"],
    [ORG, "factory-anthropic"],
    [ORG, "factory-slack"],
  ]);
});

const unusable: { label: string; over: Partial<DecryptedServiceCredential> | null }[] = [
  { label: "an absent", over: null },
  { label: "a disabled", over: { enabled: false } },
  { label: "a blank-secret", over: { secret: " \t\n" } },
  { label: "an empty-secret", over: { secret: "" } },
];

for (const { label, over } of unusable) {
  test(`${label} credential is reported missing by slug, alone or alongside the others`, async () => {
    const slugs = [FACTORY_LINEAR_SLUG, FACTORY_GITHUB_SLUG, FACTORY_ANTHROPIC_SLUG];
    for (const broken of slugs) {
      const healthy = slugs.filter((slug) => slug !== broken).map((slug) => record(slug));
      const { reader } = fakeReader(over ? [record(broken, over), ...healthy] : healthy);

      const result = await readFactoryCredentials(reader, ORG, { slack: false });

      assert.deepEqual(result, { ok: false, missing: [broken] });
      assert.deepEqual(Object.keys(result), ["ok", "missing"]);
    }

    const { reader } = fakeReader(over ? slugs.map((slug) => record(slug, over)) : []);

    assert.deepEqual(await readFactoryCredentials(reader, ORG, { slack: false }), {
      ok: false,
      missing: slugs,
    });
  });

  test(`${label} slack credential is required only when the caller asks for it`, async () => {
    const healthy = [FACTORY_LINEAR_SLUG, FACTORY_GITHUB_SLUG, FACTORY_ANTHROPIC_SLUG].map((slug) => record(slug));
    const { reader } = fakeReader(over ? [...healthy, record(FACTORY_SLACK_SLUG, over)] : healthy);

    const optional = await readFactoryCredentials(reader, ORG, { slack: false });

    assert.equal(optional.ok, true);
    assert.equal(Object.hasOwn(optional, "slackBotToken"), false, "an unusable slack secret must not be a key");

    const { reader: required } = fakeReader(over ? [...healthy, record(FACTORY_SLACK_SLUG, over)] : healthy);

    assert.deepEqual(await readFactoryCredentials(required, ORG, { slack: true }), {
      ok: false,
      missing: [FACTORY_SLACK_SLUG],
    });
  });
}

test("a usable slack credential is returned even when the caller does not require it", async () => {
  const { reader } = fakeReader(
    [FACTORY_LINEAR_SLUG, FACTORY_GITHUB_SLUG, FACTORY_ANTHROPIC_SLUG, FACTORY_SLACK_SLUG].map((slug) => record(slug)),
  );

  assert.deepEqual(await readFactoryCredentials(reader, ORG, { slack: false }), {
    ok: true,
    linearApiKey: LINEAR_SECRET,
    githubToken: GITHUB_SECRET,
    anthropicApiKey: ANTHROPIC_SECRET,
    slackBotToken: SLACK_SECRET,
  });
});

test("a required slack credential is named last, after every other missing slug", async () => {
  const { reader } = fakeReader([record(FACTORY_GITHUB_SLUG), record(FACTORY_ANTHROPIC_SLUG)]);

  assert.deepEqual(await readFactoryCredentials(reader, ORG, { slack: true }), {
    ok: false,
    missing: [FACTORY_LINEAR_SLUG, FACTORY_SLACK_SLUG],
  });
});

test("every credential unusable names every slug and carries no secret material", async () => {
  const { reader } = fakeReader([
    record(FACTORY_LINEAR_SLUG, { enabled: false }),
    record(FACTORY_GITHUB_SLUG, { enabled: false }),
    record(FACTORY_ANTHROPIC_SLUG, { enabled: false }),
    record(FACTORY_SLACK_SLUG, { enabled: false }),
  ]);
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
    result = await readFactoryCredentials(reader, ORG, { slack: true });
  } finally {
    for (const [level, fn] of original) console[level] = fn;
  }

  assert.deepEqual(result, {
    ok: false,
    missing: [FACTORY_LINEAR_SLUG, FACTORY_GITHUB_SLUG, FACTORY_ANTHROPIC_SLUG, FACTORY_SLACK_SLUG],
  });
  const serialized = JSON.stringify(result);
  assert.ok(
    !serialized.includes(LINEAR_SECRET) && !serialized.includes(GITHUB_SECRET) && !serialized.includes(SLACK_SECRET),
    "result carries a secret",
  );
  assert.deepEqual(logged, []);
});
