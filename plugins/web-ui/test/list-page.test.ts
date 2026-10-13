import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("list search uses its purpose as an accessible name", () => {
  const source = readFileSync(new URL("../src/list-page.ts", import.meta.url), "utf8");
  assert.equal(source.includes("aria-label=${o.search.placeholder"), true);
});

test("grouped lists separate context identities and preserve the supplied flat order", async () => {
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(new URL("../src/list-page.ts", import.meta.url), "utf8");
  const html = (strings: TemplateStringsArray, ...values: unknown[]): string =>
    strings.reduce((result, text, index) => result + text + String(values[index] ?? ""), "");
  const functions = runInNewContext(
    stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/^export /gm, "")) +
      "\n({ groupListRows, listPageTpl })",
    {
      html,
      nothing: "",
      fieldSelect: () => "",
      icon: () => "",
      repeat: (items: unknown[], _key: unknown, row: (item: unknown) => unknown) => items.map(row).join(""),
      relTime: (at: number) => String(at),
      Plus: null,
      Search: null,
      live: (v: unknown) => v,
    },
  ) as {
    groupListRows: (
      rows: Array<{ scope: string; title: string }>,
      key: (row: { scope: string; title: string }) => string,
      label: () => string,
      render: (row: { scope: string; title: string }) => string,
      activity?: (row: { scope: string; title: string }) => number,
    ) => Array<{ key: string; label: string; rows: string[] }>;
    listPageTpl: (options: Record<string, unknown>) => string;
  };
  const rows = [
    { scope: "group:a", title: "first" },
    { scope: "group:b", title: "second" },
    { scope: "group:a", title: "third" },
  ];
  const groups = functions.groupListRows(
    rows,
    (row) => row.scope,
    () => "Same name",
    (row) => row.title,
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.key, "group:a");
  assert.equal(groups[0]!.rows.join(","), "first,third");
  assert.equal(groups[1]!.rows.join(","), "second");
  const options = { title: "Artifacts", rows: rows.map((row) => row.title), groups, empty: "Empty" };
  const grouped = functions.listPageTpl(options);
  assert.equal(grouped.match(/class="list-group"/g)?.length, 2);
  assert.match(grouped, /list-group-count">2<\/span>/);
  assert.match(grouped, /<details class="list-group" \?open=false>/);
  assert.match(functions.listPageTpl({ ...options, search: { value: "find", placeholder: "Search" } }), /\?open=true/);
  const recent = functions.groupListRows(
    rows,
    (row) => row.scope,
    () => "Context",
    (row) => row.title,
    (row) => ({ first: 1, second: 3, third: 2 })[row.title] ?? 0,
  );
  assert.equal(recent[0]!.key, "group:b");
  assert.equal(recent[1]!.rows.join(","), "third,first");
  const flat = functions.listPageTpl({ ...options, grouping: { value: false } });
  assert.doesNotMatch(flat, /class="list-group"/);
  assert.ok(flat.indexOf("first") < flat.indexOf("second"));
  assert.ok(flat.indexOf("second") < flat.indexOf("third"));
  assert.match(functions.listPageTpl({ title: "Empty", rows: [], groups: [], empty: "Nothing here" }), /Nothing here/);
});
