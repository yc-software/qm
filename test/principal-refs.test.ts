import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOT_PRINCIPAL_COLUMNS, PRINCIPAL_REFS } from "../src/identity/principal-refs.ts";

const PRINCIPAL_SHAPED =
  /^(principal_id|owner_id|owner_scope_id|grantee_scope_id|granted_by|created_by|created_in_scope|attached_by|added_by|asked_by|set_by|author|actor_id|viewer|scope_id|scope_label|thread_ref|session_ref|recipient_thread_ref|holder|user_id|linked_by|email)$/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Every `table.column` a schema statement in src declares. */
function declaredColumns(): Set<string> {
  const out = new Set<string>();
  for (const file of sources("src")) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\s*\(/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < text.length && depth > 0) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
        i++;
      }
      let level = 0;
      let part = "";
      for (const ch of text.slice(start, i - 1) + ",") {
        if (ch === "(") level++;
        if (ch === ")") level--;
        if (ch === "," && level === 0) {
          const col = /^\s*([a-z_]+)\s+[A-Z]/.exec(part);
          if (col) out.add(`${m[1]}.${col[1]}`);
          part = "";
        } else part += ch;
      }
    }
    for (const m of text.matchAll(/ALTER TABLE\s+([a-z_]+)\s+ADD COLUMN IF NOT EXISTS\s+([a-z_]+)/g))
      out.add(`${m[1]}.${m[2]}`);
  }
  return out;
}

test("every principal-shaped column is registered for combine and the identity migration", () => {
  const known = new Set([...PRINCIPAL_REFS.map((r) => `${r.table}.${r.column}`), ...NOT_PRINCIPAL_COLUMNS]);
  const missing = [...declaredColumns()].filter((c) => PRINCIPAL_SHAPED.test(c.split(".")[1]!) && !known.has(c));
  assert.deepEqual(
    missing,
    [],
    "add these to PRINCIPAL_REFS (or NOT_PRINCIPAL_COLUMNS) in src/identity/principal-refs.ts",
  );
});

test("the scan sees the core tables it guards", () => {
  const cols = declaredColumns();
  for (const c of ["participants.principal_id", "memory_revisions.author", "admin_grants.principal_id"])
    assert.ok(cols.has(c), c);
});

test("combining notebooks interleaves both histories in time order with no trailing join revision", async () => {
  const { interleaveRevisions } = await import("../src/identity/principal-refs.ts");
  const rec = (id: string, text: string) => ({ id, text, sensitivity: "ordinary", sources: [], sourceUnknown: false });
  const rev = (scope_id: string, seq: number, at: number, texts: string[]) => ({
    scope_id,
    seq,
    op: "capture",
    body: "",
    author: null,
    at,
    records: { version: 1, records: texts.map((t) => rec(`${scope_id}:${t}`, t)) },
  });
  const merged = interleaveRevisions(
    ["personal:a", "personal:b"],
    [
      rev("personal:b", 1, 20, ["- b1"]),
      rev("personal:a", 1, 10, ["- a1"]),
      rev("personal:a", 2, 30, ["- a1", "- shared"]),
      rev("personal:b", 2, 40, ["- b1", "- shared", "- b2"]),
    ],
  );
  assert.deepEqual(
    merged.map((r) => r.at),
    [10, 20, 30, 40],
  );
  assert.deepEqual(
    merged.map((r) => r.records.records.map((x) => x.text)),
    [["- a1"], ["- a1", "- b1"], ["- a1", "- shared", "- b1"], ["- a1", "- shared", "- b1", "- b2"]],
  );
  assert.ok(merged.every((r) => r.op === "capture"));
});
