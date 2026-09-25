import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "skills-seed", "google-workspace", "scripts", "gmail.py");

const DRIVER = `
import base64, importlib.util, json, sys
from email import message_from_bytes
from email.policy import default as default_policy
spec = importlib.util.spec_from_file_location("gmail", sys.argv[1])
gmail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gmail)
raw = gmail.build_raw({"To": "a@b.com", "Subject": "Probe"}, sys.stdin.read())["raw"]
msg = message_from_bytes(base64.urlsafe_b64decode(raw), policy=default_policy)
parts = {p.get_content_type(): p.get_content() for p in msg.walk() if not p.is_multipart()}
print(json.dumps({"contentType": msg.get_content_type(), "parts": parts}))
`;

const havePython = spawnSync("python3", ["--version"]).status === 0;

function buildMime(body: string): { contentType: string; parts: Record<string, string> } {
  const out = execFileSync("python3", ["-c", DRIVER, SCRIPT], { input: body, encoding: "utf8" });
  return JSON.parse(out);
}

test(
  "drafted mail is multipart/alternative so recipients don't get Gmail's narrow plain-text rendering",
  { skip: !havePython },
  () => {
    const body =
      "Hi Alice and Bob,\n\nWould you fill this out? Takes ~5 minutes:\nhttps://forms.example.com/abc123\n\nCarol";
    const mime = buildMime(body);
    assert.equal(mime.contentType, "multipart/alternative");
    const plain = mime.parts["text/plain"];
    const html = mime.parts["text/html"];
    assert.ok(plain && html, "both alternatives exist");
    assert.ok(plain.includes("Takes ~5 minutes"), "plain part keeps the body");
    assert.ok(html.startsWith('<div dir="ltr">'), "html mirror is composer-shaped");
    assert.ok(html.includes("Hi Alice and Bob,<br><br>"), "paragraph breaks survive");
    assert.ok(
      html.includes('<a href="https://forms.example.com/abc123">https://forms.example.com/abc123</a>'),
      "bare URLs stay clickable in the html mirror",
    );
  },
);

test("html mirror escapes markup and keeps sentence punctuation out of links", { skip: !havePython }, () => {
  const mime = buildMime('a < b & "c" — see https://x.test/a?b=1&c=2.');
  const plain = mime.parts["text/plain"];
  const html = mime.parts["text/html"];
  assert.ok(plain && html, "both alternatives exist");
  assert.ok(plain.includes('a < b & "c"'), "plain part is untouched");
  assert.ok(html.includes("a &lt; b &amp; &quot;c&quot; — see"), "text is html-escaped");
  assert.ok(html.includes('<a href="https://x.test/a?b=1&amp;c=2">'), "url is escaped for the attribute");
  assert.ok(html.includes("</a>."), "trailing period stays outside the link");
});

test("smart punctuation stays out of links; balanced brackets stay in", { skip: !havePython }, () => {
  const mime = buildMime("See \u201chttps://x.test/reset?token=abc\u201d and http://[::1]/path\u2026");
  const html = mime.parts["text/html"];
  assert.ok(html, "html part exists");
  assert.ok(html.includes('<a href="https://x.test/reset?token=abc">'), "smart quote trimmed from the href");
  assert.ok(html.includes('<a href="http://[::1]/path">'), "balanced IPv6 brackets kept");
  assert.ok(html.includes("</a>…"), "trailing ellipsis stays outside the link");
});

test("intra-paragraph line breaks survive as <br> in the html mirror", { skip: !havePython }, () => {
  const mime = buildMime("Short.\n\nTwo lines\nin one paragraph");
  assert.equal(mime.contentType, "multipart/alternative");
  const html = mime.parts["text/html"];
  assert.ok(html, "html part exists");
  assert.ok(html.includes("Two lines<br>in one paragraph"), "intra-paragraph breaks become <br>");
});

test(
  "api calls go through curl, which can tunnel the sandbox's https CONNECT egress proxy",
  { skip: !havePython },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-curl-"));
    const argsFile = join(dir, "args.json");
    const stub = join(dir, "curl");
    writeFileSync(
      stub,
      `#!/usr/bin/env python3\nimport json, sys\nbody = sys.stdin.read() if "@-" in sys.argv else ""\n` +
        `json.dump({"argv": sys.argv[1:], "stdin": body}, open(${JSON.stringify(argsFile)}, "w"))\n` +
        `print('{"id":"m1","threadId":"t1"}\\n200', end="")\n`,
    );
    chmodSync(stub, 0o755);
    const out = execFileSync("python3", [SCRIPT, "send-draft", "d1"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM: "tok",
        HTTPS_PROXY: "https://proxy.internal:3128",
      },
    });
    assert.deepEqual(JSON.parse(out), { id: "m1", threadId: "t1" });
    const recorded = JSON.parse(readFileSync(argsFile, "utf8"));
    const sendUrl = recorded.argv.find((a: string) => a.startsWith("https://"));
    assert.equal(sendUrl, "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send");
    assert.ok(recorded.argv.includes("Authorization: Bearer tok"));
    assert.equal(recorded.stdin, '{"id": "d1"}');
  },
);

test("non-2xx responses exit with the status and body excerpt", { skip: !havePython }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-curl-"));
  const stub = join(dir, "curl");
  writeFileSync(
    stub,
    `#!/usr/bin/env python3\nimport sys\nsys.stdin.read()\nprint('{"error":"nope"}\\n403', end="")\n`,
  );
  chmodSync(stub, 0o755);
  const res = spawnSync("python3", [SCRIPT, "send-draft", "d1"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM: "tok" },
  });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("gmail api 403"));
  assert.ok(res.stderr.includes("nope"));
});
