import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "deploy-saved-edits-route-secret".repeat(2);
const DEPLOYMENT = {
  id: "d1",
  name: "app",
  ownerScopeId: scopeId("personal", "owner"),
  createdBy: "owner",
  currentVersion: 1,
  status: "running",
  public: false,
  createdAt: 1,
  updatedAt: 1,
  versions: [{ version: 1, createdAt: 1, entrypoint: "npm start", snapshotDir: "/unused" }],
};

describe("deployment view with saved edits", () => {
  let server: Server;
  let base: string;

  const get = async (actorId: string) => {
    const cap = await mintCapabilityToken(
      { actorId, scopeId: scopeId("personal", actorId), aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
    const r = await fetch(`${base}/v1/deployments/d1`, { headers: { "x-agent-capability": cap } });
    return z.object({ deployment: z.object({ savedEdits: z.unknown().optional() }) }).parse(await r.json()).deployment;
  };

  before(async () => {
    const app = {
      authorizesCapabilityScope: async () => true,
      getDeployment: async () => DEPLOYMENT,
      deploymentGitPermissionFor: async (_id: string, who: string) => (who === "owner" ? "write" : "read"),
      deploymentGitUrlFor: async () => null,
      deploymentLiveEdit: async () => ({
        draft: {
          deploymentId: "d1",
          commit: "c",
          entrypoint: "npm run dev",
          hot: true,
          savedBy: "owner",
          savedAt: 5,
          reloads: 1,
          failure: "build failed",
        },
      }),
    } as unknown as App;
    server = createServer(app, { replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()), signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("shows a publisher the saved edits and the last publish failure", async () => {
    assert.deepEqual((await get("owner")).savedEdits, { savedAt: 5, publishFailure: "build failed" });
  });

  it("hides them from a viewer", async () => {
    assert.equal((await get("viewer")).savedEdits, undefined);
  });
});
