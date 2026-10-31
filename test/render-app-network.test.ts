import assert from "node:assert/strict";
import { test } from "node:test";
import { createRenderAppNetwork } from "../src/deploy/render-app-network.ts";
import { RenderApiError } from "../src/deploy/render-api.ts";
import type { StoredRenderDeploy } from "../src/deploy/render-deploy-provider.ts";
import { createFakeRenderApi, fakeDeployment, type FakeRenderApiCall } from "./support/fake-render.ts";
import { testMap } from "./support/test-database.ts";

interface Environment {
  id: string;
  name: string;
  projectId: string;
  networkIsolationEnabled: boolean;
}

function fixture(handle: (call: FakeRenderApiCall, environment: Environment) => unknown) {
  const deployment = fakeDeployment();
  const store = testMap<StoredRenderDeploy>();
  const initial: StoredRenderDeploy = {
    deploymentId: deployment.id,
    appRegion: "oregon",
    token: "token",
    suspended: false,
  };
  const environment: Environment = {
    id: "env-app",
    name: `qm-app-${deployment.id}`,
    projectId: "prj-test",
    networkIsolationEnabled: true,
  };
  const api = createFakeRenderApi((call) =>
    call.path === "/projects/prj-test" ? { owner: { id: "tea-test" } } : handle(call, environment),
  );
  const network = createRenderAppNetwork({
    api,
    workspaceId: "tea-test",
    projectId: "prj-test",
    store,
    name: (d) => `qm-app-${d.id}`,
  });
  return {
    store,
    initial,
    environment,
    api,
    async ensure() {
      await store.put(deployment.id, initial);
      return network.ensure(deployment, initial);
    },
    saved: () => store.get(deployment.id),
  };
}

for (const result of ["accepted", "absent", "missing_cursor", "repeated_cursor", "invalid_list"] as const) {
  test(`Render environment recovery completes pagination before a write: ${result}`, async () => {
    let pages = 0;
    let posts = 0;
    const f = fixture(({ method, path, query }, environment) => {
      if (method === "POST") {
        assert.equal(path, "/environments");
        assert.equal(pages, 2);
        posts++;
        return environment;
      }
      pages++;
      if (result === "invalid_list") return null;
      if (!query.has("cursor") || result === "repeated_cursor")
        return Array.from({ length: 100 }, (_, i) => ({
          environment: { ...environment, id: `env-${i}`, name: `other-${i}` },
          ...(result === "missing_cursor" ? {} : { cursor: `cursor-${i}` }),
        }));
      assert.equal(query.get("cursor"), "cursor-99");
      return result === "accepted" ? [{ environment }] : [];
    });
    if (result === "accepted" || result === "absent") {
      const record = await f.ensure();
      assert.equal(record.environmentId, f.environment.id);
      assert.equal(pages, result === "absent" ? 4 : 2);
      assert.equal(posts, result === "absent" ? 1 : 0);
    } else {
      await assert.rejects(f.ensure(), /pagination did not advance|invalid environment list/);
      assert.deepEqual(await f.saved(), f.initial);
      assert.equal(posts, 0);
    }
  });
}

test("Render environment recovery adopts the environment when its create is rejected as a duplicate", async () => {
  let lists = 0;
  let posts = 0;
  const f = fixture(({ method, path }, environment) => {
    if (method === "POST") {
      posts++;
      throw new RenderApiError(method, path, 409);
    }
    lists++;
    return lists === 1 ? [] : [{ environment }];
  });
  const record = await f.ensure();
  assert.equal(record.environmentId, f.environment.id);
  assert.equal(posts, 1);
  assert.equal(lists, 2);
  assert.deepEqual(await f.saved(), record);
});
