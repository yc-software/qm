export const fold = (expr: string): string =>
  `CASE WHEN position('@' IN btrim(${expr})) > 0 THEN lower(btrim(${expr})) ELSE btrim(${expr}) END`;

export const ts = (param: string): string => `to_timestamp(${param}::double precision / 1000)`;
