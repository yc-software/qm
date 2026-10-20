import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../skills-seed/ui-frame/scripts/frame.mjs", import.meta.url));

async function withCanvasApi(t: test.TestContext) {
  const writes: Array<{ token: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    writes.push({ token: String(req.headers["x-agent-capability"]), body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": "application/json" }).end('{"canvas":{"rev":3}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const frame = (args: string[]) =>
    run(process.execPath, [script, ...args], {
      env: { ...process.env, AGENT_API_URL: `http://127.0.0.1:${port}`, AGENT_API_TOKEN: "synthetic-token" },
    }).then(
      (r) => ({ code: 0, ...r }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
  return { writes, frame };
}

test("ui-frame writes escaped iframe windows with a fixed script to the canvas", async (t) => {
  const { writes, frame } = await withCanvasApi(t);
  const r = await frame(["https://example.com/a?x=1&y=<b>", "--title", 'Q"<img src=x>', "--pin"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"rev":3/);
  const [{ token, body }] = writes;
  assert.equal(token, "synthetic-token");
  assert.equal(body.replace, true);
  assert.equal(body.pinned, true);
  assert.match(String(body.html), /data-src="https:\/\/example\.com\/a\?x=1&amp;y=%3Cb%3E"/);
  assert.match(String(body.html), /Q&quot;&lt;img src=x&gt;/);
  assert.doesNotMatch(String(body.html), /<img/);
  assert.doesNotMatch(String(body.html), /allow-top-navigation/);
  await frame(["https://other.test/"]);
  assert.equal(writes[1]!.body.js, body.js);
});

test("ui-frame refuses non-https URLs, embedded credentials and bad sizes without writing", async (t) => {
  const { writes, frame } = await withCanvasApi(t);
  for (const args of [
    ["http://example.com"],
    ["https://u:p@example.com"],
    ["https://example.com", "--width", "9"],
    [],
  ]) {
    const r = await frame(args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
  }
  assert.equal(writes.length, 0);
});
