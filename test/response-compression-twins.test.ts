import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function extract(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body not delimited`);
  return source.slice(start, end + 2);
}

const core = readFileSync(fileURLToPath(new URL("../src/api/http.ts", import.meta.url)), "utf8");
const chassis = readFileSync(fileURLToPath(new URL("../plugins/chassis/src/http.ts", import.meta.url)), "utf8");

test("the plugin chassis carries a byte-identical copy of the response compressor", () => {
  for (const name of ["gzipAccepted", "sendBuffered"]) {
    assert.equal(
      extract(chassis, name),
      extract(core, name),
      `${name} has drifted between src/api/http.ts and plugins/chassis/src/http.ts — plugins cannot import core, so the copies must be kept in step by hand`,
    );
  }
  const floor = /const COMPRESS_MIN_BYTES = (\d+);/;
  assert.equal(floor.exec(chassis)?.[1], floor.exec(core)?.[1]);
});
