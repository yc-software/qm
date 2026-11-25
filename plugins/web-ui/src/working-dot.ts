export function liveTurnThreadRef(o: {
  mountedThreadRef: string | null;
  isStreaming: boolean;
  pendingSend: string | null;
}): string | null {
  if (o.mountedThreadRef === null) return null;
  return o.isStreaming || o.pendingSend === o.mountedThreadRef ? o.mountedThreadRef : null;
}

export function liveTurnOf(state: {
  threadRef: string | null;
  agent: { state: { isStreaming: boolean } } | null;
  pendingSend: string | null;
}): string | null {
  return liveTurnThreadRef({
    mountedThreadRef: state.threadRef,
    isStreaming: Boolean(state.agent?.state.isStreaming),
    pendingSend: state.pendingSend,
  });
}

export function isSessionWorking(o: {
  serverWorking: boolean;
  threadRef: string;
  liveThreadRef: string | null;
}): boolean {
  return o.serverWorking || o.threadRef === o.liveThreadRef;
}
