import assert from "node:assert/strict";
import { test } from "node:test";
import { marked } from "marked";
import katex from "katex";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import {
  MARKDOWN_SANITIZE_CONFIG,
  rewriteSandboxFileLinks,
  SHARED_MARKDOWN_SANITIZE_CONFIG,
} from "../src/markdown-sanitize.ts";

const DOMPurify = createDOMPurify(new JSDOM("").window as unknown as Window & typeof globalThis);
const sanitize = (html: string): string => DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG) as string;

const renderer = new marked.Renderer();
const originalLink = renderer.link.bind(renderer);
renderer.link = (token) => originalLink(token).replace("<a ", '<a target="_blank" rel="noopener noreferrer" ');
const render = (md: string): string => sanitize(rewriteSandboxFileLinks(marked.parse(md, { async: false, renderer })));

test("strips every script-bearing vector marked would otherwise pass through", () => {
  const vectors: Array<[string, string]> = [
    ["javascript link", "[click](javascript:alert(document.cookie))"],
    ["vbscript link", "[click](vbscript:msgbox(1))"],
    ["raw script tag", "hi <script>alert(1)</script>"],
    ["img onerror", "<img src=x onerror=alert(1)>"],
    ["svg onload", "<svg onload=alert(1)></svg>"],
    ["iframe", "<iframe src=/api/files/x/content></iframe>"],
    ["data:text/html link", "[x](data:text/html,<script>alert(1)</script>)"],
    ["a with onclick", '<a href="#" onclick="alert(1)">x</a>'],
  ];
  for (const [name, md] of vectors) {
    const out = render(md);
    assert.ok(
      !/<script|<iframe|onerror=|onload=|onclick=|javascript:|data:text\/html/i.test(out),
      `${name} leaked: ${out}`,
    );
  }
});

test("preserves ordinary links (target=_blank), code fences, and inline PNG images", () => {
  const link = render("[docs](https://example.com/a)");
  assert.match(link, /href="https:\/\/example\.com\/a"/);
  assert.match(link, /target="_blank"/);
  assert.match(render("```js\nconst x = 1;\n```"), /<(pre|code)/);
  assert.match(render("![i](data:image/png;base64,iVBORw0KGgo=)"), /data:image\/png/);
});

test("preserves KaTeX math output (visible render + MathML annotation)", () => {
  const out = sanitize(katex.renderToString("x^2 + y^2", { throwOnError: false }));
  assert.match(out, /class="katex/);
  assert.match(out, /<math/);
  assert.match(out, /annotation/);
});

test("shared Markdown preserves formatting without media or private file links", () => {
  const source =
    '**Packing list**\n\n- Water\n- Snacks\n\n```js\nconst safe = true;\n```\n![remote](https://example.test/track)\n[private](sandbox:/home/sprite/workspace/secret.txt)\n<img src="/api/files/secret/content"><svg><a xlink:href="/api/sessions/private">hidden link</a></svg>';
  const result = DOMPurify.sanitize(marked.parse(source, { async: false }), SHARED_MARKDOWN_SANITIZE_CONFIG) as string;
  assert.ok(result.includes("<strong>Packing list</strong>"));
  assert.ok(result.includes("<li>Water</li>"));
  assert.ok(result.includes("const safe = true;"));
  assert.equal(/<img|(?:src|href)=|secret\.txt|api\/files/.test(result), false);
});

test("turns sandbox workspace links into real file-library downloads", () => {
  const out = render("[download](sandbox:/home/sprite/workspace/reports/interview-list.csv)");
  assert.match(out, /href="\/api\/files\/by-name\/content\?name=interview-list\.csv"/);
});
