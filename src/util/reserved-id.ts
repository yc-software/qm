import { randomUUID } from "node:crypto";

export function reservedOrRandomId(reservedId?: string): string {
  if (reservedId === undefined) return randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reservedId))
    throw new Error("reserved id must be a lowercase UUID");
  return reservedId;
}
