import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

function fixture(all: boolean, errors: unknown[]) {
  const f = litFixture();
  f.ui.activity.errors(
    f.root,
    { errors },
    {
      all,
      scope: "org:acme",
      errorsPageSize: 50,
      defaultShell() {},
      plural: String,
      firstLine: (s: string, max: number) => s.split("\n")[0].slice(0, max),
      shortName: String,
      relTime: String,
      fmtTime: String,
      navLink: (label: string, target: any) => {
        const a = f.document.createElement("a");
        a.textContent = label;
        a.href = "/" + target.view + "?scope=" + target.scope + (target.session ? "&session=" + target.session : "");
        return a;
      },
    },
  );
  return f;
}

test("error rows escape full diagnostics and preserve scoped session links", () => {
  const message = "<img src=x onerror=alert(1)>\nfull diagnostic";
  const f = fixture(true, [
    { ts: 123, category: "turn", code: "failed", message, scopeLabel: "personal:alice", sessionId: "session-1" },
  ]);
  assert.equal(f.root.querySelector("img"), null);
  assert.equal(f.root.querySelector(".error-preview")!.textContent, message.split("\n")[0]);
  assert.equal(f.root.querySelector(".error-full")!.textContent, message);
  assert.deepEqual(
    [...f.root.querySelectorAll("th")].map((e) => e.textContent),
    ["Category", "Code", "Message", "Scope", "Session", "Time"],
  );
  assert.match(f.root.querySelectorAll("a")[0].href, /errors\?scope=personal:alice/);
  assert.match(f.root.querySelectorAll("a")[1].href, /history\?scope=personal:alice&session=session-1/);
  f.dom.window.close();
});

test("scoped and system error tables preserve attribution, empty states and timestamp placement", () => {
  for (const all of [true, false]) {
    const f = fixture(all, [
      { ts: 123, scopeLabel: "runs:reaper", message: "requeued", sessionId: "s1" },
      { ts: 124, message: "failure" },
    ]);
    assert.equal(f.root.querySelectorAll("th").length, all ? 6 : 5);
    assert.equal(f.root.querySelector("tbody tr")!.lastElementChild!.textContent, "123");
    assert.match(f.root.querySelector("a")!.href, /history\?scope=org:acme&session=s1/);
    assert.equal(f.root.querySelectorAll("a").length, 1);
    if (all) assert.ok(f.root.textContent!.includes("runs:reaper"));
    f.dom.window.close();
    const empty = fixture(all, []);
    assert.equal(
      empty.root.querySelector(".empty")!.textContent,
      all ? "No errors recorded." : "No errors recorded for this scope.",
    );
    empty.dom.window.close();
  }
});

test("all message lengths retain an expandable full value", () => {
  for (const message of [
    "Timed out",
    "A message that may wrap beyond two lines in a narrow column.",
    "x".repeat(200),
  ]) {
    const f = fixture(true, [{ message }]);
    assert.equal(f.root.querySelector("details .error-full")!.textContent, message);
    f.dom.window.close();
  }
});
