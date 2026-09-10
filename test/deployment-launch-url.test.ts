import test from "node:test";
import assert from "node:assert/strict";
import { deploymentLaunchUrl } from "../src/deploy/deploy-store.ts";

test("viewer links are authenticated launch paths, independent of provider transport metadata", () => {
  const deployment = {
    id: "immutable-id",
    name: "my-app",
    endpoint: { host: "provider.example", port: 443, publicUrl: "https://provider.example/" },
  };
  assert.equal(deploymentLaunchUrl(deployment, "https://qm.example/"), "https://qm.example/d/my-app/");
  assert.equal(deploymentLaunchUrl({ id: "immutable-id" }), "/d/immutable-id/");
  assert.equal(deploymentLaunchUrl({ id: "path/escape" }), "/d/path%2Fescape/");
});
