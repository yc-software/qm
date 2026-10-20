import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/harness/redact-secrets.ts";

test("redacts env assignments whose name marks a secret, even when the name only contains the marker", () => {
  const out = redactSecrets(
    "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY\nDB_PASSWORD='hunter2' SLACK_BOT_TOKEN=\"abc\"",
  );
  assert.equal(out, "export AWS_SECRET_ACCESS_KEY=[redacted]\nDB_PASSWORD='[redacted]' SLACK_BOT_TOKEN=\"[redacted]\"");
});

test("redacts URL passwords, private key blocks and Slack tokens", () => {
  assert.equal(
    redactSecrets("clone https://bot:hunter2@example.com/repo.git failed"),
    "clone https://bot:[redacted]@example.com/repo.git failed",
  );
  assert.equal(
    redactSecrets("key -----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- end"),
    "key [redacted private key] end",
  );
  assert.equal(redactSecrets("token xoxb-1234567890-abcdefghij leaked"), "token [redacted] leaked");
});

test("leaves ordinary text and non-secret env assignments alone", () => {
  const text = "NODE_ENV=production PORT=8080 see https://example.com/a:b and TOKENIZER docs";
  assert.equal(redactSecrets(text), text);
});

test("leaves config values whose names only mention a secret word alone", () => {
  const text =
    "MAX_TOKENS=4096 TOKEN_COUNT=12 TOKENIZER=cl100k PASSWORD_MIN_LENGTH=12 CSRF_TOKEN_HEADER=x-csrf TOKEN_URL=https://example.com/token SECRET_NAME=prod/db";
  assert.equal(redactSecrets(text), text);
});
