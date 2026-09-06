import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const sessions = read("src/sessions.ts");
const server = read("server/index.ts");

const fn = (src: string, name: string): string => {
  const body = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
  assert.ok(body, `${name} not found`);
  return body;
};

test("tidy closes archived panes before the list redraws and reports via toast", () => {
  const run = fn(sessions, "runTidy");
  assert.match(run, /for \(const id of archived\) closeSessionSurfaces\(id\);/);
  assert.match(run, /archived\.includes\(s\.id\) \? \{ \.\.\.s, archived: true \}/);
  assert.match(run, /canvasToast\(/);
  assert.match(run, /saveTidySettings\(\)/, "lastRunAt must persist so auto-tidy stays daily");
});

test("auto-tidy runs once per day and only on the first sessions load", () => {
  const auto = fn(sessions, "maybeAutoTidy");
  assert.match(auto, /!tidyState\.auto \|\| Date\.now\(\) - tidyState\.lastRunAt < TIDY_AUTO_INTERVAL_MS/);
  assert.match(sessions, /const firstLoad = !sessionsState\.loaded;[\s\S]*?if \(firstLoad\) maybeAutoTidy\(\);/);
});

test("the tidy relay validates idleDays and registers before the session patch route", () => {
  const tidy = server.indexOf('path: "/api/sessions/tidy"');
  const patch = server.indexOf('method: "POST",\n    path: "/api/sessions/:id"');
  assert.ok(tidy > 0 && patch > 0 && tidy < patch);
  assert.match(server, /idleDays must be a non-negative number/);
});
