import { jsonbStringify, pgTextSafe } from "../util/text.ts";

export type ColumnCast = "text" | "bigint" | "double precision" | "boolean" | "jsonb" | "text[]";

export interface TypedColumns<T> {
  names: string;
  placeholders: string;
  params(record: T): unknown[];
  fromRow(row: Record<string, unknown>): T;
  fromJson(source: string): string;
}

const snake = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function toParam(cast: ColumnCast, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (cast === "text") return pgTextSafe(String(value));
  if (cast === "jsonb") return jsonbStringify(value);
  if (cast === "text[]") return (value as string[]).map(pgTextSafe);
  return value;
}

function jsonField(source: string, field: string, cast: ColumnCast): string {
  const v = `${source}.json->'${field}'`;
  const when = (kind: string, expr: string) => `CASE WHEN jsonb_typeof(${v}) = '${kind}' THEN ${expr} END`;
  if (cast === "text") return when("string", `${source}.json->>'${field}'`);
  if (cast === "bigint") return when("number", `(${v})::numeric::bigint`);
  if (cast === "double precision") return when("number", `(${v})::float8`);
  if (cast === "boolean") return when("boolean", `(${v})::boolean`);
  if (cast === "text[]") return when("array", `ARRAY(SELECT jsonb_array_elements_text(${v}))`);
  return `CASE WHEN jsonb_typeof(${v}) <> 'null' THEN ${v} END`;
}

export function typedColumns<T>(spec: { readonly [K in keyof T & string]-?: ColumnCast }): TypedColumns<T> {
  const columns = (Object.entries(spec) as Array<[keyof T & string, ColumnCast]>).map(([field, cast]) => ({
    field,
    cast,
    name: snake(field),
  }));
  return {
    names: columns.map((c) => c.name).join(", "),
    placeholders: columns.map((c, i) => `$${i + 1}::${c.cast}`).join(", "),
    params: (record) => columns.map((c) => toParam(c.cast, record[c.field])),
    fromRow(row) {
      const record: Record<string, unknown> = {};
      for (const c of columns) {
        const value = row[c.name];
        if (value === null || value === undefined) continue;
        record[c.field] = c.cast === "bigint" || c.cast === "double precision" ? Number(value) : value;
      }
      return record as T;
    },
    fromJson: (source) =>
      columns.map((c) => (c.field === "id" ? `${source}.id` : jsonField(source, c.field, c.cast))).join(", "),
  };
}
