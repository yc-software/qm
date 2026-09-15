export interface LazyModule<T> {
  load(): Promise<T>;
  loaded(): T | null;
  reset(): void;
}

export function lazyModule<T>(loadModule: () => Promise<T>, resetModule?: (module: T) => void): LazyModule<T> {
  let module: T | null = null;
  let pending: Promise<T> | null = null;

  return {
    load(): Promise<T> {
      if (module) return Promise.resolve(module);
      if (pending) return pending;
      pending = loadModule().then(
        (loaded) => {
          module = loaded;
          return loaded;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
    loaded(): T | null {
      return module;
    },
    reset(): void {
      if (module && resetModule) resetModule(module);
    },
  };
}
