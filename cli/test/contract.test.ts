import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as contract from "../src/contract.ts";

test("contract.d.ts declares exactly the value exports contract.ts provides at runtime", () => {
  const dts = readFileSync(new URL("../src/contract.d.ts", import.meta.url), "utf8");
  const declared = new Set<string>();
  for (const clause of dts.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    if (clause[1]) continue;
    for (const item of clause[2]!.split(",")) {
      const name = item.trim();
      if (!name || name.startsWith("type ")) continue;
      declared.add(name.includes(" as ") ? name.split(" as ").pop()!.trim() : name);
    }
  }
  const runtime = Object.keys(contract).sort();
  assert.deepEqual([...declared].sort(), runtime, "contract.d.ts value exports must match contract.ts runtime exports");
});
