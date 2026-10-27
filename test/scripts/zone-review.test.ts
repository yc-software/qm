import assert from "node:assert/strict";
import test from "node:test";
import { chunks, diffSource, fileSource, inZone, isReviewable, verifiedFindings } from "../../scripts/zone-review.ts";

test("zone entries cover their directory and exact files only", () => {
  const zone = ["src/turns", "src/tenant.ts"];
  assert.deepEqual(
    ["src/turns/a.ts", "src/turns-old/a.ts", "src/tenant.ts", "src/tenant.tsx"].filter((p) => inZone(zone, p)),
    ["src/turns/a.ts", "src/tenant.ts"],
  );
});

test("tests, docs and SQL are not reviewed", () => {
  assert.deepEqual(
    ["src/a.ts", "src/a.test.ts", "test/b.ts", "docs/SPEC.md", "src/turns/absurd.sql", "plugins/x/y.css"].filter(
      isReviewable,
    ),
    ["src/a.ts", "plugins/x/y.css"],
  );
});

test("diff anchors are the added lines with their new line numbers", () => {
  const diff =
    "--- a/x.ts\n+++ b/x.ts\n@@ -3,3 +3,4 @@\n keep\n-gone\n+added one\n+added two\n keep\n@@ -20 +21 @@\n+late\n";
  assert.deepEqual(diffSource("x.ts", diff).anchorable, [
    { line: 4, text: "added one" },
    { line: 5, text: "added two" },
    { line: 21, text: "late" },
  ]);
});

test("findings survive only when their anchor is in the reviewed code", () => {
  const source = fileSource("x.ts", "const a = 1;\ntry { run(); } catch {}\n");
  const finding = (anchor: string) => ({
    lens: "Discarded error evidence (3 examples)",
    severity: "low",
    path: "x.ts",
    anchor,
    title: "t",
  });
  const reply = `Here:\n${JSON.stringify({ findings: [finding("  catch {}"), finding("invented()"), { ...finding("const a"), path: "y.ts" }, { lens: "Regex", severity: "low", path: "x.ts", title: "no anchor" }] })}`;
  assert.deepEqual(verifiedFindings(reply, [source]), {
    findings: [
      { path: "x.ts", line: 2, lens: "Discarded error evidence", severity: "low", title: "t", anchor: "catch {}" },
    ],
    unverified: 3,
  });
});

test("chunks stay under the line cap unless one file exceeds it", () => {
  const file = (n: number) => fileSource(`f${n}.ts`, "x\n".repeat(n));
  assert.deepEqual(
    chunks([file(1000), file(400), file(200), file(2000)]).map((c) => c.map((s) => s.path)),
    [["f1000.ts", "f400.ts"], ["f200.ts"], ["f2000.ts"]],
  );
});
