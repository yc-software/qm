import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gmailBodyParts } from "../src/connectors/gmail-compose.ts";

const SCRIPT = join(process.cwd(), "skills-seed", "google-workspace", "scripts", "gmail.py");

const havePython = spawnSync("python3", ["--version"]).status === 0;

const enc = (t: string) => Buffer.from(t).toString("base64url");
const part = (mimeType: string, text: string) => ({ mimeType, body: { data: enc(text) } });
const message = (headers: Array<{ name: string; value: string }>, parts: unknown[]) => ({
  payload: { headers, parts },
});

test("drafted mail gets a composer-shaped html mirror with clickable links", () => {
  const { text, html } = gmailBodyParts("Hi Alice,\n\nTakes ~5 minutes:\nhttps://forms.example.com/abc123\n\nCarol");
  assert.ok(text.includes("Takes ~5 minutes"), "plain part keeps the body");
  assert.ok(html.startsWith('<div dir="ltr">Hi Alice,<div><br></div><div>Takes ~5 minutes:</div>'), "line divs");
  assert.ok(html.includes('<a href="https://forms.example.com/abc123">https://forms.example.com/abc123</a>'));
});

test("html mirror escapes markup and keeps punctuation out of links", () => {
  const { html } = gmailBodyParts(
    "a < b & see https://x.test/a?b=1&c=2. and (https://x.test/w_(x)) and http://[::1]/p [\u201chttps://x.test/q\u201d]",
  );
  assert.ok(html.includes("a &lt; b &amp; see"), "text is html-escaped");
  assert.ok(html.includes('<a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a>.'));
  assert.ok(html.includes('<a href="https://x.test/w_(x)">https://x.test/w_(x)</a>)'), "balanced parens kept");
  assert.ok(html.includes('<a href="http://[::1]/p">'), "brackets inside the url kept");
  assert.ok(
    html.includes('<a href="https://x.test/q">https://x.test/q</a>\u201d]'),
    "closing quote and bracket trimmed",
  );
  const started = performance.now();
  gmailBodyParts(`http://a.test/${")".repeat(200_000)}`);
  assert.ok(performance.now() - started < 1000, "a long run of closers trims in linear time");
});

test("replies quote the original the way Gmail's composer does", () => {
  const original = message(
    [
      { name: "From", value: '"Ann Lee" <ann@x.test>' },
      { name: "Date", value: "Wed, 11 Nov 2026 02:28:00 GMT" },
    ],
    [
      part("text/plain", "Caf\u00e9\r\n\r\n> older"),
      part(
        "text/html",
        '<html><head><style>p{}</style></head><body><!-- c --><STYLE>a{}</STYLE><div>Caf\u00e9</div><p>para</p>a<br><a href="u">b</a><img src="cid:logo"><IMG SRC=cid:x><img src="https://x.test/i.png"></body></html>',
      ),
    ],
  );
  const { text, html } = gmailBodyParts("Thanks", original);
  assert.equal(
    text,
    "Thanks\n\nOn Wed, Nov 11, 2026 at 2:28\u202fAM Ann Lee <ann@x.test> wrote:\n\n> Caf\u00e9\n>\n>> older",
  );
  assert.ok(html.includes('Ann Lee &lt;<a href="mailto:ann@x.test">ann@x.test</a>&gt; wrote:<br></div>'));
  assert.ok(
    html.endsWith(
      'padding-left:1ex"><!-- c --><div>Caf\u00e9</div><p>para</p>a<br><a href="u">b</a><img src="https://x.test/i.png"></blockquote></div>',
    ),
  );
  const bare = gmailBodyParts("Ok", message([{ name: "From", value: "a@b.test" }], []));
  assert.ok(bare.text.includes("On <a@b.test> wrote:\n\n>"), "nameless sender keeps brackets; empty body still quoted");
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

test("app-connection calls reuse the account the proxy resolved on the first call", { skip: !havePython }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-proxy-"));
  const log = join(dir, "calls.jsonl");
  const stub = join(dir, "curl");
  writeFileSync(
    stub,
    `#!/usr/bin/env python3\nimport json, sys\nargs = sys.argv[1:]\nbody = sys.stdin.read() if "@-" in args else ""\n` +
      `open(${JSON.stringify(log)}, "a").write(body + "\\n")\n` +
      `open(args[args.index("-D") + 1], "w").write("HTTP/1.1 200 OK\\r\\nX-Composio-Account: ca_resolved1\\r\\n\\r\\n")\n` +
      `print(json.dumps({"messages": [{"id": "m1"}, {"id": "m2"}], "threadId": "t1", "payload": {"headers": []}}) + "\\n200", end="")\n`,
  );
  chmodSync(stub, 0o755);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    AGENT_API_URL: "http://qm.test",
    AGENT_API_TOKEN: "cap",
  };
  delete env.VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM;
  execFileSync("python3", [SCRIPT, "search", "is:unread", "--limit", "2"], { encoding: "utf8", env });
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].accountId, undefined);
  assert.deepEqual(
    calls.slice(1).map((c: { accountId?: string }) => c.accountId),
    ["ca_resolved1", "ca_resolved1"],
  );
});

test("the skill helper composes drafts through core", { skip: !havePython }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-compose-"));
  const log = join(dir, "calls.jsonl");
  const stub = join(dir, "curl");
  writeFileSync(
    stub,
    `#!/usr/bin/env python3\nimport json, sys\nargs = sys.argv[1:]\nbody = sys.stdin.read() if "@-" in args else ""\n` +
      `open(${JSON.stringify(log)}, "a").write(json.dumps({"url": args[-1], "body": body}) + "\\n")\n` +
      `out = {"text": "T", "html": "<b>H</b>"} if args[-1].endswith("/compose") else {"id": "d1"}\n` +
      `print(json.dumps(out) + "\\n200", end="")\n`,
  );
  chmodSync(stub, 0o755);
  const body = join(dir, "body.txt");
  writeFileSync(body, "Hello");
  execFileSync("python3", [SCRIPT, "draft", "--to", "a@b.test", "--subject", "S", "--body-file", body], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      AGENT_API_URL: "http://qm.test",
      AGENT_API_TOKEN: "cap",
      VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM: "tok",
    },
  });
  const [compose, draft] = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(compose.url, "http://qm.test/v1/connectors/gmail/compose");
  assert.deepEqual(JSON.parse(compose.body), { body: "Hello" });
  const raw = Buffer.from(JSON.parse(draft.body).message.raw, "base64url").toString();
  assert.ok(raw.includes("text/plain") && raw.includes("text/html") && raw.includes("<b>H</b>"), "core's parts go out");
});
