ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_last_activity bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_last_activity_seq integer;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_activity_version smallint NOT NULL DEFAULT 1;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_activity bigint;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS activity_version smallint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION safe_jsonb(t text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
        BEGIN
          RETURN t::jsonb;
        EXCEPTION WHEN others THEN
          BEGIN RETURN regexp_replace(t, '(^|[^\\])(\\\\)*(\\u0000)+', '\1\2', 'g')::jsonb;
          EXCEPTION WHEN others THEN RETURN NULL;
          END;
        END $function$
;
CREATE OR REPLACE FUNCTION session_entry_boundary_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
       BEGIN
         PERFORM 1 FROM sessions WHERE id = NEW.session_id FOR NO KEY UPDATE;
         IF NOT FOUND THEN RETURN NULL; END IF;
         RETURN NEW;
       END $function$
;
CREATE OR REPLACE FUNCTION participant_activity_on_insert_v3()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
       DECLARE boundary INT;
       DECLARE session_created BIGINT;
       BEGIN
         PERFORM 1 FROM participants
           WHERE session_id = NEW.session_id AND principal_id = NEW.principal_id
           FOR UPDATE;
         SELECT created_at INTO session_created FROM sessions WHERE id = NEW.session_id FOR NO KEY UPDATE;
         IF NOT FOUND THEN RETURN NULL; END IF;
         SELECT COALESCE(MAX(seq) + 1, 0) INTO boundary FROM session_entries WHERE session_id = NEW.session_id;
         NEW.valid_from_seq := boundary;
         IF NEW.last_activity IS NULL THEN
           NEW.last_activity := CASE WHEN boundary = 0 THEN session_created ELSE NEW.valid_from END;
         END IF;
         NEW.activity_version := 3;
         RETURN NEW;
       END $function$
;
CREATE OR REPLACE FUNCTION participant_activity_on_reopen_v3()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
       DECLARE boundary INT;
       DECLARE session_created BIGINT;
       DECLARE session_user_activity BIGINT;
       DECLARE session_user_seq INT;
       BEGIN
         IF (OLD.valid_to IS NULL) <> (NEW.valid_to IS NULL) THEN
           SELECT created_at, user_last_activity, user_last_activity_seq
             INTO session_created, session_user_activity, session_user_seq
             FROM sessions WHERE id = NEW.session_id FOR NO KEY UPDATE;
           IF NOT FOUND THEN RETURN NULL; END IF;
           SELECT COALESCE(MAX(seq) + 1, 0) INTO boundary FROM session_entries WHERE session_id = NEW.session_id;
           IF NEW.valid_to IS NULL THEN
             NEW.valid_from_seq := boundary;
             NEW.last_activity := CASE WHEN boundary = 0 THEN session_created ELSE NEW.valid_from END;
           ELSE
             NEW.valid_to_seq := boundary;
             NEW.last_activity := CASE WHEN COALESCE(session_user_seq, -1) >= COALESCE(NEW.valid_from_seq, 0)
               THEN COALESCE(session_user_activity, NEW.last_activity, session_created)
               ELSE COALESCE(NEW.last_activity, session_created) END;
           END IF;
           NEW.activity_version := 3;
         END IF;
         RETURN NEW;
       END $function$
;
CREATE OR REPLACE FUNCTION participant_activity_on_entry_v3()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
       BEGIN
         IF NEW.type = 'user' AND NOT COALESCE(safe_jsonb(NEW.payload) @> '{"overheard":true}'::jsonb, FALSE) THEN
           UPDATE sessions
              SET user_last_activity = NEW.created_at, user_last_activity_seq = NEW.seq
            WHERE id = NEW.session_id;
           IF NOT FOUND THEN RAISE EXCEPTION 'session % does not exist', NEW.session_id USING ERRCODE = 'foreign_key_violation'; END IF;
         END IF;
         RETURN NEW;
       END $function$
;
CREATE OR REPLACE FUNCTION session_child_parent_exists()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
       BEGIN
         PERFORM 1 FROM sessions WHERE id = NEW.session_id FOR KEY SHARE;
         IF NOT FOUND THEN RETURN NULL; END IF;
         RETURN NEW;
       END $function$
;
CREATE TRIGGER participant_activity_entry_v3 AFTER INSERT ON session_entries FOR EACH ROW EXECUTE FUNCTION participant_activity_on_entry_v3();
CREATE TRIGGER session_entry_boundary_v1 BEFORE INSERT ON session_entries FOR EACH ROW EXECUTE FUNCTION session_entry_boundary_v1();
CREATE TRIGGER session_llm_request_parent BEFORE INSERT ON session_llm_requests FOR EACH ROW EXECUTE FUNCTION session_child_parent_exists();
CREATE TRIGGER participant_activity_reopen_v3 BEFORE UPDATE ON participants FOR EACH ROW EXECUTE FUNCTION participant_activity_on_reopen_v3();
CREATE TRIGGER participant_activity_boundary_insert_v3 BEFORE INSERT ON participants FOR EACH ROW EXECUTE FUNCTION participant_activity_on_insert_v3();
