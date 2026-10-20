import { test } from "node:test";
import assert from "node:assert/strict";
import { commandActivity } from "../src/harness/command-activity.ts";

test("plain reads and searches are classified from the parsed command", () => {
  assert.deepEqual(commandActivity("cat /workspace/src/main.ts"), { kind: "read", path: "/workspace/src/main.ts" });
  assert.deepEqual(commandActivity("sed -n '1,120p' src/main.ts"), { kind: "read", path: "src/main.ts" });
  assert.deepEqual(commandActivity("sed -n 40p 'my file.ts'"), { kind: "read", path: "my file.ts" });
  assert.deepEqual(commandActivity("rg --files src"), { kind: "list_files", path: "src" });
  assert.deepEqual(commandActivity("rg --files"), { kind: "list_files" });
  assert.deepEqual(commandActivity("rg -n 'gateway|secret' src/main.ts"), {
    kind: "search",
    pattern: "gateway|secret",
    path: "src/main.ts",
  });
  assert.deepEqual(commandActivity('grep -i "a b"'), { kind: "search", pattern: "a b" });
});

test("anything that is not one plain read or search stays a command", () => {
  for (const command of [
    "cat file; rm file",
    "rg foo src | head -10",
    "cat $(find .)",
    'cat "$HOME/x"',
    "rg -g '*.ts' foo src",
    "python3 <<'PY'\nprint(1)\nPY",
    "cat a b",
    "cat -n a",
    "cat a > b",
    "X=1 cat a",
    "sed -n 'p;1,2p' a",
    "sed -n ',2p' a",
    "rg",
    "rg -n",
    "cat 'unterminated",
    "npm test",
    "rg x\n\\reboot",
    "grep -n TODO\n  \\./reset.sh",
  ]) {
    assert.equal(commandActivity(command), undefined, command);
  }
});
