import assert from "node:assert/strict";
import test from "node:test";
import { createDirectory } from "../src/slack/directory.ts";

test("the missing-email warning counts current own-team members, not deactivated ones", async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const client = {
      users: { info: async () => ({ user: undefined }) },
      async *paginate(method: string) {
        if (method === "users.list") {
          yield {
            members: [
              { id: "U1", team_id: "T1", name: "alice", profile: { email: "alice@example.com" } },
              { id: "U2", team_id: "T1", name: "bob", profile: {} },
              { id: "U3", team_id: "T1", name: "former", deleted: true, profile: {} },
              { id: "U4", team_id: "T1", name: "gone", deleted: true, profile: {} },
            ],
          };
          return;
        }
        yield { channels: [] };
      },
    };
    const dir = createDirectory({
      core: { pushDirectory: async () => true, holdDirectorySync: async () => null } as never,
      ids: {
        ownTeamId: "T1",
        botUserId: "UBOT",
        ownBotId: "BBOT",
        botHandle: "qm",
        ownWorkspaceUrl: "",
        identityMode: "email",
      },
    });
    await dir.getUserSnapshot(client);
  } finally {
    console.warn = warn;
  }
  const emailWarnings = warnings.filter((line) => line.includes("no visible email"));
  assert.equal(emailWarnings.length, 1);
  assert.match(emailWarnings[0]!, / 1 own-team member\(s\)/);
});
