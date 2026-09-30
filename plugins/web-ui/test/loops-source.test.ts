import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../src/loops.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const browse = readFileSync(new URL("../src/browse.ts", import.meta.url), "utf8");

test("unconfirmed loop outputs have confirmation and return controls", () => {
  assert.match(source, /const unconfirmed = outputs\.filter\(\(o\) => o\.state === "unconfirmed"\)/);
  assert.match(source, /Needs confirmation/);
  assert.match(source, /reviewRow\(loop, o, "Confirm shipped"\)/);
  assert.match(source, /decide\(loop, output, "return"\)/);
});

test("loops navigation, routing, and fetching require permission", () => {
  assert.match(browse, /can\("loops"\) \? navRow\("loops"|can\("loops"\)\) list\.push\(to\("loops"/);
  assert.match(shell, /if \(!canView\(v\)\) v = "chats"/);
  assert.match(shell, /isView\(wanted\) && canView\(wanted\)/);
  assert.match(source, /renderLoopsPage[^]*if \(!can\("loops"\)\) return/);
});

test("loop detail derives and renders the autopilot toggle", () => {
  assert.match(source, /shipActions\.length > 0 && loop\.shipActions\.every\(\(policy\) => policy\.gate === "auto"\)/);
  assert.match(source, />Autopilot</);
  assert.match(source, /Ships outputs without review/);
  assert.match(source, /Shipping without review/);
  assert.match(source, /setAutopilot\(loop, !autopilot\)/);
  assert.match(source, /\?disabled=\$\{loopBusy\}/);
  assert.match(source, /loop\.shipActions\.length[^]*class="loop-autopilot/);
});

function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function renderedLoopRow(queue?: { queued: number; inProgress: number }): string {
  const context = createContext({
    loop: { id: "l-1", name: "Software factory", lastFiredAt: 1, ...(queue ? { queue } : {}) },
    nothing: "",
    openLoop: () => {},
    loopIcon: () => "",
    healthBadge: () => "",
    ago: () => "2m ago",
    html(strings: TemplateStringsArray, ...values: unknown[]) {
      const text = (value: unknown): string => (typeof value === "function" ? "" : String(value));
      return strings.reduce(
        (result, part, index) => result + part + (index < values.length ? text(values[index]) : ""),
        "",
      );
    },
  });
  runInContext(stripTypeScriptTypes(`${bodyOf("queueLabel")}\n${bodyOf("loopRow")}`), context);
  return runInContext("loopRow(loop)", context) as string;
}

test("a loop row says what its loop is doing, catching a queue summary that prints a zero part or calls the queue empty when it was never told", () => {
  const meta = (row: string): string[] =>
    [...row.matchAll(/<span class="loop-row-meta">([^<]*)<\/span>/g)].map((match) => match[1]!);

  assert.deepEqual(meta(renderedLoopRow({ inProgress: 1, queued: 2 })), ["last fire 2m ago", "1 working · 2 queued"]);
  assert.deepEqual(meta(renderedLoopRow({ inProgress: 0, queued: 2 })), ["last fire 2m ago", "2 queued"]);
  assert.deepEqual(meta(renderedLoopRow({ inProgress: 1, queued: 0 })), ["last fire 2m ago", "1 working"]);
  assert.deepEqual(meta(renderedLoopRow({ inProgress: 0, queued: 0 })), ["last fire 2m ago", "queue empty"]);
  assert.deepEqual(meta(renderedLoopRow(undefined)), ["last fire 2m ago"]);
});
