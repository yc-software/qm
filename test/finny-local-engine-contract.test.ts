import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = String.raw`
import importlib.util
spec=importlib.util.spec_from_file_location("engine","scripts/dev/finny-local-engine.py")
engine=importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
binding={
  "artifactDigest":"0"*64,
  "policyVersion":"finny-r5.1",
  "evaluator":{
    "id":"local",
    "revision":"2",
    "buildDigest":"1"*64,
    "contractVersion":"finny.spreadsheet-worker.v2",
    "configurationDigest":"2"*64,
  },
  "checks":[{"checkId":check_id,"generation":1} for check_id in engine.CHECKS],
}
assert engine.validate_binding(binding)["evaluator"] == binding["evaluator"]
`;

test("local spreadsheet engine accepts the production v2 evaluator binding", () => {
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
