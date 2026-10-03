SELECT d.id, v->>'version' AS version
FROM deployments d, jsonb_array_elements(d.json->'versions') v
WHERE NULLIF(v->>'commit', '') IS NULL;

SELECT process_id, scope_id, status FROM process_sessions
WHERE NULLIF(sandbox_id, '') IS NULL;
