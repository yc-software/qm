import type { AuditLog } from "../audit/audit-log.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import { canonicalPerson, personIds, samePerson } from "../directory/person.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { parseScopeId, scopeId, type ScopeId } from "../types.ts";
import type { AgentAvatar, AgentDecision, AgentOwner, AgentStore, NamedAgent } from "./agent-store.ts";

export class AgentLocked extends Error {
  readonly code = "agent_locked";
}

interface ChannelAgent {
  agent: NamedAgent;
  orphaned: boolean;
}

interface AgentActor {
  id: string;
  live: boolean;
}

export interface AgentPrompt {
  displayName: string;
  line: string;
}

export interface AgentView {
  id: string;
  handle: string;
  displayName: string;
  title: string;
  avatar: AgentAvatar;
  channelId: string;
  channelName: string;
  owners: string[];
  orphaned: boolean;
}

export interface AgentCreateInput {
  channel: string;
  handle: string;
  displayName: string;
  title: string;
  avatar: AgentAvatar;
  owners?: string[];
}

export interface AgentEditInput {
  agent: string;
  handle?: string;
  displayName?: string;
  title?: string;
  avatar?: AgentAvatar;
  addOwners?: string[];
  removeOwners?: string[];
}

type AgentRefusal = { ok: false; code: "bad_request" | "forbidden" | "not_found" | "conflict"; message: string };
export type AgentOutcome<T> = ({ ok: true } & T) | AgentRefusal;

export interface NamedAgents {
  channelAgent(channelId: string): Promise<ChannelAgent | undefined>;
  assertMayInstruct(scope: ScopeId, actor: AgentActor): Promise<void>;
  promptFor(scope: ScopeId): Promise<AgentPrompt | undefined>;
  toolOffered(actor: AgentActor, scope: ScopeId): Promise<boolean>;
  create(actor: AgentActor, input: AgentCreateInput): Promise<AgentOutcome<{ agent: AgentView }>>;
  edit(actor: AgentActor, input: AgentEditInput): Promise<AgentOutcome<{ agent: AgentView }>>;
  archive(actor: AgentActor, agent: string): Promise<AgentOutcome<{ agent: AgentView }>>;
  list(actor: AgentActor): Promise<AgentView[]>;
  lastActiveOwnerOf(isThem: (principalId: string) => Promise<boolean>): Promise<NamedAgent[]>;
}

export interface NamedAgentsDeps {
  store: AgentStore;
  featureFlags: Pick<FeatureFlagStore, "enabled">;
  identity: Pick<IdentityService, "classify" | "isInternal">;
  directory: Pick<
    DirectoryStore,
    "get" | "list" | "resolve" | "resolveChannel" | "channelMembership" | "channelPrivacy"
  >;
  isOrgAdmin: (principalId: string) => Promise<boolean>;
  auditLog: AuditLog;
  botNames: () => Promise<string[]>;
  now?: () => number;
}

const HANDLE = /^[a-z0-9][a-z0-9._-]*$/;
const EMOJI_SHORTCODE = /^:[^\s:]+:$/;
const nameList = new Intl.ListFormat("en", { type: "conjunction" });

const refuse = (code: AgentRefusal["code"], message: string): AgentRefusal => ({ ok: false, code, message });

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function cleanHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function avatarProblem(avatar: AgentAvatar): string | undefined {
  if (avatar.kind === "emoji")
    return EMOJI_SHORTCODE.test(avatar.value) ? undefined : 'an emoji avatar is a Slack shortcode like ":art:"';
  let url: URL;
  try {
    url = new URL(avatar.value);
  } catch {
    return "a picture avatar needs a public https URL";
  }
  return url.protocol === "https:" && !url.username && !url.password
    ? undefined
    : "a picture avatar needs a public https URL";
}

