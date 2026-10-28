interface ModelDispatch {
  start: number;
  first?: number;
  gateway?: Record<string, string>;
  streamStart?: number;
  prepareNextTurn?: number;
  transformContext?: number;
}

interface CapturedRequest {
  transport?: { modelId?: string; headers?: Record<string, string> };
}

export interface ModelCallLog {
  count(): number;
  dispatched(): void;
  markPrepareNextTurn(): void;
  markTransformContext(): void;
  responded(gateway: () => Record<string, string> | undefined): void;
  streamStarted(at: number): void;
  capture(request: CapturedRequest): void;
  takeCaptured(): CapturedRequest[];
  takeDispatches(): ModelDispatch[];
}

export function createModelCallLog(): ModelCallLog {
  let calls = 0;
  let captured: CapturedRequest[] | undefined = [];
  let dispatches: ModelDispatch[] | undefined = [];
  let pendingPrepareNextTurn: number | undefined;
  let pendingTransformContext: number | undefined;
  return {
    count: () => calls,
    dispatched: () => {
      calls += 1;
      (dispatches ??= []).push({
        start: Date.now(),
        ...(pendingPrepareNextTurn !== undefined ? { prepareNextTurn: pendingPrepareNextTurn } : {}),
        ...(pendingTransformContext !== undefined ? { transformContext: pendingTransformContext } : {}),
      });
      pendingPrepareNextTurn = undefined;
      pendingTransformContext = undefined;
    },
    markPrepareNextTurn: () => {
      pendingPrepareNextTurn = Date.now();
    },
    markTransformContext: () => {
      pendingTransformContext = Date.now();
    },
    responded: (gateway) => {
      const last = dispatches?.at(-1);
      if (!last || last.first !== undefined) return;
      last.first = Date.now();
      const headers = gateway();
      if (headers) last.gateway = headers;
    },
    streamStarted: (at) => {
      const last = dispatches?.at(-1);
      if (last && last.first !== undefined && last.streamStart === undefined) last.streamStart = at;
    },
    capture: (request) => {
      captured?.push(request);
    },
    takeCaptured: () => {
      const taken = captured ?? [];
      captured = undefined;
      return taken;
    },
    takeDispatches: () => {
      const taken = dispatches ?? [];
      dispatches = undefined;
      return taken;
    },
  };
}
