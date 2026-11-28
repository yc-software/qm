export const SPEND_INDEXABLE = `(spend_usage_json(usage_json) IS NOT NULL
  AND octet_length(session_id) + octet_length(model) + octet_length(usage_json) <= 2000)`;

export const ancestry = (seed: string): string => `ancestry AS (
         SELECT s.id AS session_id, s.parent_session_id, s.origin AS origin, s.origin_id AS cron_id,
                ARRAY[s.id] AS path
           FROM sessions s
          WHERE ${seed}
         UNION ALL
         SELECT a.session_id, p.parent_session_id, p.origin, p.origin_id, a.path || p.id
           FROM ancestry a JOIN sessions p ON p.id = a.parent_session_id
          WHERE a.origin = 'conversation' AND NOT p.id = ANY(a.path) AND cardinality(a.path) < 64
       )`;
