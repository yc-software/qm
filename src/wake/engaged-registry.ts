export interface EngagedSession {
  tenantId: string;
  threadRef: string;
}

export interface EngagedRegistry {
  engage(session: EngagedSession): void;
  settle(session: EngagedSession): void;
  list(): EngagedSession[];
}

export function createEngagedRegistry(): EngagedRegistry {
  const engaged = new Map<string, EngagedSession>();
  const key = ({ tenantId, threadRef }: EngagedSession): string => JSON.stringify([tenantId, threadRef]);
  return {
    engage: (session) => void engaged.set(key(session), { ...session }),
    settle: (session) => void engaged.delete(key(session)),
    list: () => [...engaged.values()],
  };
}
