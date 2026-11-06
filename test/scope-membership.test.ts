import test from "node:test";
import assert from "node:assert/strict";
import {
  createCanManageScope,
  createCanReadScope,
  createCanWriteScope,
  createIsCurrentSharedScopeMember,
  createManagesArtifactHome,
  createMembershipControlsScope,
} from "../src/resolution/scope-membership.ts";
import { scopeActor, scopeId, type ScopeId } from "../src/types.ts";

const channels: Record<string, { private?: boolean; members: string[]; known: boolean }> = {
  pub: { private: false, members: ["alice@x.com"], known: true },
  priv: { private: true, members: ["alice@x.com"], known: true },
  unknown: { members: ["alice@x.com"], known: false },
};
const groups: Record<string, { members: string[]; known: boolean }> = {
  g1: { members: ["U_ALICE"], known: true },
  gunknown: { members: [], known: false },
};

const directory = {
  async get(id: string) {
    return id === "alice@x.com" ? { principalId: "alice@x.com", slackId: "U_ALICE" } : null;
  },
  async channelMember(channelId: string, principalId: string) {
    return channels[channelId]?.members.includes(principalId) ?? false;
  },
  async channelMembership(channelId: string, principalId: string) {
    const channel = channels[channelId];
    if (!channel?.known) return undefined;
    const member = channel.members.includes(principalId);
    return member || channel.private ? member : undefined;
  },
  async channelPrivacy(channelId: string) {
    const channel = channels[channelId];
    return channel?.known ? channel.private === true : undefined;
  },
  async groupMember(groupId: string, principalId: string) {
    return groups[groupId]?.members.includes(principalId) ?? false;
  },
  async groupMembership(groupId: string, principalId: string) {
    const group = groups[groupId];
    if (!group?.known) return undefined;
    return group.members.includes(principalId);
  },
};

const deps = {
  directory,
  identity: {
    classify: (id: string) => {
      if (id.startsWith("anon")) return {};
      return { type: id.startsWith("ext") ? "external" : "internal" };
    },
  },
  teams: { isMember: async (id: string, team: string) => id === "alice@x.com" && team === "eng" },
  sessions: {
    participantScopes: async (id: string) =>
      id === "bob@x.com" ? [{ scopeId: scopeId("channel", "unknown") }, { scopeId: scopeId("group", "gunknown") }] : [],
  },
  managedGroups: {
    recognizes: (ref: string) => ref === "project-1",
    membership: async (ref: string, id: string) => ref === "project-1" && id === "alice@x.com",
    members: async () => ["alice@x.com"],
  },
  personas: {
    role: async (id: string, persona: string) =>
      persona === "p1"
        ? (({ "alice@x.com": "owner", "bob@x.com": "write", "carol@x.com": "read", "ext@y.com": "write" } as const)[
            id as "alice@x.com"
          ] ?? null)
        : null,
  },
};

const principals = [
  "alice@x.com",
  "U_ALICE",
  "bob@x.com",
  "carol@x.com",
  "ext@y.com",
  "anon@x.com",
  scopeActor(scopeId("channel", "priv")),
  "",
];
const scopes: ScopeId[] = [
  scopeId("org", "acme"),
  scopeId("personal", "alice@x.com"),
  scopeId("personal", "ext@y.com"),
  scopeId("team", "eng"),
  scopeId("channel", "pub"),
  scopeId("channel", "priv"),
  scopeId("channel", "unknown"),
  scopeId("channel", "missing"),
  scopeId("group", "g1"),
  scopeId("group", "gunknown"),
  scopeId("group", "project-1"),
  scopeId("persona", "p1"),
  scopeId("persona", "p2"),
];

async function table() {
  const canRead = createCanReadScope(deps);
  const canWrite = createCanWriteScope(deps);
  const canManage = createCanManageScope(deps);
  const isMember = createIsCurrentSharedScopeMember(deps);
  const manages = createManagesArtifactHome(deps);
  const controls = createMembershipControlsScope(deps);
  const rows: string[] = [];
  for (const scope of scopes) {
    rows.push(`${scope} controls=${await controls(scope)}`);
    for (const principal of principals) {
      const flags = [
        (await canRead(principal, scope)) ? "r" : "-",
        (await canWrite(principal, scope)) ? "w" : "-",
        (await canManage(principal, scope)) ? "m" : "-",
        (await isMember(principal, scope)) ? "c" : "-",
        (await manages(scope, "alice@x.com", principal)) ? "a" : "-",
        (await manages(scope, principal, principal)) ? "o" : "-",
      ].join("");
      rows.push(`${scope} ${principal || "(none)"} ${flags}`);
    }
  }
  return rows;
}

test("scope membership predicates agree with the directory, sessions, teams and managed groups", async () => {
  assert.deepEqual(await table(), EXPECTED);
});

