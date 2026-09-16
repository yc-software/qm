import type { DurableMap } from "../persistence/durable-map.ts";

export interface BackgroundMember {
  instanceId: string;
  deploymentId: string;
  taskArn: string | null;
  generation: number;
  state: "admitted" | "relinquished" | "drained";
  retired: boolean;
  ready: boolean;
}

export interface BackgroundOwnership {
  enabled: boolean;
  generation: number;
  desiredDeploymentId: string | null;
  lastRequestId: string | null;
  lastRequest: string | null;
  members: BackgroundMember[];
}

export interface BackgroundTransition {
  expectedGeneration: number;
  requestId: string;
  desiredDeploymentId: string | null;
  bootstrapTaskArns?: string[];
}

export class BackgroundOwnershipConflict extends Error {}

export function createBackgroundOwnershipStore(map: DurableMap<BackgroundOwnership>) {
  if (!map.update) throw new Error("Background ownership requires atomic updates");
  const key = "ownership";
  const initial: BackgroundOwnership = {
    enabled: false,
    generation: 0,
    desiredDeploymentId: null,
    lastRequestId: null,
    lastRequest: null,
    members: [],
  };
  const ready = () => map.putIfAbsent(key, structuredClone(initial));
  const update = async (change: (state: BackgroundOwnership) => void): Promise<BackgroundOwnership> => {
    await ready();
    const result = await map.update!(key, (current) => {
      const next = structuredClone(current);
      change(next);
      return next;
    });
    if (!result) throw new Error("Background ownership disappeared");
    return result;
  };
  const memberOf = (state: BackgroundOwnership, instanceId: string): BackgroundMember => {
    const member = state.members.find((entry) => entry.instanceId === instanceId);
    if (!member || member.retired) throw new BackgroundOwnershipConflict("Instance is missing or retired");
    return member;
  };
  const expectGeneration = (state: BackgroundOwnership, expected: number): void => {
    if (!Number.isSafeInteger(expected) || expected < 0 || state.generation !== expected)
      throw new BackgroundOwnershipConflict("Background ownership generation changed");
  };
  return {
    async get(): Promise<BackgroundOwnership> {
      return structuredClone((await map.get(key)) ?? (await ready()));
    },
    register(identity: Pick<BackgroundMember, "instanceId" | "deploymentId" | "taskArn">) {
      return update((state) => {
        if (identity.taskArn && state.members.some((member) => member.taskArn === identity.taskArn && member.retired))
          throw new BackgroundOwnershipConflict("Task has already been retired");
        const previous = state.members.find((member) => member.instanceId === identity.instanceId);
        if (previous) {
          if (
            previous.deploymentId !== identity.deploymentId ||
            previous.taskArn !== identity.taskArn ||
            previous.retired
          )
            throw new BackgroundOwnershipConflict("Instance identity cannot change");
          return;
        }
        state.members.push({
          ...identity,
          generation: state.generation,
          state: "drained",
          retired: false,
          ready: false,
        });
      });
    },
    transition(request: BackgroundTransition) {
      const fingerprint = JSON.stringify([
        "transition",
        request.expectedGeneration,
        request.desiredDeploymentId,
        request.bootstrapTaskArns?.slice().sort() ?? null,
      ]);
      return update((state) => {
        if (state.lastRequestId === request.requestId) {
          if (
            state.lastRequest !== fingerprint ||
            state.generation !== request.expectedGeneration + 1 ||
            state.desiredDeploymentId !== request.desiredDeploymentId
          )
            throw new BackgroundOwnershipConflict("Request identity reused for a different transition");
          return;
        }
        expectGeneration(state, request.expectedGeneration);
        if (!state.enabled) {
          const expected = request.bootstrapTaskArns;
          if (!expected?.length || new Set(expected).size !== expected.length)
            throw new BackgroundOwnershipConflict("Bootstrap requires an exact nonempty task cohort");
          const enrolled = state.members.filter((member) => !member.retired);
          if (
            enrolled.some((member) => !member.taskArn || !expected.includes(member.taskArn)) ||
            expected.some((taskArn) => !enrolled.some((member) => member.taskArn === taskArn))
          )
            throw new BackgroundOwnershipConflict("Bootstrap task cohort does not match enrolled instances");
        } else if (request.bootstrapTaskArns) {
          throw new BackgroundOwnershipConflict("Ownership is already enabled");
        }
        if (
          request.desiredDeploymentId !== null &&
          !state.members.some((member) => !member.retired && member.deploymentId === request.desiredDeploymentId)
        )
          throw new BackgroundOwnershipConflict("Desired deployment has no enrolled instances");
        state.enabled = true;
        state.generation++;
        state.desiredDeploymentId = request.desiredDeploymentId;
        state.lastRequestId = request.requestId;
        state.lastRequest = fingerprint;
      });
    },
    admit(instanceId: string, expectedGeneration: number, legacyEnabled: boolean) {
      return update((state) => {
        expectGeneration(state, expectedGeneration);
        const member = memberOf(state, instanceId);
        if (state.enabled) {
          if (state.desiredDeploymentId !== member.deploymentId)
            throw new BackgroundOwnershipConflict("Deployment is not the desired owner");
          if (state.members.some((other) => other.state === "admitted" && other.generation !== state.generation))
            throw new BackgroundOwnershipConflict("Previous owners have not relinquished work");
        } else if (!legacyEnabled) {
          throw new BackgroundOwnershipConflict("Legacy background work is disabled");
        }
        member.generation = state.generation;
        member.state = "admitted";
        member.ready = false;
      });
    },
    markReady(instanceId: string, generation: number) {
      return update((state) => {
        expectGeneration(state, generation);
        const member = memberOf(state, instanceId);
        if (
          member.generation !== generation ||
          member.state !== "admitted" ||
          (state.enabled && state.desiredDeploymentId !== member.deploymentId)
        )
          throw new BackgroundOwnershipConflict("Instance admission changed");
        member.ready = true;
      });
    },
    acknowledge(instanceId: string, generation: number, next: "relinquished" | "drained") {
      return update((state) => {
        const member = memberOf(state, instanceId);
        if (member.generation !== generation) throw new BackgroundOwnershipConflict("Instance admission changed");
        if (member.state === "drained" || member.state === next) return;
        if (next === "drained" && member.state !== "relinquished")
          throw new BackgroundOwnershipConflict("Instance must relinquish before reporting drained");
        member.state = next;
        member.ready = false;
      });
    },
    retire(request: {
      expectedGeneration: number;
      requestId: string;
      terminatedMembers: Array<Pick<BackgroundMember, "instanceId" | "taskArn" | "generation">>;
    }) {
      const fingerprint = JSON.stringify([
        "retire",
        request.expectedGeneration,
        request.terminatedMembers.map((member) => [member.instanceId, member.taskArn, member.generation]).sort(),
      ]);
      return update((state) => {
        expectGeneration(state, request.expectedGeneration);
        if (state.lastRequestId === request.requestId) {
          if (state.lastRequest !== fingerprint)
            throw new BackgroundOwnershipConflict("Request identity reused for a different retirement");
          return;
        }
        if (!request.terminatedMembers.length)
          throw new BackgroundOwnershipConflict("Retirement requires exact terminated members");
        for (const proof of request.terminatedMembers) {
          const member = state.members.find((entry) => entry.instanceId === proof.instanceId);
          if (!member || !proof.taskArn || member.taskArn !== proof.taskArn || member.generation !== proof.generation)
            throw new BackgroundOwnershipConflict("Termination evidence does not match the enrolled instance");
          member.state = "drained";
          member.retired = true;
          member.ready = false;
        }
        state.lastRequestId = request.requestId;
        state.lastRequest = fingerprint;
      });
    },
  };
}

export type BackgroundOwnershipStore = ReturnType<typeof createBackgroundOwnershipStore>;
