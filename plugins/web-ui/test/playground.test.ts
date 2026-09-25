import { test } from "node:test";
import assert from "node:assert/strict";
import { playgroundPath, playgroundsIn, type PlaygroundActivity } from "../src/playground.ts";

test("playgrounds come only from typed successful tool results", () => {
  const activity: PlaygroundActivity[] = [
    {
      type: "tool_result",
      payload: { tool: "miniapp", display: { artifact: { kind: "playground", artifactId: "a1", title: "Demo" } } },
    },
    {
      type: "tool_result",
      payload: { tool: "miniapp", display: { artifact: { kind: "playground", artifactId: "a1", title: "Duplicate" } } },
    },
    {
      type: "tool_result",
      payload: {
        tool: "miniapp",
        display: { artifact: { kind: "playground", artifactId: "a2", title: "Bad" } },
        isError: true,
      },
    },
    { type: "text", payload: { text: "[[miniapp: /m/legacy | ignored]]" } },
  ];

  assert.deepEqual(playgroundsIn(activity), [{ kind: "playground", artifactId: "a1", title: "Demo" }]);
  assert.equal(playgroundPath("a/b", true), "/api/playgrounds/a%2Fb?source=1");
});
