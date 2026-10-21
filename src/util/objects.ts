export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
