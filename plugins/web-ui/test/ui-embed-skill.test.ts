import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";

const scripts = new URL("../../../skills-seed/ui-embed/scripts/", import.meta.url);
const block = (code: string, language = "embed") =>
  `<code-block language="${language}" code="${Buffer.from(code).toString("base64")}"></code-block>`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

test("embed blocks in finished agent messages become sandboxed iframes until the canvas closes", async () => {
  const dom = new JSDOM(
    `<article class="message-row assistant-row">${block("https://example.com/a?b=1\nheight=300")}${block("http://example.com/")}${block("https://localhost/x")}${block("https://example.com/", "js")}</article>
     <article class="message-row assistant-row streaming">${block("https://example.org/")}</article>
     <article class="message-row user-row">${block("https://example.net/")}</article>`,
    { url: "https://localhost/", runScripts: "outside-only" },
  );
  const disposers: Array<() => void> = [];
  Object.assign(dom.window, { canvas: { onDispose: (fn: () => void) => disposers.push(fn) } });
  dom.window.eval(await readFile(new URL("embed.js", scripts), "utf8"));
  const doc = dom.window.document;
  const frames = () => [...doc.querySelectorAll("iframe")].map((f) => f.getAttribute("src"));

  assert.deepEqual(frames(), ["https://example.com/a?b=1"]);
  const frame = doc.querySelector("iframe")!;
  assert.equal(frame.style.height, "300px");
  assert.doesNotMatch(frame.getAttribute("sandbox")!, /top-navigation/);
  assert.equal(frame.closest("[data-qm-embed]")!.previousElementSibling!.getAttribute("style"), "display: none;");

  doc.querySelector(".streaming")!.classList.remove("streaming");
  await settle();
  assert.deepEqual(frames(), ["https://example.com/a?b=1", "https://example.org/"]);

  disposers.forEach((fn) => fn());
  assert.deepEqual(frames(), []);
  assert.equal(doc.querySelectorAll('code-block[style*="none"]').length, 0);
  dom.window.close();
});

test("install puts the embed script on an empty always-on canvas and won't overwrite another one", async (t) => {
  let stored: { html: string; css: string; js: string } | null = { html: "<p>mine</p>", css: "", js: "" };
  const posts: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    assert.match(req.url!, /alwaysOn=true/);
    if (req.method === "POST") {
      posts.push(JSON.parse(raw));
      stored = posts.at(-1) as typeof stored;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ canvas: stored }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = {
    ...process.env,
    AGENT_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    AGENT_API_TOKEN: "synthetic-token",
  };
  const install = () =>
    promisify(execFile)(process.execPath, [new URL("install.mjs", scripts).pathname], { env }).then(
      () => 0,
      (e: { code: number }) => e.code,
    );

  assert.equal(await install(), 3);
  assert.equal(posts.length, 0);
  stored = null;
  assert.equal(await install(), 0);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.alwaysOn, true);
  assert.equal(posts[0]!.js, await readFile(new URL("embed.js", scripts), "utf8"));
  assert.equal(await install(), 0);
  assert.equal(posts.length, 1);
});
