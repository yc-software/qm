import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanManageScope, createManagesArtifactHome } from "../src/resolution/scope-membership.ts";

const alpha = new Set(["bo@x.com", "ann@x.com"]);
const deps = {
  teams: { isMember: async (principalId: string, teamId: string) => teamId === "alpha" && alpha.has(principalId) },
  identity: {
    classify: (principalId: string) => ({
      type: principalId.startsWith("ext") ? ("external" as const) : ("internal" as const),
    }),
  },
};

test("a team-owned artifact is managed by the team's current members, not only its creator", async () => {
  const manages = createManagesArtifactHome(deps as never, createCanManageScope(deps as never));
  assert.equal(await manages("team:alpha", "ann@x.com", "ann@x.com"), true);
  assert.equal(await manages("team:alpha", "ann@x.com", "bo@x.com"), true);
});

test("a team-owned artifact is not manageable by non-members, including a creator who is no longer on the team", async () => {
  const manages = createManagesArtifactHome(deps as never, createCanManageScope(deps as never));
  assert.equal(await manages("team:alpha", "ann@x.com", "outsider@x.com"), false);
  assert.equal(await manages("team:alpha", "former@x.com", "former@x.com"), false);
  assert.equal(await manages("team:other", "bo@x.com", "bo@x.com"), false);
  assert.equal(await manages("team:alpha", "ann@x.com", "ext@x.com"), false);
});

test("without a team store, team-owned artifacts stay unmanageable (fails closed)", async () => {
  const noTeams = { identity: deps.identity };
  const manages = createManagesArtifactHome(noTeams as never, createCanManageScope(noTeams as never));
  assert.equal(await manages("team:alpha", "bo@x.com", "bo@x.com"), false);
});
