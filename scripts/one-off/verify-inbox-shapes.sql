BEGIN READ ONLY;

SELECT l.id AS unmigrated_inbox_loop
FROM loops l
WHERE l.json->>'surface' = 'inbox'
  AND (l.json->>'state' IS DISTINCT FROM 'archived'
    OR EXISTS (SELECT 1 FROM loop_items i WHERE i.json->>'loopId' = l.id)
    OR EXISTS (SELECT 1 FROM loop_outputs o WHERE o.json->>'loopId' = l.id)
    OR EXISTS (SELECT 1 FROM crons c WHERE c.id = l.json->>'cronId'
      AND (c.json->>'enabled' IS DISTINCT FROM 'false' OR c.json->>'archived' IS DISTINCT FROM 'true')));

WITH slack AS (
  SELECT id, json->>'sourceKey' AS stored_key,
    json #>> '{sourcePayload,slack,channelId}' AS channel,
    json #>> '{sourcePayload,slack,ts}' AS ts,
    NULLIF(json #>> '{sourcePayload,slack,threadTs}', '') AS thread_ts,
    COALESCE((json #>> '{sourcePayload,slack,isDirectMessage}')::boolean,
      LEFT(json #>> '{sourcePayload,slack,channelId}', 1) = 'D') AS dm
  FROM loop_items
  WHERE COALESCE(json->>'source', json #>> '{sourcePayload,source}') = 'slack'
), canonical AS (
  SELECT *, CASE WHEN dm AND thread_ts IS NULL THEN channel
    ELSE channel || ':' || COALESCE(thread_ts, ts) END AS current_key
  FROM slack
)
SELECT id AS noncanonical_slack_item, stored_key, current_key
FROM canonical
WHERE current_key IS NULL OR stored_key IS DISTINCT FROM current_key;

SELECT id AS missing_agent_drafts
FROM loop_items
WHERE jsonb_typeof(json->'agentDrafts') IS DISTINCT FROM 'array';

COMMIT;
