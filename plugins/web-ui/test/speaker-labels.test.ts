import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");

test("user bubbles are labeled when several people spoke or when a speaker is not the viewer", () => {
  const rule = chat.match(/function updateSpeakerLabels[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(rule, /const viewer = appState\.me\?\.displayName\?\.trim\(\)\.toLowerCase\(\);/);
  assert.match(
    rule,
    /labelSpeakers =\s*names\.size > 1 \|\| \(Boolean\(viewer\) && \[\.\.\.names\]\.some\(\(n\) => n\.toLowerCase\(\) !== viewer\)\)/,
  );
});

test("the BFF hands the browser the viewer's display name from the portal identity", () => {
  const me = server.match(/pathname === "\/me"[\s\S]*?permissions,\s*\}\);/)?.[0] ?? "";
  assert.match(me, /displayName: resolveIdentity\(req\)\?\.name \?\? null,/);
});
