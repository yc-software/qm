const SECONDS_VS_MS_CUTOFF = 1_000_000_000_000;
const MIN_REASONABLE_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_REASONABLE_EPOCH_MS = Date.UTC(3000, 0, 1);

export type InboundExpiry = { ok: true; value?: number } | { ok: false; message: string };

export function normalizeInboundExpiresAt(value: unknown, field = "expiresAt"): InboundExpiry {
  if (value === undefined) return { ok: true };

  const raw = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  let ms: number;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return bad(field);
    ms = raw < SECONDS_VS_MS_CUTOFF ? raw * 1000 : raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return bad(field);
    ms = Date.parse(trimmed);
  } else {
    return bad(field);
  }

  if (!Number.isFinite(ms) || ms < MIN_REASONABLE_EPOCH_MS || ms > MAX_REASONABLE_EPOCH_MS) {
    return bad(field);
  }
  return { ok: true, value: Math.trunc(ms) };
}

function bad(field: string): InboundExpiry {
  return {
    ok: false,
    message: `${field} must be an epoch timestamp in seconds or milliseconds, or an ISO date string`,
  };
}
