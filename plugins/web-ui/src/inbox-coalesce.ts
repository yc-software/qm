export interface InboxItemRef {
  loopId: string;
  itemId: string;
}

export function createInboxEventCoalescer(
  windowMs: number,
  flush: (batch: InboxItemRef[]) => void,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms),
): (ref: InboxItemRef) => void {
  const pending = new Map<string, InboxItemRef>();
  let armed = false;
  return (ref) => {
    pending.set(JSON.stringify([ref.loopId, ref.itemId]), ref);
    if (armed) return;
    armed = true;
    schedule(() => {
      armed = false;
      const batch = [...pending.values()];
      pending.clear();
      if (batch.length) flush(batch);
    }, windowMs);
  };
}