export function createNamedAgents(deps: NamedAgentsDeps): NamedAgents {
  const now = deps.now ?? Date.now;
  const isActive = (principalId: string) => deps.identity.isInternal(deps.identity.classify(principalId));
  const isOwner = (agent: NamedAgent, principalId: string) =>
    agent.owners.some((owner) => samePerson(owner.principalId, principalId));
  const orphaned = (agent: NamedAgent) => !agent.owners.some((owner) => isActive(owner.principalId));
  const liveActiveOwner = (agent: NamedAgent, actor: AgentActor) =>
    actor.live && isActive(actor.id) && isOwner(agent, actor.id);

  async function displayNameOf(principalId: string): Promise<string> {
    for (const id of new Set([principalId, ...personIds(principalId)])) {
      const member = await deps.directory.get(id);
      if (member) return member.displayName;
    }
    return principalId;
  }

  async function view(agent: NamedAgent): Promise<AgentView> {
    return {
      id: agent.id,
      handle: agent.handle,
      displayName: agent.displayName,
      title: agent.title,
      avatar: agent.avatar,
      channelId: agent.channelId,
      channelName: agent.channel.channelName,
      owners: await Promise.all(agent.owners.map((owner) => displayNameOf(owner.principalId))),
      orphaned: orphaned(agent),
    };
  }

  function audit(actor: AgentActor, action: string, agent: NamedAgent, detail?: string): void {
    deps.auditLog.record({
      at: now(),
      principalId: actor.id,
      action,
      resource: agent.id,
      scopeLabel: scopeId("channel", agent.channelId),
      ...(detail ? { detail } : {}),
    });
  }

  async function channelAgent(channelId: string): Promise<ChannelAgent | undefined> {
    if (!(await deps.featureFlags.enabled("named_agents", scopeId("channel", channelId)))) return undefined;
    const agent = await deps.store.activeInChannel(channelId);
    return agent ? { agent, orphaned: orphaned(agent) } : undefined;
  }

  async function governing(scope: ScopeId): Promise<ChannelAgent | undefined> {
    const { kind, ref } = parseScopeId(scope);
    return kind === "channel" && ref ? channelAgent(ref) : undefined;
  }

  async function nameProblem(handle: string, displayName: string): Promise<string | undefined> {
    if (!HANDLE.test(handle))
      return "a handle is lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit";
    if (!displayName) return "a display name is required";
    const taken = new Set([handle.toLowerCase(), displayName.toLowerCase()]);
    if ((await deps.botNames()).some((name) => taken.has(name.toLowerCase())))
      return `${displayName} would take this assistant's own name`;
    for (const member of await deps.directory.list()) {
      const theirs = [member.displayName, member.slackId, member.principalId, member.principalId.split("@")[0]];
      if (theirs.some((name) => name && taken.has(name.toLowerCase())))
        return `${displayName} (@${handle}) matches ${member.displayName} in the directory; an agent can't take a person's name`;
    }
    return undefined;
  }

  async function resolvePeople(queries: readonly string[]): Promise<{ ids: string[] } | AgentRefusal> {
    const ids: string[] = [];
    for (const query of queries) {
      const found = await deps.directory.resolve(query);
      if (found.kind === "none") return refuse("not_found", `no teammate matches "${query}"`);
      if (found.kind === "ambiguous")
        return refuse(
          "bad_request",
          `"${query}" matches ${nameList.format(found.candidates.map((c) => c.displayName))}; name one`,
        );
      if (found.member.type !== "internal" || !isActive(found.member.principalId))
        return refuse("bad_request", `${found.member.displayName} isn't an active member of the organization`);
      ids.push(canonicalPerson(found.member.principalId));
    }
    return { ids };
  }

  async function findActive(ref: string): Promise<NamedAgent | undefined> {
    return (await deps.store.list()).find(
      (agent) => agent.state === "active" && (agent.id === ref.trim() || agent.handle === cleanHandle(ref)),
    );
  }

  function conflictMessage(conflict: "channel" | "name", other: NamedAgent): AgentRefusal {
    return refuse(
      "conflict",
      conflict === "channel"
        ? `#${other.channel.channelName} already has ${other.displayName}; archive it first`
        : `${other.displayName} (@${other.handle}) already uses that name`,
    );
  }

  return {
    channelAgent,

    async assertMayInstruct(scope, actor) {
      const governed = await governing(scope);
      if (!governed || liveActiveOwner(governed.agent, actor)) return;
      const { agent } = governed;
      audit(actor, "agent_lock_refused", agent);
      const channel = `#${agent.channel.channelName}`;
      const activeOwner = agent.owners.find((owner) => isActive(owner.principalId));
      throw new AgentLocked(
        activeOwner
          ? `${channel} belongs to ${agent.displayName}. Only ${agent.displayName}'s owners and org admins can change its instructions, standing orders or skills; ask ${await displayNameOf(activeOwner.principalId)}.`
          : `${channel} belongs to ${agent.displayName}, who has no active owner. Only an org admin can change its instructions, standing orders or skills, or name a new owner.`,
      );
    },

    async promptFor(scope) {
      const governed = await governing(scope);
      if (!governed || governed.orphaned) return undefined;
      const { agent } = governed;
      const owners = await Promise.all(
        agent.owners.filter((owner) => isActive(owner.principalId)).map((owner) => displayNameOf(owner.principalId)),
      );
      return {
        displayName: agent.displayName,
        line: `You are ${agent.displayName}, ${agent.title}, in #${agent.channel.channelName}. ${owners.length === 1 ? "Your owner is" : "Your owners are"} ${nameList.format(owners)}. Only your owners and org admins can change your instructions or skills.`,
      };
    },

    async toolOffered(actor, scope) {
      const { kind, ref } = parseScopeId(scope);
      return (
        actor.live &&
        kind === "personal" &&
        samePerson(ref, actor.id) &&
        (await deps.featureFlags.enabled("named_agents", scope))
      );
    },

    async create(actor, input) {
      const handle = cleanHandle(input.handle);
      const displayName = cleanText(input.displayName);
      const title = cleanText(input.title);
      if (!title) return refuse("bad_request", "a title is required");
      const badAvatar = avatarProblem(input.avatar);
      if (badAvatar) return refuse("bad_request", badAvatar);
      const found = await deps.directory.resolveChannel(input.channel);
      if (found.kind === "none") return refuse("not_found", `no channel matches "${input.channel}"`);
      if (found.kind === "ambiguous")
        return refuse(
          "bad_request",
          `"${input.channel}" matches ${nameList.format(found.candidates.map((c) => `#${c.name}`))}; name one`,
        );
      const { channel } = found;
      if (!isActive(actor.id) || (await deps.directory.channelMembership(channel.channelId, actor.id)) !== true)
        return refuse("forbidden", `only a member of #${channel.name} can give it an agent`);
      const badName = await nameProblem(handle, displayName);
      if (badName) return refuse("bad_request", badName);
      const people = await resolvePeople(input.owners ?? []);
      if ("ok" in people) return people;
      const creator = canonicalPerson(actor.id);
      const at = now();
      const owners: AgentOwner[] = [];
      for (const principalId of [creator, ...people.ids])
        if (!owners.some((owner) => samePerson(owner.principalId, principalId)))
          owners.push({ principalId, addedBy: creator, addedAt: at });
      const created = await deps.store.create({
        handle,
        displayName,
        title,
        avatar: input.avatar,
        owners,
        channelId: channel.channelId,
        channel: { channelId: channel.channelId, channelName: channel.name, boundBy: creator, boundAt: at },
        createdBy: creator,
      });
      if ("conflict" in created) return conflictMessage(created.conflict, created.with);
      audit(actor, "agent_create", created);
      return { ok: true, agent: await view(created) };
    },

    async edit(actor, input) {
      const agent = await findActive(input.agent);
      if (!agent) return refuse("not_found", `no active agent "${input.agent}"`);
      const handle = input.handle === undefined ? agent.handle : cleanHandle(input.handle);
      const displayName = input.displayName === undefined ? agent.displayName : cleanText(input.displayName);
      const title = input.title === undefined ? agent.title : cleanText(input.title);
      if (!title) return refuse("bad_request", "a title is required");
      const avatar = input.avatar ?? agent.avatar;
      const badAvatar = avatarProblem(avatar);
      if (badAvatar) return refuse("bad_request", badAvatar);
      const renamed = handle !== agent.handle || displayName !== agent.displayName;
      const badName = renamed ? await nameProblem(handle, displayName) : undefined;
      if (badName) return refuse("bad_request", badName);
      const added = await resolvePeople(input.addOwners ?? []);
      if ("ok" in added) return added;
      const removals = await Promise.all(
        (input.removeOwners ?? []).map(async (query) => {
          const found = await deps.directory.resolve(query);
          return { query, principalId: found.kind === "one" ? found.member.principalId : undefined };
        }),
      );
      const detailsChange = renamed || title !== agent.title || JSON.stringify(avatar) !== JSON.stringify(agent.avatar);
      const onlyAddsOwners = !detailsChange && !removals.length;
      if (onlyAddsOwners && !added.ids.length) return refuse("bad_request", "nothing to change");
      const admin = actor.live && (await deps.isOrgAdmin(actor.id));
      const editor = canonicalPerson(actor.id);
      const at = now();
      const outcome = await deps.store.update(
        agent.id,
        (current): AgentDecision<{ added: AgentOwner[]; removed: AgentOwner[] }, AgentRefusal> => {
          if (current.state !== "active") return { refused: refuse("not_found", `no active agent "${input.agent}"`) };
          if (!liveActiveOwner(current, actor) && !(admin && orphaned(current) && onlyAddsOwners))
            return {
              refused: refuse(
                "forbidden",
                `only ${current.displayName}'s active owners can change it; an org admin can add an owner when it has none`,
              ),
            };
          const removed: AgentOwner[] = [];
          for (const { query, principalId } of removals) {
            const matches = current.owners.filter(
              (owner) => samePerson(owner.principalId, query) || samePerson(owner.principalId, principalId),
            );
            if (!matches.length)
              return { refused: refuse("bad_request", `${query} isn't an owner of ${current.displayName}`) };
            removed.push(...matches);
          }
          const kept = current.owners.filter((owner) => !removed.includes(owner));
          const addedOwners: AgentOwner[] = [];
          for (const principalId of added.ids)
            if (![...kept, ...addedOwners].some((owner) => samePerson(owner.principalId, principalId)))
              addedOwners.push({ principalId, addedBy: editor, addedAt: at });
          const owners = [...kept, ...addedOwners];
          if (!owners.some((owner) => isActive(owner.principalId)))
            return {
              refused: refuse(
                "forbidden",
                `that would leave ${current.displayName} with no active owner; add another owner first`,
              ),
            };
          return {
            next: { ...current, handle, displayName, title, avatar, owners },
            result: { added: addedOwners, removed },
          };
        },
      );
      if (!outcome) return refuse("not_found", `no active agent "${input.agent}"`);
      if ("conflict" in outcome) return conflictMessage(outcome.conflict, outcome.with);
      if ("refused" in outcome) return outcome.refused;
      const { added: addedOwners, removed } = outcome.result;
      if (detailsChange) audit(actor, "agent_update", outcome.agent);
      for (const owner of addedOwners) audit(actor, "agent_owner_add", outcome.agent, owner.principalId);
      for (const owner of removed) audit(actor, "agent_owner_remove", outcome.agent, owner.principalId);
      return { ok: true, agent: await view(outcome.agent) };
    },

    async archive(actor, ref) {
      const agent = await findActive(ref);
      if (!agent) return refuse("not_found", `no active agent "${ref}"`);
      const admin = actor.live && (await deps.isOrgAdmin(actor.id));
      const outcome = await deps.store.update(agent.id, (current): AgentDecision<undefined, AgentRefusal> => {
        if (current.state !== "active") return { refused: refuse("not_found", `no active agent "${ref}"`) };
        if (!liveActiveOwner(current, actor) && !(admin && orphaned(current)))
          return {
            refused: refuse(
              "forbidden",
              `only ${current.displayName}'s active owners can archive it; an org admin can when it has none`,
            ),
          };
        return { next: { ...current, state: "archived" }, result: undefined };
      });
      if (!outcome) return refuse("not_found", `no active agent "${ref}"`);
      if ("conflict" in outcome) return conflictMessage(outcome.conflict, outcome.with);
      if ("refused" in outcome) return outcome.refused;
      audit(actor, "agent_archive", outcome.agent);
      return { ok: true, agent: await view(outcome.agent) };
    },

    async list(actor) {
      const admin = actor.live && (await deps.isOrgAdmin(actor.id));
      const shown: AgentView[] = [];
      for (const agent of await deps.store.list()) {
        if (agent.state !== "active") continue;
        const member = (await deps.directory.channelMembership(agent.channelId, actor.id)) === true;
        const reachable =
          member ||
          ((isOwner(agent, actor.id) || (admin && orphaned(agent))) &&
            (await deps.directory.channelPrivacy(agent.channelId)) === false);
        if (reachable) shown.push(await view(agent));
      }
      return shown;
    },

    async lastActiveOwnerOf(isThem) {
      const agents: NamedAgent[] = [];
      for (const agent of await deps.store.list()) {
        if (agent.state !== "active") continue;
        let theirs = false;
        let othersActive = false;
        for (const owner of agent.owners) {
          if (await isThem(owner.principalId)) theirs = true;
          else if (isActive(owner.principalId)) othersActive = true;
        }
        if (theirs && !othersActive) agents.push(agent);
      }
      return agents;
    },
  };
}
