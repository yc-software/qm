import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "skills-seed", "google-workspace", "scripts", "gmail.py");
const havePython = spawnSync("python3", ["--version"]).status === 0;

function mockGmail(body: string, attachment = false) {
  const dir = mkdtempSync(join(tmpdir(), "gmail-body-"));
  const callsFile = join(dir, "calls.jsonl");
  const bodyFile = join(dir, "body.txt");
  const curl = join(dir, "curl");
  writeFileSync(bodyFile, body);
  const parts = [
    { mimeType: "text/plain", body: { data: Buffer.from(body).toString("base64url") } },
    { mimeType: "text/html", body: { data: Buffer.from('<div dir="ltr"></div>').toString("base64url") } },
  ];
  const payload = {
    mimeType: attachment ? "multipart/mixed" : "multipart/alternative",
    headers: [
      { name: "From", value: "sender@example.test" },
      { name: "Subject", value: "Existing subject" },
    ],
    parts: attachment
      ? [
          { mimeType: "multipart/alternative", parts },
          {
            mimeType: "text/plain",
            filename: "notes.txt",
            body: { data: Buffer.from("Attachment bytes").toString("base64url") },
          },
        ]
      : parts,
  };
  writeFileSync(
    curl,
    `#!/usr/bin/env python3
import json, sys
from urllib.parse import urlsplit
args = sys.argv[1:]
method = args[args.index('-X') + 1]
path = urlsplit(next(a for a in args if a.startswith('https://'))).path
body = json.loads(sys.stdin.read()) if '@-' in args else None
with open(${JSON.stringify(callsFile)}, 'a') as f:
    f.write(json.dumps({'method': method, 'path': path, 'body': body}) + '\\n')
payload = json.loads(${JSON.stringify(JSON.stringify(payload))})
message = {'id': 'm1', 'threadId': 't1', 'payload': payload}
if path.endswith('/profile'):
    result = {'emailAddress': 'self@example.test'}
elif '/threads/' in path:
    result = {'messages': [message]}
elif '/messages/' in path:
    result = message
elif method == 'GET':
    result = {'id': 'd1', 'message': message}
else:
    result = {'id': 'd1', 'message': message}
print(json.dumps(result) + '\\n200', end='')
`,
  );
  chmodSync(curl, 0o755);
  return {
    bodyFile,
    run(args: string[], input?: string) {
      return spawnSync("python3", [SCRIPT, ...args], {
        encoding: "utf8",
        input,
        env: {
          PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM: "test-token-not-a-credential",
        },
      });
    },
    calls(): Array<{ method: string; path: string; body: unknown }> {
      return existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    },
  };
}

for (const [command, body] of [
  ["draft", ""],
  ["reply", " \t\r\n"],
  ["update-draft", ""],
] as const) {
  test(
    `${command} rejects ${body ? "whitespace-only" : "empty"} body files before a draft write`,
    { skip: !havePython },
    () => {
      const mock = mockGmail(body);
      const args =
        command === "draft" ? ["draft", "--to", "recipient@example.test", "--subject", "Probe"] : [command, "d1"];
      const result = mock.run([...args, "--body-file", mock.bodyFile]);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /body.*empty/i);
      assert.ok(
        mock.calls().every((call) => call.method === "GET"),
        "no draft create/update request",
      );
    },
  );
}

test("empty stdin is rejected before creating a draft", { skip: !havePython }, () => {
  const mock = mockGmail("");
  const result = mock.run(["draft", "--to", "recipient@example.test", "--subject", "Probe", "--body-file", "-"], "");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /body.*empty/i);
  assert.deepEqual(mock.calls(), []);
});

test("nonempty input still creates a draft through the mock transport", { skip: !havePython }, () => {
  const mock = mockGmail("Intended body.");
  const result = mock.run([
    "draft",
    "--to",
    "recipient@example.test",
    "--subject",
    "Probe",
    "--body-file",
    mock.bodyFile,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const calls = mock.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/gmail/v1/users/me/drafts");
  const sent = calls[0]!.body as { message: { raw: string } };
  assert.ok(Buffer.from(sent.message.raw, "base64url").toString().includes("Intended body."));
});

for (const attachment of [false, true]) {
  test(
    `sending an existing ${attachment ? "attachment-only" : "subject-only"} draft remains unchanged`,
    { skip: !havePython },
    () => {
      const mock = mockGmail("", attachment);
      const result = mock.run(["send-draft", "d1"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(mock.calls(), [{ method: "POST", path: "/gmail/v1/users/me/drafts/send", body: { id: "d1" } }]);
    },
  );
}

test("attachment-only draft updates retain their existing refusal without mutation", { skip: !havePython }, () => {
  const mock = mockGmail("", true);
  const result = mock.run(["update-draft", "d1", "--body-file", mock.bodyFile]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /draft has attachments/);
  assert.deepEqual(
    mock.calls().map((call) => call.method),
    ["GET"],
  );
});

test("nonempty draft updates preserve the existing subject", { skip: !havePython }, () => {
  const mock = mockGmail("Replacement body.");
  const result = mock.run(["update-draft", "d1", "--body-file", mock.bodyFile]);
  assert.equal(result.status, 0, result.stderr);
  const calls = mock.calls();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "PUT"],
  );
  assert.equal(calls[1]!.path, "/gmail/v1/users/me/drafts/d1");
  const sent = calls[1]!.body as { message: { raw: string } };
  const mime = Buffer.from(sent.message.raw, "base64url").toString();
  assert.ok(mime.includes("Subject: Existing subject"));
  assert.ok(mime.includes("Replacement body."));
});
