import { createMemorySnapshotStore, type HomeSnapshotStore } from "../../src/sandbox/home-snapshot.ts";

export interface InstrumentedSnapshotStore {
  store: HomeSnapshotStore;
  puts(): number;
  failReads(on: boolean): void;
  failWrites(on: boolean): void;
}

export function instrumentedSnapshotStore(): InstrumentedSnapshotStore {
  const inner = createMemorySnapshotStore();
  let puts = 0;
  let readsFail = false;
  let writesFail = false;
  const outage = (): Error => new Error("simulated S3 outage");
  return {
    store: {
      open: async (scope) => {
        if (readsFail) throw outage();
        return inner.open(scope);
      },
      put: async (scope, data) => {
        if (writesFail) throw outage();
        puts++;
        await inner.put(scope, data);
      },
      createUpload: async (scope) => {
        if (writesFail) throw outage();
        const upload = await inner.createUpload(scope);
        return {
          ...upload,
          complete: async () => {
            if (writesFail) throw outage();
            puts++;
            await upload.complete();
          },
        };
      },
    },
    puts: () => puts,
    failReads: (on) => {
      readsFail = on;
    },
    failWrites: (on) => {
      writesFail = on;
    },
  };
}
