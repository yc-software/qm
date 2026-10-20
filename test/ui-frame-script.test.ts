import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../skills-seed/ui-frame/scripts/frame.mjs", import.meta.url));

async function frame(args: string[], env: Record<string, string> = {}) {
  return run(process.execPath, [script, ...args], { env: { ...process.env, ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );
}

test("ui-frame escapes titles and URLs into markup and keeps the script fixed", async () => {
  const r = await frame([
    "--dry-run",
    "--no-check",
    "https://example.com/a?x=1&y=<b>",
    "--title",
    'Q"<img src=x>',
    "--width",
    "500",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.replace, true);
  assert.equal(body.pinned, false);
  assert.match(body.html, /data-src="https:\/\/example\.com\/a\?x=1&amp;y=%3Cb%3E"/);
  assert.match(body.html, /Q&quot;&lt;img src=x&gt;/);
  assert.doesNotMatch(body.html, /<img/);
  assert.match(body.html, /sandbox="allow-scripts allow-same-origin[^"]*"/);
  assert.doesNotMatch(body.html, /allow-top-navigation/);
  assert.doesNotMatch(body.js, /example\.com/);
  const other = JSON.parse((await frame(["--dry-run", "--no-check", "https://other.test/"])).stdout);
  assert.equal(other.js, body.js);
});

test("ui-frame refuses non-https URLs, embedded credentials and bad sizes", async () => {
  for (const args of [
    ["http://example.com"],
    ["https://u:p@example.com"],
    ["https://example.com", "--width", "9"],
    [],
  ]) {
    const r = await frame(["--dry-run", "--no-check", ...args]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
  }
});

test("ui-frame writes the canvas through the agent API", async (t) => {
  let seen: { token?: string; body?: Record<string, unknown> } = {};
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen = { token: String(req.headers["x-agent-capability"]), body: JSON.parse(raw) };
    res.writeHead(200, { "content-type": "application/json" }).end('{"canvas":{"rev":3}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const r = await frame(["--no-check", "--pin", "--always-on", "https://example.com"], {
    AGENT_API_URL: `http://127.0.0.1:${port}`,
    AGENT_API_TOKEN: "synthetic-token",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen.token, "synthetic-token");
  assert.equal(seen.body?.pinned, true);
  assert.equal(seen.body?.alwaysOn, true);
  assert.match(r.stdout, /"rev":3/);
});
