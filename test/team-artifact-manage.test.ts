import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanManageScope, createManagesArtifactHome } from "../src/resolution/scope-membership.ts";

const finance = new Set(["yna@x.com", "josh@x.com"]);
const deps = {
  teams: { isMember: async (principalId: string, teamId: string) => teamId === "finance" && finance.has(principalId) },
  identity: {
    classify: (principalId: string) => ({
      type: principalId.startsWith("ext") ? ("external" as const) : ("internal" as const),
    }),
  },
};

test("a team-owned artifact is managed by the team's current members, not only its creator", async () => {
  const manages = createManagesArtifactHome(deps as never, createCanManageScope(deps as never));
  // The creator moved it in; a teammate who didn't create it can still share or move it.
  assert.equal(await manages("team:finance", "josh@x.com", "josh@x.com"), true);
  assert.equal(await manages("team:finance", "josh@x.com", "yna@x.com"), true);
});

test("a team-owned artifact is not manageable by non-members, including a creator who is no longer on the team", async () => {
  const manages = createManagesArtifactHome(deps as never, createCanManageScope(deps as never));
  assert.equal(await manages("team:finance", "josh@x.com", "outsider@x.com"), false);
  assert.equal(await manages("team:finance", "former@x.com", "former@x.com"), false);
  assert.equal(await manages("team:other", "yna@x.com", "yna@x.com"), false);
  assert.equal(await manages("team:finance", "josh@x.com", "ext@x.com"), false);
});

test("without a team store, team-owned artifacts stay unmanageable (fails closed)", async () => {
  const noTeams = { identity: deps.identity };
  const manages = createManagesArtifactHome(noTeams as never, createCanManageScope(noTeams as never));
  assert.equal(await manages("team:finance", "yna@x.com", "yna@x.com"), false);
});