const EXPECTED = [
  "org:acme controls=false",
  "org:acme alice@x.com rw----",
  "org:acme U_ALICE rw----",
  "org:acme bob@x.com rw----",
  "org:acme carol@x.com rw----",
  "org:acme ext@y.com ------",
  "org:acme anon@x.com -w----",
  "org:acme system:channel:priv rw----",
  "org:acme (none) ------",
  "personal:alice@x.com controls=false",
  "personal:alice@x.com alice@x.com rwm-ao",
  "personal:alice@x.com U_ALICE -----o",
  "personal:alice@x.com bob@x.com -----o",
  "personal:alice@x.com carol@x.com -----o",
  "personal:alice@x.com ext@y.com ------",
  "personal:alice@x.com anon@x.com -----o",
  "personal:alice@x.com system:channel:priv -----o",
  "personal:alice@x.com (none) ------",
  "personal:ext@y.com controls=false",
  "personal:ext@y.com alice@x.com ----ao",
  "personal:ext@y.com U_ALICE -----o",
  "personal:ext@y.com bob@x.com -----o",
  "personal:ext@y.com carol@x.com -----o",
  "personal:ext@y.com ext@y.com r-----",
  "personal:ext@y.com anon@x.com -----o",
  "personal:ext@y.com system:channel:priv -----o",
  "personal:ext@y.com (none) ------",
  "team:eng controls=false",
  "team:eng alice@x.com rw--ao",
  "team:eng U_ALICE ------",
  "team:eng bob@x.com ------",
  "team:eng carol@x.com ------",
  "team:eng ext@y.com ------",
  "team:eng anon@x.com ------",
  "team:eng system:channel:priv ------",
  "team:eng (none) ------",
  "channel:pub controls=false",
  "channel:pub alice@x.com rw-cao",
  "channel:pub U_ALICE r----o",
  "channel:pub bob@x.com r----o",
  "channel:pub carol@x.com r----o",
  "channel:pub ext@y.com ------",
  "channel:pub anon@x.com r----o",
  "channel:pub system:channel:priv r----o",
  "channel:pub (none) ------",
  "channel:priv controls=true",
  "channel:priv alice@x.com rwmcao",
  "channel:priv U_ALICE ------",
  "channel:priv bob@x.com ------",
  "channel:priv carol@x.com ------",
  "channel:priv ext@y.com ------",
  "channel:priv anon@x.com ------",
  "channel:priv system:channel:priv rwmcao",
  "channel:priv (none) ------",
  "channel:unknown controls=false",
  "channel:unknown alice@x.com -w-c--",
  "channel:unknown U_ALICE ------",
  "channel:unknown bob@x.com r-----",
  "channel:unknown carol@x.com ------",
  "channel:unknown ext@y.com ------",
  "channel:unknown anon@x.com ------",
  "channel:unknown system:channel:priv ------",
  "channel:unknown (none) ------",
  "channel:missing controls=false",
  "channel:missing alice@x.com ------",
  "channel:missing U_ALICE ------",
  "channel:missing bob@x.com ------",
  "channel:missing carol@x.com ------",
  "channel:missing ext@y.com ------",
  "channel:missing anon@x.com ------",
  "channel:missing system:channel:priv ------",
  "channel:missing (none) ------",
  "group:g1 controls=true",
  "group:g1 alice@x.com -wmcao",
  "group:g1 U_ALICE rwmcao",
  "group:g1 bob@x.com ------",
  "group:g1 carol@x.com ------",
  "group:g1 ext@y.com ------",
  "group:g1 anon@x.com ------",
  "group:g1 system:channel:priv ------",
  "group:g1 (none) ------",
  "group:gunknown controls=true",
  "group:gunknown alice@x.com ------",
  "group:gunknown U_ALICE ------",
  "group:gunknown bob@x.com r-----",
  "group:gunknown carol@x.com ------",
  "group:gunknown ext@y.com ------",
  "group:gunknown anon@x.com ------",
  "group:gunknown system:channel:priv ------",
  "group:gunknown (none) ------",
  "group:project-1 controls=true",
  "group:project-1 alice@x.com rwmcao",
  "group:project-1 U_ALICE ------",
  "group:project-1 bob@x.com ------",
  "group:project-1 carol@x.com ------",
  "group:project-1 ext@y.com ------",
  "group:project-1 anon@x.com ------",
  "group:project-1 system:channel:priv ------",
  "group:project-1 (none) ------",
  "persona:p1 controls=false",
  "persona:p1 alice@x.com rwm-ao",
  "persona:p1 U_ALICE ------",
  "persona:p1 bob@x.com rwm-ao",
  "persona:p1 carol@x.com r-----",
  "persona:p1 ext@y.com r-----",
  "persona:p1 anon@x.com ------",
  "persona:p1 system:channel:priv ------",
  "persona:p1 (none) ------",
  "persona:p2 controls=false",
  "persona:p2 alice@x.com ------",
  "persona:p2 U_ALICE ------",
  "persona:p2 bob@x.com ------",
  "persona:p2 carol@x.com ------",
  "persona:p2 ext@y.com ------",
  "persona:p2 anon@x.com ------",
  "persona:p2 system:channel:priv ------",
  "persona:p2 (none) ------",
];
