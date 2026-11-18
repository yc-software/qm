const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const callbacks = new Map<unknown, () => void>();

globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const timer = realSetInterval(fn, ms, ...args);
  callbacks.set(timer, () => fn(...args));
  return timer;
}) as typeof setInterval;

globalThis.clearInterval = ((timer?: Parameters<typeof clearInterval>[0]) => {
  callbacks.delete(timer);
  realClearInterval(timer);
}) as typeof clearInterval;

process.on("SIGUSR2", () => {
  const due = [...callbacks.values()];
  for (const tick of due) tick();
  console.log(`[runtime-qa] SIGUSR2 ticked ${due.length} intervals`);
});
