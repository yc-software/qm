import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const SCRIPT = join(process.cwd(), "skills-seed", "google-workspace", "scripts", "gmail.py");

const DRIVER = `
import base64, importlib.util, json, sys
from email import message_from_bytes
from email.policy import default as default_policy
spec = importlib.util.spec_from_file_location("gmail", sys.argv[1])
gmail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gmail)
original = json.loads(sys.argv[2]) if len(sys.argv) > 2 else None
raw = gmail.build_raw({"To": "a@b.com", "Subject": "Probe"}, sys.stdin.read(), None, original)["raw"]
msg = message_from_bytes(base64.urlsafe_b64decode(raw), policy=default_policy)
parts = {p.get_content_type(): p.get_content() for p in msg.walk() if not p.is_multipart()}
print(json.dumps({"contentType": msg.get_content_type(), "parts": parts}))
`;

const havePython = spawnSync("python3", ["--version"]).status === 0;

function buildMime(body: string, original?: object): { contentType: string; parts: Record<string, string> } {
  const args = ["-c", DRIVER, SCRIPT, ...(original ? [JSON.stringify(original)] : [])];
  const out = execFileSync("python3", args, {
    input: body,
    encoding: "utf8",
    env: { ...process.env, TZ: "America/Los_Angeles" },
  });
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
    assert.ok(html.includes("Hi Alice and Bob,<div><br></div><div>Would you"), "lines become composer divs");
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

const b64 = (text: string) => Buffer.from(text).toString("base64url");

test(
  "a reply quotes the original below the new text the way Gmail does, timed in the owner's zone",
  { skip: !havePython },
  () => {
    const headers = [
      { name: "From", value: "Ann Lee <ann@x.test>" },
      { name: "Date", value: "Wed, 11 Nov 2026 01:52:00 +0000" },
    ];
    const original = {
      payload: {
        mimeType: "multipart/alternative",
        headers,
        parts: [
          { mimeType: "text/plain", body: { data: b64("Caf\u00e9\r\n\r\n> older") } },
          {
            mimeType: "text/html",
            body: {
              data: b64(
                "<html><head><style>p{}</style></head><body><!-- <style> --><p>keep</p><style>a{}</style>" +
                  '<img alt="a>b" src="cid:logo"><img src="https://x.test/cid:1.png"></body></html>',
              ),
            },
          },
        ],
      },
    };
    const mime = buildMime("Thanks  again", original);
    assert.equal(
      mime.parts["text/plain"]?.replaceAll("\r\n", "\n").trimEnd(),
      "Thanks  again\n\nOn Tue, Nov 10, 2026 at 5:52\u202fPM Ann Lee <ann@x.test> wrote:\n\n> Caf\u00e9\n>\n>> older",
    );
    const html = mime.parts["text/html"] ?? "";
    assert.ok(
      html.startsWith('<div dir="ltr">Thanks\u00a0 again</div><br><div class="gmail_quote gmail_quote_container">'),
    );
    assert.ok(html.includes('Ann Lee &lt;<a href="mailto:ann@x.test">ann@x.test</a>&gt; wrote:<br></div>'));
    assert.ok(
      html.trimEnd().endsWith('<!-- <style> --><p>keep</p><img src="https://x.test/cid:1.png"></blockquote></div>'),
    );
  },
);

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
      `meta = json.dumps({"threadId": "t1", "payload": {"headers": []}})\n` +
      `part = "--b\\nContent-ID: <response-%s>\\n\\nHTTP/1.1 200 OK\\n\\n" + meta + "\\n"\n` +
      `listing = json.dumps({"messages": [{"id": "m1"}, {"id": "m2"}]})\n` +
      `print((part % "m1" + part % "m2" + "--b--" if "/batch/" in body else listing) + "\\n200", end="")\n`,
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
  assert.deepEqual(
    calls.map((c: { accountId?: string }) => c.accountId),
    [undefined, "ca_resolved1"],
  );
});

const ids = Array.from({ length: 45 }, (_, i) => `m${i}`);
const row = (id: string) => ({ id, threadId: `t-${id}`, from: null, date: null, subject: id, snippet: `about ${id}` });

function batchReply(requested: string[], limited: Set<string>): string {
  const parts = requested.map((id) => {
    const refused = limited.delete(id);
    const body = refused
      ? { error: { code: 429, message: "Too many concurrent requests for user." } }
      : { id, threadId: `t-${id}`, snippet: `about ${id}`, payload: { headers: [{ name: "Subject", value: id }] } };
    const status = refused ? "429 Too Many Requests" : "200 OK";
    return `--reply\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n`;
  });
  return `${parts.join("")}--reply--\r\n`;
}

test("search fetches listed messages in batches and retries rate-limited ones", { skip: !havePython }, async () => {
  const batches: number[] = [];
  const limited = new Set(["m7"]);
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const call = JSON.parse(raw) as { url: string; body?: string };
      const path = new URL(call.url).pathname;
      if (path.endsWith("/users/me/messages")) return res.end(JSON.stringify({ messages: ids.map((id) => ({ id })) }));
      if (path !== "/batch/gmail/v1") return res.writeHead(500).end("{}");
      const marker = "Content-ID: <";
      const lines = call.body!.split("\r\n").filter((line) => line.startsWith(marker));
      const requested = lines.map((line) => line.slice(marker.length, -1));
      batches.push(requested.length);
      res.writeHead(200, { "content-type": "multipart/mixed; boundary=reply" }).end(batchReply(requested, limited));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const env = { PATH: process.env.PATH, AGENT_API_URL: `http://127.0.0.1:${port}`, AGENT_API_TOKEN: "cap" };
  try {
    const args = [SCRIPT, "search", "newer_than:14d", "--limit", "100"];
    const { stdout } = await promisify(execFile)("python3", args, { env });
    const listed = stdout.trim().split("\n");
    assert.deepEqual(
      listed.map((line) => JSON.parse(line) as unknown),
      ids.map(row),
    );
    assert.deepEqual(batches, [20, 20, 5, 1]);
  } finally {
    server.close();
  }
});
