import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalView } from "../src/core/orchestrator/approvals.ts";

const token = "gho_" + "Xq7Lm2Pz9Rt4Vw8Ky3Nb6Hc1Jd5Fg0Sa2Ue7";

test("an approval shown to a person masks literal tokens and nothing else", () => {
  const view = approvalView("cmd_1", {
    sessionId: "s1",
    createdAt: 0,
    command: `git clone https://x-access-token:${token}@github.com/acme/w.git && GH_TOKEN=$GH_TOKEN gh pr create --fill`,
    summary: `Open a PR using ${token}`,
    call: {
      tool: "sandbox",
      input: { sandbox_id: "79ef6ac8-10a3-4415-83e7-0cebcd2b90a4", header: `Authorization: Bearer ${token}` },
    },
  });
  assert.equal(
    view.command,
    "git clone https://x-access-token:[redacted]@github.com/acme/w.git && GH_TOKEN=$GH_TOKEN gh pr create --fill",
  );
  assert.equal(view.summary, "Open a PR using [redacted]");
  assert.deepEqual(view.call?.input, {
    sandbox_id: "79ef6ac8-10a3-4415-83e7-0cebcd2b90a4",
    header: "Authorization: Bearer [redacted]",
  });
});
