import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalView } from "../src/core/orchestrator/approvals.ts";

const token = "gho_" + "Xq7Lm2Pz9Rt4Vw8Ky3Nb6Hc1Jd5Fg0Sa2Ue7";

test("an approval shown to a person masks embedded tokens but keeps the rest of the command readable", () => {
  const view = approvalView("cmd_1", {
    sessionId: "s1",
    createdAt: 0,
    command: `git clone https://x-access-token:${token}@github.com/acme/w.git && GH_TOKEN=${token} gh pr create --fill`,
    summary: `Open a PR using ${token}`,
  });
  assert.doesNotMatch(JSON.stringify(view), new RegExp(token));
  assert.match(view.command, /^git clone https:\/\/x-access-token:/);
  assert.match(view.command, /gh pr create --fill$/);
  assert.match(view.summary ?? "", /^Open a PR using /);
});
