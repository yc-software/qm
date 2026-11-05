import type { AuditLog } from "../audit/audit-log.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import { canonicalPerson, personIds, samePerson } from "../directory/person.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { swallow } from "../util/errors.ts";
import { parseScopeId, scopeId, type ScopeId } from "../types.ts";
import type { AgentAvatar, AgentDecision, AgentStore, NamedAgent } from "./agent-store.ts";

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
  avatar?: AgentAvatar;
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
  governedAgents(): Promise<ChannelAgent[]>;
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
  deliveries: Pick<DeliveryStore, "enqueue">;
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

function avatarProblem(avatar: AgentAvatar | undefined): string | undefined {
  if (!avatar) return undefined;
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
    agent.owners.some((owner) => samePerson(owner, principalId));
  const orphaned = (agent: NamedAgent) => !agent.owners.some(isActive);
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
      channelId: agent.channelId,
      channelName: agent.channelName,
      owners: await Promise.all(agent.owners.map(displayNameOf)),
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

  const flagOn = (channelId: string) => deps.featureFlags.enabled("named_agents", scopeId("channel", channelId));

  async function channelAgent(channelId: string): Promise<ChannelAgent | undefined> {
    if (!(await flagOn(channelId))) return undefined;
    const agent = await deps.store.activeInChannel(channelId);
    return agent ? { agent, orphaned: orphaned(agent) } : undefined;
  }

  function activeOwnerNames(agent: NamedAgent): Promise<string[]> {
    return Promise.all(agent.owners.filter(isActive).map(displayNameOf));
  }

  async function announce(agent: NamedAgent, change: "bound" | "archived"): Promise<void> {
    try {
      if (!(await flagOn(agent.channelId))) return;
      const name = agent.displayName;
      const text =
        change === "bound"
          ? `${name} now answers here. Owners: ${nameList.format(await activeOwnerNames(agent))}. Only ${name}'s owners and org admins can change ${name}'s instructions or skills.`
          : `${name} no longer answers here. This channel's instructions and skills are open to its members again.`;
      await deps.deliveries.enqueue({
        destination: { type: "slack", target: agent.channelId, audienceScopeId: scopeId("channel", agent.channelId) },
        text,
        idempotencyKey: `agent-notice:${agent.id}:${agent.updatedAt}`,
      });
    } catch (error) {
      swallow("named agents: channel notice", error);
    }
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
        ? `#${other.channelName} already has ${other.displayName}; archive it first`
        : `${other.displayName} (@${other.handle}) already uses that name`,
    );
  }

  return {
    channelAgent,

    async governedAgents() {
      const active = (await deps.store.list()).filter((agent) => agent.state === "active");
      if (!active.length) return [];
      const flagged = await Promise.all(active.map((agent) => flagOn(agent.channelId)));
      return active.filter((_, i) => flagged[i]).map((agent) => ({ agent, orphaned: orphaned(agent) }));
    },

    async assertMayInstruct(scope, actor) {
      const governed = await governing(scope);
      if (!governed || liveActiveOwner(governed.agent, actor)) return;
      const { agent } = governed;
      audit(actor, "agent_lock_refused", agent);
      const channel = `#${agent.channelName}`;
      const activeOwner = agent.owners.find(isActive);
      throw new AgentLocked(
        activeOwner
          ? `${channel} belongs to ${agent.displayName}. Only ${agent.displayName}'s owners can change its instructions, standing orders or skills here; ask ${await displayNameOf(activeOwner)}. Org admins can change them in the admin console.`
          : `${channel} belongs to ${agent.displayName}, who has no active owner, so its instructions, standing orders and skills can't be changed here. Org admins can change them in the admin console, or name a new owner.`,
      );
    },

    async promptFor(scope) {
      const governed = await governing(scope);
      if (!governed || governed.orphaned) return undefined;
      const { agent } = governed;
      const owners = await activeOwnerNames(agent);
      return {
        displayName: agent.displayName,
        line: `You are ${agent.displayName}, ${agent.title}, in #${agent.channelName}. ${owners.length === 1 ? "Your owner is" : "Your owners are"} ${nameList.format(owners)}. Only your owners can change your instructions or skills from a conversation; org admins use the admin console.`,
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
      const owners: string[] = [];
      for (const principalId of [canonicalPerson(actor.id), ...people.ids])
        if (!owners.some((owner) => samePerson(owner, principalId))) owners.push(principalId);
      const created = await deps.store.create({
        handle,
        displayName,
        title,
        ...(input.avatar ? { avatar: input.avatar } : {}),
        owners,
        channelId: channel.channelId,
        channelName: channel.name,
        createdBy: canonicalPerson(actor.id),
      });
      if ("conflict" in created) return conflictMessage(created.conflict, created.with);
      audit(actor, "agent_create", created);
      await announce(created, "bound");
      return { ok: true, agent: await view(created) };
    },

    async edit(actor, input) {
      const agent = await findActive(input.agent);
      if (!agent) return refuse("not_found", `no active agent "${input.agent}"`);
      const handle = input.handle === undefined ? agent.handle : cleanHandle(input.handle);
      const displayName = input.displayName === undefined ? agent.displayName : cleanText(input.displayName);
      const title = input.title === undefined ? agent.title : cleanText(input.title);
      if (!title) return refuse("bad_request", "a title is required");
      const badAvatar = avatarProblem(input.avatar);
      if (badAvatar) return refuse("bad_request", badAvatar);
      const avatar = input.avatar ?? agent.avatar;
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
      const detailsChange =
        renamed ||
        title !== agent.title ||
        avatar?.kind !== agent.avatar?.kind ||
        avatar?.value !== agent.avatar?.value;
      const onlyAddsOwners = !detailsChange && !removals.length;
      if (onlyAddsOwners && !added.ids.length) return refuse("bad_request", "nothing to change");
      const admin = actor.live && (await deps.isOrgAdmin(actor.id));
      const outcome = await deps.store.update(
        agent.id,
        (current): AgentDecision<{ added: string[]; removed: string[] }, AgentRefusal> => {
          if (current.state !== "active") return { refused: refuse("not_found", `no active agent "${input.agent}"`) };
          if (!liveActiveOwner(current, actor) && !(admin && orphaned(current) && onlyAddsOwners))
            return {
              refused: refuse(
                "forbidden",
                `only ${current.displayName}'s active owners can change it; an org admin can add an owner when it has none`,
              ),
            };
          const removed: string[] = [];
          for (const { query, principalId } of removals) {
            const matches = current.owners.filter(
              (owner) => samePerson(owner, query) || samePerson(owner, principalId),
            );
            if (!matches.length)
              return { refused: refuse("bad_request", `${query} isn't an owner of ${current.displayName}`) };
            removed.push(...matches);
          }
          const kept = current.owners.filter((owner) => !removed.includes(owner));
          const addedOwners: string[] = [];
          for (const principalId of added.ids)
            if (![...kept, ...addedOwners].some((owner) => samePerson(owner, principalId)))
              addedOwners.push(principalId);
          const owners = [...kept, ...addedOwners];
          if (!owners.some(isActive))
            return {
              refused: refuse(
                "forbidden",
                `that would leave ${current.displayName} with no active owner; add another owner first`,
              ),
            };
          return {
            next: {
              ...current,
              handle: input.handle === undefined ? current.handle : handle,
              displayName: input.displayName === undefined ? current.displayName : displayName,
              title: input.title === undefined ? current.title : title,
              ...(input.avatar ? { avatar: input.avatar } : {}),
              owners,
            },
            result: { added: addedOwners, removed },
          };
        },
      );
      if (!outcome) return refuse("not_found", `no active agent "${input.agent}"`);
      if ("conflict" in outcome) return conflictMessage(outcome.conflict, outcome.with);
      if ("refused" in outcome) return outcome.refused;
      if (detailsChange) audit(actor, "agent_update", outcome.agent);
      for (const owner of outcome.result.added) audit(actor, "agent_owner_add", outcome.agent, owner);
      for (const owner of outcome.result.removed) audit(actor, "agent_owner_remove", outcome.agent, owner);
      if (outcome.result.added.length || outcome.result.removed.length) await announce(outcome.agent, "bound");
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
      await announce(outcome.agent, "archived");
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
          if (await isThem(owner)) theirs = true;
          else if (isActive(owner)) othersActive = true;
        }
        if (theirs && !othersActive) agents.push(agent);
      }
      return agents;
    },
  };
}
