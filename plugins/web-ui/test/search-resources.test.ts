import assert from "node:assert/strict";
import test from "node:test";
import { resourceResults, matchResources } from "../src/search-resources.ts";

test("compact server results link to each resource without downloading lists", () => {
  const result = resourceResults(
    {
      hits: [
        { id: "skill/1", kind: "skills", title: "Review", snippet: "Changes" },
        { id: "cron1", kind: "crons", title: "Daily", snippet: "Digest" },
        { id: "app1", kind: "deploys", title: "Sales", snippet: "Tracker" },
        { id: "group:team", kind: "contexts", title: "Team", snippet: "Project" },
        { id: "hook1", kind: "webhooks", title: "Review", snippet: "GitHub" },
      ],
      failed: ["crons"],
    },
    "/chat",
  );
  assert.deepEqual(
    result.hits.map((hit) => hit.href),
    [
      "/chat/skills/skill%2F1",
      "/chat/crons/cron1",
      "/chat/apps/app1",
      "/chat/contexts?scope=group%3Ateam",
      "/chat/webhooks/hook1",
    ],
  );
  assert.deepEqual(result.failed, ["Crons"]);
  assert.equal(matchResources(result.hits, "review skills").length, 1);
});
