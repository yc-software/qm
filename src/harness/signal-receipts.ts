export function createSignalReceipts() {
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  let closed = false;
  return {
    async waitFor(id: string, submit: () => Promise<void>): Promise<void> {
      if (closed) throw new Error("signal recipient closed");
      const receipt = Promise.withResolvers<void>();
      pending.set(id, receipt);
      try {
        await Promise.all([
          receipt.promise,
          Promise.resolve().then(() => {
            if (closed) throw new Error("signal recipient closed");
            return submit();
          }),
        ]);
      } finally {
        pending.delete(id);
      }
    },
    accept(id: string): void {
      pending.get(id)?.resolve();
    },
    close(): void {
      closed = true;
      for (const receipt of pending.values()) receipt.reject(new Error("signal recipient closed before acceptance"));
      pending.clear();
    },
  };
}
