BEGIN;
LOCK TABLE loops, loop_items, loop_outputs, crons, web_ui_state IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM loops l
    WHERE l.json->>'surface' = 'inbox'
      AND (l.json->>'state' IS DISTINCT FROM 'archived'
        OR EXISTS (SELECT 1 FROM loop_items i WHERE i.json->>'loopId' = l.id)
        OR EXISTS (SELECT 1 FROM loop_outputs o WHERE o.json->>'loopId' = l.id)
        OR EXISTS (SELECT 1 FROM crons c WHERE c.id = l.json->>'cronId'
          AND (c.json->>'enabled' IS DISTINCT FROM 'false' OR c.json->>'archived' IS DISTINCT FROM 'true')))
  ) THEN
    RAISE EXCEPTION 'Complete the Inbox migration before retiring its empty loops';
  END IF;
END $$;

UPDATE web_ui_state u
SET json = jsonb_set(u.json, '{value}', COALESCE((
  SELECT jsonb_agg(value ORDER BY ordinal)
  FROM jsonb_array_elements(u.json->'value') WITH ORDINALITY AS selection(value, ordinal)
  WHERE NOT EXISTS (SELECT 1 FROM loops l WHERE l.json->>'surface' = 'inbox' AND to_jsonb(l.id) = value)
), '[]'::jsonb))
WHERE RIGHT(u.id, 12) = '#inbox-loops'
  AND jsonb_typeof(u.json->'value') = 'array'
  AND EXISTS (SELECT 1 FROM loops l WHERE l.json->>'surface' = 'inbox' AND (u.json->'value') ? l.id);

DELETE FROM loops WHERE json->>'surface' = 'inbox';
COMMIT;
