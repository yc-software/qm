#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const { AGENT_API_URL, AGENT_API_TOKEN } = process.env;
if (!AGENT_API_URL || !AGENT_API_TOKEN) {
  console.error("install: AGENT_API_URL and AGENT_API_TOKEN must be set");
  process.exit(2);
}
const url = `${AGENT_API_URL}/v1/ui/canvas?alwaysOn=true`;
const headers = { "x-agent-capability": AGENT_API_TOKEN, "content-type": "application/json" };
const js = await readFile(new URL("./embed.js", import.meta.url), "utf8");

const current = await fetch(url, { headers }).then(async (res) => {
  if (!res.ok) throw new Error(`reading the always-on canvas failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).canvas;
});
const ours = (c) => !c.html.trim() && !c.css.trim() && c.js.includes("data-qm-embed");
if (current && !ours(current) && !process.argv.includes("--replace")) {
  console.error("install: the always-on canvas already holds something else; ask before passing --replace");
  process.exit(3);
}
if (current?.js === js) {
  console.log("embeds already installed");
  process.exit(0);
}
const res = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify({ html: "", css: "", js, replace: true, alwaysOn: true }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`install: canvas write failed: HTTP ${res.status} ${text}`);
  process.exit(1);
}
console.log(text);
