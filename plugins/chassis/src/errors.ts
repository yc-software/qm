export function errMessage(e: unknown, fallback?: string): string {
  if (e instanceof Error) return e.message;
  if (fallback !== undefined) return fallback;
  return errorText(e);
}

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
  const seen = new Set<unknown>();
  const messages = new Set([e.message]);
  const pending: unknown[] = [e];
  for (const cause of pending) {
    if (cause == null || seen.has(cause)) continue;
    seen.add(cause);
    const causeMessage = cause instanceof Error ? cause.message : errorText(cause);
    if (!messages.has(causeMessage)) parts.push(describeCause(cause));
    messages.add(causeMessage);
    if (cause instanceof Error) pending.push(cause.cause);
    if (cause instanceof AggregateError && Array.isArray(cause.errors)) pending.push(...cause.errors);
  }
  return parts.join(" <- ");
}

function errorFields(e: unknown): string {
  try {
    if (typeof e !== "object" || e === null) return "";
    const fields = Object.entries(Object.getOwnPropertyDescriptors(e))
      .filter(([key, descriptor]) => key !== "cause" && descriptor.enumerable)
      .map(([key, descriptor]) => {
        try {
          const seen = new Set<object>();
          const value = descriptor.value;
          const text =
            typeof value === "object" && value !== null
              ? JSON.stringify(value, (_key, item) => {
                  if (typeof item === "bigint") return String(item);
                  if (typeof item === "object" && item !== null) {
                    if (seen.has(item)) return "[Circular]";
                    seen.add(item);
                  }
                  return item;
                })
              : String(value);
          return `${key}=${descriptor.get ? "[Getter]" : text}`;
        } catch {
          return `${key}=[Unserializable]`;
        }
      });
    return fields.length ? ` [${fields.join(" ")}]` : "";
  } catch {
    return "";
  }
}

export function errDetail(e: unknown, seen = new Set<unknown>()): string {
  try {
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
    const nested =
      e instanceof Error ? [e.cause, ...(e instanceof AggregateError && Array.isArray(e.errors) ? e.errors : [])] : [];
    const details = nested
      .filter((error) => error != null)
      .map((error) => errDetail(error, seen))
      .filter(Boolean);
    return `${errChain(e)}${errorFields(e)}${stack ? ` {stack: ${stack}}` : ""}${details.length ? ` {causes: ${details.join(" | ")}}` : ""}`;
  } catch {
    return "[Uninspectable error]";
  }
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
