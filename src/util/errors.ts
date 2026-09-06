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

export function errMessage(e: unknown): string {
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

export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(errorText(e));
}

export function swallow(context: string, e: unknown): void {
  console.warn(`[swallowed] ${context}: ${errMessage(e)}`);
}

export function swallowAs<T>(context: string, fallback: T): (e: unknown) => T {
  return (e) => {
    swallow(context, e);
    return fallback;
  };
}
