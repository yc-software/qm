export interface EngagedRegistry {
  engage(threadRef: string): void;
  settle(threadRef: string): void;
  list(): string[];
}

export function createEngagedRegistry(): EngagedRegistry {
  const engaged = new Set<string>();
  return {
    engage: (threadRef) => void engaged.add(threadRef),
    settle: (threadRef) => void engaged.delete(threadRef),
    list: () => [...engaged],
  };
}
