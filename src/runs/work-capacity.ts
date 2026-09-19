export interface WorkCapacity {
  acquire(signal?: AbortSignal): Promise<(() => void) | null>;
}

export function createWorkCapacity(max: number, parent?: WorkCapacity): WorkCapacity {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("Work capacity must be a positive integer");
  let available = max;
  const waiting = new Set<() => void>();

  const releasePermit = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      available++;
      waiting.values().next().value?.();
    };
  };

  const local: WorkCapacity = {
    acquire(signal) {
      if (signal?.aborted) return Promise.resolve(null);
      if (available > 0) {
        available--;
        return Promise.resolve(releasePermit());
      }
      return new Promise((resolve) => {
        const cleanup = () => {
          waiting.delete(grant);
          signal?.removeEventListener("abort", abort);
        };
        const grant = () => {
          cleanup();
          available--;
          resolve(releasePermit());
        };
        const abort = () => {
          cleanup();
          resolve(null);
        };
        waiting.add(grant);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  if (!parent) return local;
  return {
    async acquire(signal) {
      const releaseLocal = await local.acquire(signal);
      if (!releaseLocal) return null;
      let releaseParent: (() => void) | null = null;
      try {
        releaseParent = await parent.acquire(signal);
        if (!releaseParent || signal?.aborted) {
          releaseParent?.();
          releaseLocal();
          return null;
        }
      } catch (error) {
        releaseLocal();
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseParent();
        releaseLocal();
      };
    },
  };
}
