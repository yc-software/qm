import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceEgressFloor, audienceDeniedFloor } from "../src/resolution/audience-floor.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { scopeId, type Principal } from "../src/types.ts";

const ORG = scopeId("org", "default-org");

function configWithOrgHosts(hosts: string[]) {
  const config = createMemoryConfigStore("default-org");
  config.setEgress(ORG, { allowedHosts: hosts });
  return config;
}

test("audienceEgressFloor fails closed for an EMPTY audience (no org allowlist leak)", () => {
  const config = configWithOrgHosts(["api.example.com", "shared.acme.test"]);
  assert.deepEqual(audienceEgressFloor([], config, ORG), []);
});

test("audienceEgressFloor for a single principal = that principal's full reach (org ∪ personal)", () => {
  const config = configWithOrgHosts(["org-host.test"]);
  config.setEgress(scopeId("personal", "U1"), { allowedHosts: ["personal-host.test"] });
  const alice: Principal = { id: "U1", type: "internal" };
  const floor = audienceEgressFloor([alice], config, ORG);
  assert.deepEqual([...floor].sort(), ["org-host.test", "personal-host.test"]);
});

test("audienceEgressFloor for several principals = the INTERSECTION of their reaches", () => {
  const config = configWithOrgHosts(["org-host.test"]);
  config.setEgress(scopeId("personal", "U1"), { allowedHosts: ["only-alice.test"] });
  config.setEgress(scopeId("personal", "U2"), { allowedHosts: ["only-bob.test"] });
  const alice: Principal = { id: "U1", type: "internal" };
  const bob: Principal = { id: "U2", type: "internal" };
  assert.deepEqual(audienceEgressFloor([alice, bob], config, ORG), ["org-host.test"]);
});

test("audienceDeniedFloor is the UNION across the audience (a deny by anyone applies to the room)", () => {
  const config = createMemoryConfigStore("default-org");
  config.setEgress(ORG, { allowedHosts: [], deniedHosts: ["org-bad.test"] });
  config.setEgress(scopeId("personal", "U1"), { allowedHosts: [], deniedHosts: ["alice-bad.test"] });
  config.setEgress(scopeId("personal", "U2"), { allowedHosts: [], deniedHosts: ["bob-bad.test"] });
  const alice: Principal = { id: "U1", type: "internal" };
  const bob: Principal = { id: "U2", type: "internal" };
  assert.deepEqual(audienceDeniedFloor([alice, bob], config, ORG).sort(), [
    "alice-bad.test",
    "bob-bad.test",
    "org-bad.test",
  ]);
});

test("audienceDeniedFloor carries the org-floor deny even to a single principal with none of their own", () => {
  const config = createMemoryConfigStore("default-org");
  config.setEgress(ORG, { allowedHosts: [], deniedHosts: ["org-bad.test"] });
  const alice: Principal = { id: "U1", type: "internal" };
  assert.deepEqual(audienceDeniedFloor([alice], config, ORG), ["org-bad.test"]);
});

test("audienceDeniedFloor for an EMPTY audience is empty", () => {
  const config = createMemoryConfigStore("default-org");
  config.setEgress(ORG, { allowedHosts: [], deniedHosts: ["org-bad.test"] });
  assert.deepEqual(audienceDeniedFloor([], config, ORG), []);
});
