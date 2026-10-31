import { jsonbStringify, pgTextSafe } from "../util/text.ts";

export type Row = Record<string, unknown>;

export const text = (value: string | undefined | null): string | null => (value == null ? null : pgTextSafe(value));

export const texts = (value: readonly string[] | undefined | null): string[] | null =>
  value == null ? null : value.map(pgTextSafe);

export const json = (value: unknown): string | null => (value == null ? null : jsonbStringify(value));

export const num = (value: unknown): number | undefined => (value == null ? undefined : Number(value));

export function present<T>(record: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined)) as T;
}

export const kvBigint = (field: string): string => `(json->>'${field}')::numeric::bigint`;

export const kvTexts = (field: string): string =>
  `CASE WHEN jsonb_typeof(json->'${field}') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(json->'${field}')) END`;

export const kvJsonb = (field: string): string => `NULLIF(json->'${field}', 'null'::jsonb)`;

export function columnList(columns: ReadonlyArray<readonly [string, string]>): { names: string; values: string } {
  return {
    names: columns.map(([name]) => name).join(", "),
    values: columns.map(([, type], i) => `$${i + 1}::${type}`).join(", "),
  };
}
