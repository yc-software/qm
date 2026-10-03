export function errMessage(e: unknown, fallback?: string): string {
  if (e instanceof Error) return e.message;
  if (fallback !== undefined) return fallback;
  return errorText(e);
}

const CAUSE_DEPTH = 5;

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
  if ("message" in value && typeof value.message === "string") return value.message;
  return "Unknown error";
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return errorText(cause);
  const code = (cause as { code?: unknown }).code;
  const label = code !== undefined && code !== null && code !== "" ? `${cause.name} ${errorText(code)}` : cause.name;
  return cause.message ? `${label}: ${cause.message}` : label;
}

export function errChain(e: unknown): string {
  if (!(e instanceof Error)) return errorText(e);
  const parts = [e.message];
  const seen = new Set<unknown>([e]);
  const messages = new Set([e.message]);
  let cause: unknown = e.cause;
  while (cause !== undefined && cause !== null && !seen.has(cause) && parts.length <= CAUSE_DEPTH) {
    seen.add(cause);
    const causeMessage = cause instanceof Error ? cause.message : errorText(cause);
    if (!messages.has(causeMessage)) parts.push(describeCause(cause));
    messages.add(causeMessage);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join(" <- ");
}

function errorFields(e: unknown): string {
  if (typeof e !== "object" || e === null) return "";
  const record = e as { code?: unknown; status?: unknown; statusCode?: unknown };
  const fields = Object.entries({
    code: record.code,
    status: record.status ?? record.statusCode,
  }).filter(([, value]) => typeof value === "string" || typeof value === "number");
  return fields.length ? ` [${fields.map(([key, value]) => `${key}=${String(value)}`).join(" ")}]` : "";
}

export function errDetail(e: unknown, seen = new Set<unknown>()): string {
  if (seen.has(e)) return "";
  seen.add(e);
  const frames =
    e instanceof Error
      ? (e.stack
          ?.split("\n")
          .slice(1)
          .map((line) => line.trim()) ?? [])
      : [];
  const stack = frames.filter(Boolean).join(" | ");
  const nested = e instanceof Error ? [e.cause, ...(e instanceof AggregateError ? e.errors : [])] : [];
  const details = nested
    .filter((error) => error != null)
    .map((error) => errDetail(error, seen))
    .filter(Boolean);
  return `${errChain(e)}${errorFields(e)}${stack ? ` {stack: ${stack}}` : ""}${details.length ? ` {causes: ${details.join(" | ")}}` : ""}`;
}

export function swallow(context: string, e: unknown): void {
  console.warn(`[swallowed] ${context}: ${errDetail(e)}`);
}

export function swallowAs<T>(context: string, fallback: T): (e: unknown) => T {
  return (e) => {
    swallow(context, e);
    return fallback;
  };
}

export function failureCode(context: string): string {
  return context
    .toLowerCase()
    .replace(/\s*:\s*/g, ":")
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}
