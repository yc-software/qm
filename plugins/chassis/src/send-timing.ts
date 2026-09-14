const SEND_TIMING_STAGES = [
  "send_start",
  "uploads_complete",
  "request_start",
  "response_received",
  "queue_rendered",
  "error",
  "received",
  "forward_start",
  "response_sent",
  "closed",
  "models_ready",
  "identity_ready",
  "validation_complete",
  "approvals_checked",
  "enqueue_start",
  "enqueued",
  "complete",
] as const;
export type SendTimingStage = (typeof SEND_TIMING_STAGES)[number];
export type SendTimingLayer = "browser" | "web" | "core";
export interface SendTimingEvent {
  event: "send_timing";
  traceId: string;
  layer: SendTimingLayer;
  stage: SendTimingStage;
  elapsedMs: number;
  at: number;
}

export function sendTraceId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

export function parseSendTiming(value: unknown): SendTimingEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const traceId = sendTraceId(row.traceId);
  if (
    !traceId ||
    !["browser", "web", "core"].includes(String(row.layer)) ||
    !SEND_TIMING_STAGES.includes(row.stage as SendTimingStage) ||
    typeof row.elapsedMs !== "number" ||
    !Number.isFinite(row.elapsedMs) ||
    row.elapsedMs < 0 ||
    row.elapsedMs > 3_600_000 ||
    typeof row.at !== "number" ||
    !Number.isSafeInteger(row.at) ||
    row.at < 0
  )
    return null;
  return {
    event: "send_timing",
    traceId,
    layer: row.layer as SendTimingLayer,
    stage: row.stage as SendTimingStage,
    elapsedMs: Math.round(row.elapsedMs),
    at: row.at,
  };
}

export function logSendTiming(event: SendTimingEvent): void {
  const safe = parseSendTiming(event);
  if (safe) console.info(JSON.stringify(safe));
}

export function createSendTiming(
  id: unknown,
  layer: SendTimingLayer,
  emit = logSendTiming,
): (stage: SendTimingStage) => void {
  const traceId = sendTraceId(id);
  const start = performance.now();
  return (stage) => {
    if (!traceId) return;
    try {
      emit({
        event: "send_timing",
        traceId,
        layer,
        stage,
        elapsedMs: Math.round(performance.now() - start),
        at: Date.now(),
      });
    } catch {
      return;
    }
  };
}
