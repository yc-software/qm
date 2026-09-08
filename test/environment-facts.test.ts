import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderComputerBlock,
  renderResidentLoginsBlock,
  renderConnectedAppsBlock,
} from "../src/core/environment-facts.ts";
import { RESIDENT_AUTH_CONNECTORS, type ScopeLivenessRecord } from "../src/credentials/resident-auth.ts";
import type { ConnectorStatusRecord } from "../src/credentials/connector-status.ts";
import type { AgentComputerSpec } from "../src/sandbox/sandbox.ts";

const FULL_SPEC: AgentComputerSpec = {
  os: "Debian 12 (bookworm), glibc",
  runtimes: ["Node 24", "Python 3 (venv on PATH)"],
  tools: ["git", "jq", "aws (CLI v2)"],
  notInstalled: ["gh", "gcloud"],
  cpus: 4,
  memoryMb: 8192,
  diskGb: 3,
  homeDir: "/root",
  workdir: "/root/workspace",
};

test("computer block: absent spec renders nothing (graceful for doubles)", () => {
  assert.equal(renderComputerBlock(undefined, { hasGlobal: false, teamCount: 0 }), "");
});

test("computer block: renders OS/size/runtimes/tools and the not-installed list", () => {
  const out = renderComputerBlock(FULL_SPEC, { hasGlobal: true, teamCount: 2 });
  assert.match(out, /## This machine/);
  assert.match(out, /Debian 12/);
  assert.match(out, /4 vCPU/);
  assert.match(out, /8 GB RAM/);
  assert.match(out, /3 GB disk/);
  assert.match(out, /Node 24/);
  assert.match(out, /Installed CLIs:.*aws/);
  assert.match(out, /NOT installed.*gh/);
  assert.match(out, /`\/root\/workspace` \(read-write\) and persists across turns/);
  assert.match(out, /publish ships files in your workspace/);
  assert.match(out, /\$HOME` \(`\/root`\) also persists/);
  assert.match(out, /`\.\/global` \(read-only\)/);
  assert.match(out, /team-\*.*2 mounted/);
});

test("computer block: omits global/team lines when not mounted (channel scope)", () => {
  const out = renderComputerBlock(FULL_SPEC, { hasGlobal: false, teamCount: 0 });
  assert.doesNotMatch(out, /global/);
  assert.doesNotMatch(out, /team-/);
});

test("computer block: partial spec omits the fields it lacks (no empty fragments)", () => {
  const out = renderComputerBlock({ os: "Debian 12", tools: ["git"] }, { hasGlobal: false, teamCount: 0 });
  assert.match(out, /## This machine/);
  assert.match(out, /Debian 12\./);
  assert.match(out, /Installed CLIs: git\./);
  assert.doesNotMatch(out, /vCPU/);
  assert.doesNotMatch(out, /Runtimes:/);
  assert.doesNotMatch(out, /NOT installed/);
});

test("logins block: null record renders nothing (first turn, no probe yet)", () => {
  assert.equal(renderResidentLoginsBlock(null, RESIDENT_AUTH_CONNECTORS), "");
});

test("logins block: all-absent record renders nothing (no tools present)", () => {
  const record: ScopeLivenessRecord = {
    scopeId: "personal:U1",
    checkedAt: 1,
    connectors: Object.fromEntries(RESIDENT_AUTH_CONNECTORS.map((c) => [c.id, "absent" as const])),
  };
  assert.equal(renderResidentLoginsBlock(record, RESIDENT_AUTH_CONNECTORS), "");
});

test("logins block: shows active with a check, inactive with its exact reauth command, omits absent", () => {
  const record: ScopeLivenessRecord = {
    scopeId: "personal:U1",
    checkedAt: 1,
    connectors: { gh: "active", glab: "inactive", gcloud: "absent" },
  };
  const out = renderResidentLoginsBlock(record, RESIDENT_AUTH_CONNECTORS);
  assert.match(out, /## Your logins/);
  assert.match(out, /GitHub — ✓ signed in/);
  assert.match(out, /GitLab — ✗ not signed in.*`glab auth login`/);
  assert.doesNotMatch(out, /Google Cloud/);
  assert.doesNotMatch(out, /AWS/);
});

test("connected-apps block: lists only admin-configured providers and the exact connection URL", () => {
  const url = "https://qm.example/keychain";
  const unavailable = renderConnectedAppsBlock(null, [], url);
  assert.match(unavailable, /No native OAuth apps are enabled by the admin/);
  assert.match(unavailable, /Do not mint native OAuth consent links for unconfigured providers/);

  const none: ConnectorStatusRecord = { principalId: "U1", checkedAt: 1, providers: { google: { connected: false } } };
  const available = renderConnectedAppsBlock(none, ["google"], url);
  assert.match(available, /Available to connect: Google/);
  assert.match(available, /https:\/\/qm\.example\/keychain/);
  assert.doesNotMatch(available, /Slack|Notion/);

  const some: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: 1,
    providers: { google: { connected: true }, slack: { connected: true }, notion: { connected: false } },
  };
  const out = renderConnectedAppsBlock(some, ["google"], url);
  assert.match(out, /## Connected apps/);
  assert.match(out, /Connected: Google/);
  assert.doesNotMatch(out, /Slack|Notion/);
});

test("connected-apps block: reconnect-needed apps are named separately", () => {
  const rec: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: 1,
    providers: {
      google: { connected: true },
      github: {
        connected: true,
        expiresAt: 100,
        needsReconnect: true,
        refreshFailedAt: 200,
        refreshError: "revoked by provider",
      },
    },
  };
  const out = renderConnectedAppsBlock(rec, ["google", "github"]);
  assert.match(out, /Connected: Google/);
  assert.match(out, /Needs reconnect: GitHub \(refresh failed: revoked by provider\)/);
  assert.match(out, /Do not use these native credentials until reconnected/);
});

test("connected-apps block: org setup is admin-only and separate from account linking", () => {
  const url = "https://qm.example/admin/connectors";
  const admin = renderConnectedAppsBlock(null, [], undefined, { isOrgAdmin: true, url });
  assert.match(admin, /offer to walk.*OAuth app setup/);
  assert.match(admin, /does not link their personal account/);
  assert.match(admin, /Do not mint native consent links until/);
  assert.match(admin, /https:\/\/qm\.example\/admin\/connectors/);
  const noUrl = renderConnectedAppsBlock(null, [], undefined, { isOrgAdmin: true });
  assert.match(noUrl, /offer to walk/);
  assert.doesNotMatch(noUrl, /OAuth app setup page:|undefined/);
  const member = renderConnectedAppsBlock(null, [], undefined, { isOrgAdmin: false, url });
  assert.match(member, /an org admin needs to configure/);
  assert.doesNotMatch(member, /offer to walk|OAuth app setup page:/);
  const configured = renderConnectedAppsBlock(null, ["google"], undefined, { isOrgAdmin: true, url });
  assert.match(configured, /Available to connect: Google/);
  assert.doesNotMatch(configured, /offer to walk|OAuth app setup page:/);
});

test("native OAuth availability never acts as a global capability allowlist", () => {
  const records: Array<ConnectorStatusRecord | null> = [
    null,
    { principalId: "U1", checkedAt: 1, providers: { google: { connected: true } } },
    { principalId: "U1", checkedAt: 1, providers: { google: { connected: true, needsReconnect: true } } },
  ];
  for (const record of records) {
    for (const providers of [[], ["google"]]) {
      const out = renderConnectedAppsBlock(record, providers, undefined, { isOrgAdmin: true });
      assert.match(out, /native OAuth connections only/);
      assert.match(out, /other authorized sources/);
      assert.match(out, /account.*permissions/);
      assert.doesNotMatch(out, /Do not suggest or offer any app connection|Do not use these apps until/);
    }
  }
});
