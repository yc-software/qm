import { item } from "./item-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { playgroundPath, playgroundsIn } from "../src/playground.ts";

test("playgrounds come only from typed successful tool results", () => {
  const activity = [
    item("ToolResult", {
      tool: "miniapp",
      body: { display: { artifact: { kind: "playground", artifactId: "a1", title: "Demo" } } },
    }),
    item("ToolResult", {
      tool: "miniapp",
      body: { display: { artifact: { kind: "playground", artifactId: "a1", title: "Duplicate" } } },
    }),
    item("ToolResult", {
      tool: "miniapp",
      isError: true,
      body: { display: { artifact: { kind: "playground", artifactId: "a2", title: "Bad" } } },
    }),
    item("AgentMessage", { variant: "narration", text: "[[miniapp: /m/legacy | ignored]]" }),
  ].map((entry) => ({ item: entry }));

  assert.deepEqual(playgroundsIn(activity), [{ kind: "playground", artifactId: "a1", title: "Demo" }]);
  assert.equal(playgroundPath("a/b", true), "/api/playgrounds/a%2Fb?source=1");
});
