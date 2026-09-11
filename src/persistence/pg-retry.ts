import { isObj } from "../util/objects.ts";

export function postgresRetryDelay(error: unknown, priorErrors: number): number | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && isObj(current); depth++, current = current.cause) {
    const code = current.code;
    const message = current.message;
    if (
      (typeof code === "string" && (/^08\w{3}$/.test(code) || ["53300", "57P01", "57P02", "57P03"].includes(code))) ||
      (typeof message === "string" &&
        /^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout exceeded when trying to connect)$/.test(
          message,
        ))
    ) {
      const base = Math.min(60_000, 15_000 * 2 ** Math.min(Math.max(0, priorErrors), 2));
      return Math.min(60_000, Math.round(base * (1 + Math.random() * 0.2)));
    }
  }
  return undefined;
}
