export const SPEND_INVALIDATION = `  CREATE FUNCTION invalidate_request_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_request_spend$
           BEGIN
             INSERT INTO session_spend_dirty(day)
             SELECT DISTINCT floor(at::numeric / 86400000)::bigint
               FROM (VALUES
                 (CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.created_at END),
                 (CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.created_at END)
               ) changed(at) WHERE at IS NOT NULL
             ON CONFLICT DO NOTHING;
             RETURN NULL;
           END $invalidate_request_spend$;
  CREATE TRIGGER session_llm_requests_spend_dirty
    AFTER INSERT OR UPDATE OF created_at, session_id, model, usage_json OR DELETE ON session_llm_requests
    FOR EACH ROW EXECUTE FUNCTION invalidate_request_spend();
  CREATE FUNCTION invalidate_session_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_session_spend$
           BEGIN
             IF TG_OP = 'UPDATE' AND ROW(OLD.id, OLD.scope_id, OLD.origin, OLD.thread_ref, OLD.parent_session_id)
                  IS NOT DISTINCT FROM ROW(NEW.id, NEW.scope_id, NEW.origin, NEW.thread_ref, NEW.parent_session_id) THEN
               RETURN NULL;
             END IF;
             INSERT INTO session_spend_dirty(session_id)
             SELECT DISTINCT id FROM (VALUES (OLD.id), (NEW.id)) changed(id) WHERE id IS NOT NULL;
             RETURN NULL;
           END $invalidate_session_spend$;
  CREATE TRIGGER sessions_spend_dirty
    AFTER INSERT OR UPDATE OF id, scope_id, origin, thread_ref, parent_session_id OR DELETE ON sessions
    FOR EACH ROW EXECUTE FUNCTION invalidate_session_spend();
`;
