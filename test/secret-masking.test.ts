import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSecretValueMasker,
  createExactSecretValueMasker,
  executionSecretEnv,
} from "../src/security/secret-masking.ts";

const SECRET = "ghp_secretvalue12345";

test("masks a known injected value wherever it appears, whatever the shell shape", () => {
  const mask = createSecretValueMasker({ GITHUB_TOKEN: SECRET });
  for (const cmd of [
    `export GITHUB_TOKEN="${SECRET}"; gh api user`,
    `export GITHUB_TOKEN=${SECRET}`,
    `curl -u me:${SECRET} https://api.github.com`,
    `curl -H "Authorization: Bearer ${SECRET}" https://x.test`,
    `https://x-access-token:${SECRET}@github.com/org/repo.git`,
  ]) {
    const out = mask(cmd);
    assert.ok(!out.includes(SECRET), `leaked in: ${out}`);
    assert.match(out, /<redacted:GITHUB_TOKEN>/);
  }
});

test("masks URL-encoded and base64 encodings of a known value", () => {
  const value = "p@ss word+/=";
  const mask = createSecretValueMasker({ VAULT_PASS: value });
  assert.ok(!mask(`curl 'https://x.test/?k=${encodeURIComponent(value)}'`).includes(encodeURIComponent(value)));
  const b64 = Buffer.from(value, "utf8").toString("base64");
  assert.ok(!mask(`printf '%s' '${b64}' | base64 -d`).includes(b64.replace(/=+$/, "")));
});

test("a value embedding another is masked whole (longest first)", () => {
  const mask = createSecretValueMasker({ PROXY_URL: `http://u:${SECRET}@[fdaa::1]:3128`, GITHUB_TOKEN: SECRET });
  const out = mask(`export HTTPS_PROXY='http://u:${SECRET}@[fdaa::1]:3128'`);
  assert.equal(out, "export HTTPS_PROXY='<redacted:PROXY_URL>'");
});

test("plumbing keys and short values are not masked", () => {
  const mask = createSecretValueMasker({
    AGENT_API_URL: "https://core.example.test",
    AWS_REGION: "us-west-2",
    PYTHONUNBUFFERED: "1",
    DB_PASS: "hunter2",
  });
  const cmd = "curl https://core.example.test --region us-west-2 && echo 1 hunter2";
  assert.equal(mask(cmd), cmd);
});

test("regex metacharacters in a secret cannot break the replacement", () => {
  const value = "a+b(c)$[d]*e^f.g|h?12";
  const mask = createSecretValueMasker({ WEIRD_KEY: value });
  assert.equal(mask(`use ${value} now`), "use <redacted:WEIRD_KEY> now");
});

test("empty or absent env is a passthrough", () => {
  assert.equal(createSecretValueMasker(undefined)("echo hi"), "echo hi");
  assert.equal(createSecretValueMasker({})("echo hi"), "echo hi");
});

test("a JWT-shaped (base64url) form of a secret is masked", () => {
  const value = "secret+value/with=chars";
  const mask = createSecretValueMasker({ VAULT_PASS: value });
  const b64url = Buffer.from(value, "utf8").toString("base64url");
  assert.equal(
    mask(`curl -H "authorization: Bearer ${b64url}"`),
    'curl -H "authorization: Bearer <redacted:VAULT_PASS>"',
  );
});

test("exact masking preserves surrounding output, handles overlapping values and short secrets once", () => {
  const mask = createExactSecretValueMasker(["a+b", "a", "", "a+b", "<redacted:credential>"]);
  assert.equal(mask("prefix a+b a suffix"), "prefix <redacted:credential> <redacted:credential> suffix");
  assert.equal(createExactSecretValueMasker([])("safe"), "safe");
  assert.equal(createExactSecretValueMasker(["secret"])("c2VjcmV0"), "c2VjcmV0");
});

test("explicit secret fields override configuration names while public fields stay public", () => {
  const env = { AWS_REGION: "credential", USERNAME: "a", PASSWORD: "short", TOKEN: "" };
  const secrets = executionSecretEnv(env, [
    { key: "AWS_REGION", value: "credential", secret: true },
    { key: "USERNAME", value: "a", secret: false },
    { key: "UNRELATED", value: "other", secret: true },
  ]);
  assert.deepEqual(secrets, { AWS_REGION: "credential", PASSWORD: "short", TOKEN: "" });
  assert.equal(createExactSecretValueMasker(Object.values(secrets))("safe unrelated data"), "safe unrelated data");
  assert.equal(createExactSecretValueMasker(Object.values(secrets))("credential"), "<redacted:credential>");
  const mask = createExactSecretValueMasker(Object.values(executionSecretEnv({ AWS_REGION: "us-west-2", TOKEN: "" })));
  assert.equal(mask("us-west-2"), "us-west-2");
});

test("conflicting public metadata cannot exempt an explicitly secret value", () => {
  assert.deepEqual(
    executionSecretEnv({ TOKEN: "protected" }, [
      { key: "TOKEN", value: "protected", secret: true },
      { key: "TOKEN", value: "protected", secret: false },
    ]),
    { TOKEN: "protected" },
  );
});
