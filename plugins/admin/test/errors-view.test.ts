import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const source = html.match(/function renderErrors\(root, d\) \{[\s\S]*?\n {6}\}/)?.[0];
assert.ok(source);

function render(all: boolean, errors: unknown[]) {
  let result: { headers: string[]; rows: any[][]; empty: string };
  const element = (tag: string) => ({
    tag,
    children: [] as any[],
    append(...nodes: any[]) {
      this.children.push(...nodes);
    },
  });
  new Function(
    "orgWideView",
    "defaultShell",
    "plural",
    "document",
    "firstLine",
    "timeCell",
    "nodeCell",
    "navLink",
    "shortName",
    "bareDataCard",
    "table",
    "scope",
    "ERRORS_PAGE_SIZE",
    "pager",
    `${source}; renderErrors({appendChild() {}}, arguments[14]);`,
  )(
    () => all,
    () => {},
    (n: number) => String(n),
    { createElement: element },
    (s: string, max: number) => s.split("\n")[0].slice(0, max),
    (ts: number) => ts,
    (node: unknown) => ({ node }),
    (label: string, target: unknown) => ({ label, target }),
    (scope: string) => scope,
    (node: unknown) => node,
    (headers: string[], rows: any[][], empty: string) => {
      result = { headers, rows, empty };
      return { classList: { add() {} } };
    },
    "org:acme",
    50,
    () => ({}),
    { errors },
  );
  return result!;
}

test("error rows preserve full text and link to the owning scope and session", () => {
  const message = "<img src=x onerror=alert(1)>\nfull diagnostic";
  const result = render(true, [
    { ts: 123, category: "turn", code: "failed", message, scopeLabel: "personal:alice", sessionId: "session-1" },
  ]);
  assert.deepEqual(result.headers, ["Category", "Code", "Message", "Scope", "Session", "Time"]);
  const details = result.rows[0][2].node;
  assert.equal(details.tag, "details");
  const [preview, full] = details.children[0].children;
  assert.equal(preview.textContent, message.split("\n")[0]);
  assert.equal(full.tag, "span");
  assert.equal(full.textContent, message);
  assert.equal(full.innerHTML, undefined);
  assert.deepEqual(result.rows[0][3].node.target, { view: "errors", scope: "personal:alice" });
  assert.deepEqual(result.rows[0][4].node.target, { view: "history", scope: "personal:alice", session: "session-1" });
});

test("scope errors omit the scope column and errors without sessions have no session link", () => {
  const result = render(false, [{ ts: 123, scopeLabel: "org:acme", message: "failure" }]);
  assert.equal(result.headers.includes("Scope"), false);
  assert.deepEqual(result.rows[0].at(-2), { text: "—" });
  assert.equal(render(false, []).empty, "No errors recorded for this scope.");
  assert.equal(render(true, []).empty, "No errors recorded.");
});

test("system attribution stays readable without creating an invalid scope link", () => {
  const result = render(true, [{ ts: 123, scopeLabel: "runs:reaper", message: "requeued", sessionId: "s1" }]);
  assert.deepEqual(result.rows[0][3], { text: "runs:reaper" });
  assert.deepEqual(result.rows[0][4].node.target, { view: "history", scope: "org:acme", session: "s1" });
});

test("short and long messages retain an expandable full value", () => {
  const short = render(true, [{ message: "Timed out" }]).rows[0][2].node;
  assert.equal(short.tag, "details");
  assert.equal(short.children[0].children[1].textContent, "Timed out");
  const message = "x".repeat(200);
  const long = render(true, [{ message }]).rows[0][2].node;
  assert.equal(long.tag, "details");
  assert.equal(long.children[0].children[1].textContent, message);
});

test("compact messages retain an expandable full value even below the character limit", () => {
  const message = "A message that may wrap beyond two lines in a narrow column.";
  const details = render(true, [{ message }]).rows[0][2].node;
  assert.equal(details.tag, "details");
  assert.equal(details.children[0].children[1].textContent, message);
});

test("compact errors place timestamps last for org and scoped tables", () => {
  for (const all of [true, false]) {
    const result = render(all, [{ ts: 123, message: "Failed" }]);
    assert.deepEqual(result.headers, ["Category", "Code", "Message", ...(all ? ["Scope"] : []), "Session", "Time"]);
    assert.equal(result.rows[0].at(-1), 123);
  }
});
