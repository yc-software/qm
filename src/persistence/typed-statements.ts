import { typedColumns, type ColumnCast, type TypedColumns } from "./typed-columns.ts";

export function jsonBackfill<T>(
  table: string,
  spec: { readonly [K in keyof T & string]-?: ColumnCast },
): Record<string, string> {
  return Object.fromEntries(
    Object.entries<ColumnCast>(spec).map(([field, cast]) => {
      const column = typedColumns<Record<string, unknown>>({ [field]: cast });
      return [column.names, column.fromJson(`${table}_kv`)];
    }),
  );
}

export function upsertStatement<T>(table: string, columns: TypedColumns<T>, key: string, conflict = "update"): string {
  const updates = columns.names
    .split(", ")
    .filter((name) => name !== key)
    .map((name) => `${name} = EXCLUDED.${name}`);
  const action = conflict === "update" ? `DO UPDATE SET ${updates.join(", ")}` : "DO NOTHING";
  return `INSERT INTO ${table}(${columns.names}) VALUES (${columns.placeholders}) ON CONFLICT (tenant_id, ${key}) ${action}`;
}
