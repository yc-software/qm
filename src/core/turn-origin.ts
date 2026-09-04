import type { TurnOrigin, TurnRequest } from "../types.ts";
export type { TurnOrigin } from "../types.ts";

type LegacyTurnOrigin = Pick<
  TurnRequest,
  | "triggerTs"
  | "entryTs"
  | "triggered"
  | "securityScreenData"
  | "triggerDestination"
  | "ownerKeychainUnion"
  | "unprompted"
  | "liveActor"
>;

export function resolveTurnOrigin(input: Partial<LegacyTurnOrigin> & { origin?: TurnOrigin }): TurnOrigin {
  const typed = input.origin;
  const hasLegacy = input.triggered === true || input.unprompted === true || input.liveActor === true;
  if (!typed) return normalizeTurnOrigin(input);
  if (!hasLegacy) return typed;
  const legacy = normalizeTurnOrigin(input);
  const rank: Record<TurnOrigin["kind"], number> = { direct: 0, human: 1, ambient: 2, automation: 3 };
  if (rank[typed.kind] !== rank[legacy.kind]) return rank[typed.kind] > rank[legacy.kind] ? typed : legacy;
  if (typed.kind === "automation" && legacy.kind === "automation") {
    let screenData = typed.screenData;
    if (screenData === undefined) screenData = legacy.screenData;
    else if (legacy.screenData !== undefined && screenData !== legacy.screenData) {
      screenData = `Typed automation data:\n${screenData}\n\nLegacy automation data:\n${legacy.screenData}`;
    }
    return {
      kind: "automation",
      ...(screenData !== undefined ? { screenData } : {}),
      ...((typed.destination ?? legacy.destination) ? { destination: typed.destination ?? legacy.destination! } : {}),
      ...(typed.useOwnerKeychain || legacy.useOwnerKeychain ? { useOwnerKeychain: true } : {}),
    };
  }
  if (typed.kind === "human" && legacy.kind === "human") {
    return {
      kind: "human",
      ...((typed.messageTs ?? legacy.messageTs) ? { messageTs: typed.messageTs ?? legacy.messageTs! } : {}),
      ...((typed.entryTs ?? legacy.entryTs) ? { entryTs: typed.entryTs ?? legacy.entryTs! } : {}),
    };
  }
  if (typed.kind === "ambient" && legacy.kind === "ambient") {
    return {
      kind: "ambient",
      ...((typed.entryTs ?? legacy.entryTs) ? { entryTs: typed.entryTs ?? legacy.entryTs! } : {}),
      ...(typed.live === true || legacy.live === true ? { live: true } : {}),
    };
  }
  return typed;
}

export function normalizeTurnOrigin(input: LegacyTurnOrigin): TurnOrigin {
  if (input.triggered === true) {
    return {
      kind: "automation",
      ...(input.securityScreenData !== undefined ? { screenData: input.securityScreenData } : {}),
      ...(input.triggerDestination ? { destination: input.triggerDestination } : {}),
      ...(input.ownerKeychainUnion === true ? { useOwnerKeychain: true } : {}),
    };
  }
  if (input.unprompted === true) {
    return {
      kind: "ambient",
      ...(typeof input.entryTs === "string" && input.entryTs ? { entryTs: input.entryTs } : {}),
      ...(input.liveActor === true ? { live: true } : {}),
    };
  }
  if (input.liveActor === true) {
    return {
      kind: "human",
      ...(typeof input.triggerTs === "string" && input.triggerTs ? { messageTs: input.triggerTs } : {}),
      ...(typeof input.entryTs === "string" && input.entryTs ? { entryTs: input.entryTs } : {}),
    };
  }
  return { kind: "direct" };
}

export function turnOriginRequestFields(origin: TurnOrigin): Partial<LegacyTurnOrigin> {
  switch (origin.kind) {
    case "human":
      return {
        liveActor: true,
        ...(origin.messageTs ? { triggerTs: origin.messageTs } : {}),
        ...(origin.entryTs ? { entryTs: origin.entryTs } : {}),
      };
    case "ambient":
      return {
        unprompted: true,
        ...(origin.entryTs ? { entryTs: origin.entryTs } : {}),
        ...(origin.live === true ? { liveActor: true } : {}),
      };
    case "automation":
      return {
        triggered: true,
        ...(origin.screenData !== undefined ? { securityScreenData: origin.screenData } : {}),
        ...(origin.destination ? { triggerDestination: origin.destination } : {}),
        ...(origin.useOwnerKeychain ? { ownerKeychainUnion: true } : {}),
      };
    case "direct":
      return {};
  }
}
