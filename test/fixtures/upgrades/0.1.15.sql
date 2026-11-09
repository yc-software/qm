SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;
CREATE FUNCTION public.entry_search_text(payload text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $$
        DECLARE j json;
        BEGIN
          j := replace(payload, '\u0000', '')::json;
          RETURN CASE WHEN json_typeof(j -> 'text') = 'string' THEN j ->> 'text'
                      WHEN json_typeof(j) = 'string' THEN j #>> '{}'
                      ELSE NULL END;
        EXCEPTION WHEN others THEN RETURN NULL;
        END $$;
CREATE FUNCTION public.invalidate_request_spend() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
           BEGIN
             INSERT INTO session_spend_dirty(day)
             SELECT DISTINCT floor(at::numeric / 86400000)::bigint
               FROM (VALUES
                 (CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.created_at END),
                 (CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.created_at END)
               ) changed(at) WHERE at IS NOT NULL
             ON CONFLICT DO NOTHING;
             RETURN NULL;
           END $$;
CREATE FUNCTION public.invalidate_session_spend() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
           BEGIN
             IF TG_OP = 'UPDATE' AND ROW(OLD.id, OLD.scope_id, OLD.origin, OLD.thread_ref, OLD.parent_session_id)
                  IS NOT DISTINCT FROM ROW(NEW.id, NEW.scope_id, NEW.origin, NEW.thread_ref, NEW.parent_session_id) THEN
               RETURN NULL;
             END IF;
             INSERT INTO session_spend_dirty(session_id)
             SELECT DISTINCT id FROM (VALUES (OLD.id), (NEW.id)) changed(id) WHERE id IS NOT NULL;
             RETURN NULL;
           END $$;
CREATE FUNCTION public.safe_json(t text) RETURNS json
    LANGUAGE plpgsql IMMUTABLE
    AS $$
        BEGIN RETURN t::json; EXCEPTION WHEN others THEN RETURN NULL; END $$;
CREATE FUNCTION public.spend_usage_json(t text) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $$
             DECLARE j jsonb;
             BEGIN
               IF t IS NULL OR octet_length(t) > 2000 OR NOT pg_input_is_valid(t, 'jsonb') THEN
                 RETURN NULL;
               END IF;
               j := t::jsonb;
               IF pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN
                 RETURN j;
               END IF;
               RETURN NULL;
             END
             $$;
CREATE FUNCTION public.sync_session_entry_search() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
           DECLARE body text;
           BEGIN
             IF TG_OP = 'DELETE' THEN
               DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
               RETURN OLD;
             END IF;
             IF TG_OP = 'UPDATE' AND (OLD.session_id, OLD.seq) IS DISTINCT FROM (NEW.session_id, NEW.seq) THEN
               DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
             END IF;
             IF NEW.type IN ('user', 'assistant', 'text') THEN
               body := entry_search_text(NEW.payload);
             END IF;
             IF body IS NULL OR btrim(body) = '' THEN
               DELETE FROM session_entry_search WHERE session_id = NEW.session_id AND seq = NEW.seq;
             ELSE
               INSERT INTO session_entry_search(session_id, seq, type, author, text, created_at)
               VALUES (NEW.session_id, NEW.seq, NEW.type,
                       CASE WHEN NEW.type = 'user' THEN
                         (SELECT CASE WHEN json_typeof(j -> 'name') = 'string' THEN j ->> 'name' END
                            FROM (SELECT safe_json(replace(NEW.payload, '\u0000', '')) AS j) _) END,
                       body, NEW.created_at)
               ON CONFLICT (session_id, seq) DO UPDATE
                 SET type = EXCLUDED.type, author = EXCLUDED.author, text = EXCLUDED.text,
                     created_at = EXCLUDED.created_at;
             END IF;
             RETURN NEW;
           END $$;
SET default_tablespace = '';
SET default_table_access_method = heap;
CREATE TABLE public.directory_channel_members (
    org_id text NOT NULL,
    channel_id text NOT NULL,
    principal_id text NOT NULL
);
CREATE TABLE public.directory_channels (
    org_id text NOT NULL,
    channel_id text NOT NULL,
    name text NOT NULL,
    name_lc text NOT NULL,
    is_private boolean DEFAULT false NOT NULL,
    is_external boolean DEFAULT false NOT NULL,
    roster_known boolean DEFAULT false NOT NULL,
    observed_at bigint
);
CREATE TABLE public.directory_group_members (
    org_id text NOT NULL,
    group_id text NOT NULL,
    principal_id text NOT NULL
);
CREATE TABLE public.directory_groups (
    org_id text NOT NULL,
    group_id text NOT NULL,
    roster_known boolean DEFAULT false NOT NULL
);
CREATE TABLE public.directory_members (
    org_id text NOT NULL,
    principal_id text NOT NULL,
    display_name text NOT NULL,
    display_name_lc text NOT NULL,
    type text NOT NULL,
    slack_id text,
    avatar_url text
);
CREATE TABLE public.directory_meta (
    org_id text NOT NULL,
    workspace_url text,
    updated_at bigint NOT NULL
);
CREATE TABLE public.directory_sync (
    org_id text NOT NULL,
    members_hash text,
    channels_hash text,
    groups_hash text,
    channel_members_synced boolean DEFAULT false NOT NULL,
    updated_at bigint NOT NULL,
    members_synced_at bigint,
    channels_synced_at bigint,
    groups_synced_at bigint
);
CREATE TABLE public.legacy_tape_skipped (
    session_id text NOT NULL,
    error text NOT NULL,
    at bigint NOT NULL
);
CREATE TABLE public.legacy_tape_steps (
    session_id text NOT NULL,
    seq integer NOT NULL,
    step jsonb NOT NULL,
    wire jsonb
);
CREATE TABLE public.legacy_tape_steps_progress (
    singleton boolean DEFAULT true NOT NULL,
    started_at bigint,
    last_session text,
    done boolean DEFAULT false NOT NULL,
    invalid_messages bigint DEFAULT 0 NOT NULL,
    keyed_blocks bigint DEFAULT 0 NOT NULL,
    copied_steps bigint DEFAULT 0 NOT NULL,
    copied_turns bigint DEFAULT 0 NOT NULL,
    skipped_sessions bigint DEFAULT 0 NOT NULL,
    CONSTRAINT legacy_tape_steps_progress_singleton_check CHECK (singleton)
);
CREATE TABLE public.legacy_turn_runs (
    session_id text NOT NULL,
    seq integer NOT NULL,
    run_id text NOT NULL,
    inferred boolean NOT NULL
);
CREATE TABLE public.llm_prompt_envelopes (
    hash text NOT NULL,
    body text NOT NULL,
    created_at bigint NOT NULL
);
CREATE TABLE public.participants (
    session_id text NOT NULL,
    principal_id text NOT NULL,
    valid_from bigint NOT NULL,
    valid_to bigint,
    valid_from_seq integer,
    valid_to_seq integer,
    title text,
    archived boolean DEFAULT false NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    color text,
    read_at bigint
);
CREATE TABLE public.qm_schema_migrations (
    id text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.runs (
    id text NOT NULL,
    session_id text NOT NULL,
    status text NOT NULL,
    request text NOT NULL,
    result text,
    idempotency_key text,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    lease_token text,
    lease_expires_at bigint,
    worker_id text,
    created_at bigint NOT NULL,
    started_at bigint,
    finished_at bigint,
    delivery_state text,
    error_attempts integer DEFAULT 0 NOT NULL,
    seq bigint NOT NULL,
    turn_user_seq bigint,
    retry_after bigint DEFAULT 0 NOT NULL,
    returned_at bigint,
    last_stop text,
    claim_priority smallint DEFAULT 2 NOT NULL,
    preemptions integer DEFAULT 0 NOT NULL
);
CREATE SEQUENCE public.runs_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.runs_seq_seq OWNED BY public.runs.seq;
CREATE TABLE public.session_entries (
    session_id text NOT NULL,
    seq integer NOT NULL,
    parent_seq integer,
    type text NOT NULL,
    payload text,
    scope_label text NOT NULL,
    created_at bigint NOT NULL,
    search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(public.entry_search_text(payload), ''::text))) STORED
);
CREATE TABLE public.session_entry_search (
    session_id text NOT NULL,
    seq integer NOT NULL,
    type text NOT NULL,
    author text,
    text text NOT NULL,
    created_at bigint NOT NULL,
    search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED
);
CREATE TABLE public.session_goals (
    session_id text NOT NULL,
    objective text NOT NULL,
    status text NOT NULL,
    floor jsonb,
    token_cap bigint,
    tokens_used bigint DEFAULT 0 NOT NULL,
    active_ms bigint,
    active_since timestamp with time zone,
    completion_note text,
    cancel_note text,
    governor jsonb,
    pause_reason text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT session_goals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'complete'::text, 'cancelled'::text])))
);
CREATE TABLE public.session_leases (
    session_id text NOT NULL,
    token text NOT NULL,
    expires_at bigint NOT NULL,
    holder text,
    acquired_at bigint
);
CREATE TABLE public.session_llm_requests (
    id text NOT NULL,
    session_id text NOT NULL,
    turn_seq integer,
    step integer NOT NULL,
    model text NOT NULL,
    scope_label text NOT NULL,
    request text,
    truncated boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    ttft_ms integer,
    duration_ms integer,
    step_gap_ms integer,
    tool_wall_json text,
    usage_json text,
    transport_json text,
    gap_phases_json text,
    prompt_hash text
);
CREATE TABLE public.session_pins (
    id text NOT NULL,
    session_id text NOT NULL,
    text text,
    entry_seq integer,
    added_by text NOT NULL,
    created_at bigint NOT NULL
);
CREATE TABLE public.session_spend_days (
    day bigint NOT NULL,
    rows jsonb NOT NULL,
    updated_at bigint NOT NULL
);
CREATE TABLE public.session_spend_dirty (
    day bigint,
    session_id text,
    writer xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT session_spend_dirty_check CHECK ((num_nonnulls(day, session_id) = 1))
);
CREATE TABLE public.sessions (
    id text NOT NULL,
    type text NOT NULL,
    scope_id text NOT NULL,
    thread_ref text NOT NULL,
    created_at bigint NOT NULL,
    title text,
    channel_name text,
    surface text,
    last_activity bigint,
    messages integer,
    turns integer,
    forked_from_session_id text,
    forked_from_title text,
    fork_boundary_seq integer,
    origin text,
    origin_id text,
    parent_session_id text,
    spawn_meta text,
    first_user_preview text,
    last_user_preview text,
    client_tools jsonb
)
WITH (fillfactor='70');
CREATE TABLE public.tool_calls (
    run_id text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    call_index integer NOT NULL,
    output text NOT NULL,
    created_at bigint NOT NULL
);
ALTER TABLE ONLY public.runs ALTER COLUMN seq SET DEFAULT nextval('public.runs_seq_seq'::regclass);
INSERT INTO public.legacy_tape_steps_progress VALUES (true, NULL, NULL, false, 0, 0, 0, 0, 0);
INSERT INTO public.qm_schema_migrations VALUES ('directory/store/0001', 'c47a45848f9d225ff601c9df13dc272349c7df7525e7e2417f33d68be7672cc1', '2026-11-06 18:50:55.628835+00');
INSERT INTO public.qm_schema_migrations VALUES ('directory/store/0002', '4da6cc4f2496dd53d6381faea3f9f8e16e55394cfe46de516a692ede8157e8b0', '2026-11-06 18:50:55.642947+00');
INSERT INTO public.qm_schema_migrations VALUES ('directory/store/0003', '1aaf42502793ebc31b253b12903cf192d2d8d6bcc9e4c1d31e834ed385f2a030', '2026-11-06 18:50:55.645924+00');
INSERT INTO public.qm_schema_migrations VALUES ('directory/store/0004', '5376eae39ee0e8d99157e30b6edfbe8b35a0a0998bc4766a86529a45c0e83c4d', '2026-11-06 18:50:55.651328+00');
INSERT INTO public.qm_schema_migrations VALUES ('directory/store/0005', '38afbb8d963f48be05d5837f7f06e9f531229316c973c5f87eaa790e2611a8d9', '2026-11-06 18:50:55.653897+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0001', '07a121d0fa4e8ae4049e0574939dbf938c8615dc39ce29b74805a7e8ccb4ad0f', '2026-11-06 18:50:55.656489+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0002', 'c0fc23238fbe0ace56a28278bcb6cadfb100eb2c24ee83ce873588d466930270', '2026-11-06 18:50:55.66443+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0003', '8594c46c02ee90d43292a4c083fedea6c72d93b5f414f75e9e20d2db51b1b595', '2026-11-06 18:50:55.668149+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0004', '287116e5f86a67157788d505fecb2ea319974509b5ce35df6febfc8b9f059d6b', '2026-11-06 18:50:55.670524+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0004-subagent-returns', '390cf57f79622a535c61b02f59c3727d49d7bc51ac7710da184a24352415ad52', '2026-11-06 18:50:55.672848+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0005-session-history', '98df79620c5dfbedcc8b3b1ea38ada86d7948a0fd2fb6f9f8646c2c826b30612', '2026-11-06 18:50:55.68529+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0006-terminal-finished', 'c1b9fac31ffd7f3e0e19ae28007a3a0870f64ba04c1c6b608153dcc262970920', '2026-11-06 18:50:55.691109+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0007-last-stop', '3112c3322da219fd1be29ff632b726a529864794f3659846e320cf6ba54cbe56', '2026-11-06 18:50:55.692525+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0008-claim-priority', 'd67a00e019c5343ea8a03ec0b1e851f714de191cd8f1ba404263665105ba61ad', '2026-11-06 18:50:55.694616+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0009-claim-priority-index', '9922f90b6cea5da7af6ad0cbff5b718cd741c68260a2420abdb2889f441ef8ef', '2026-11-06 18:50:55.701244+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0001', 'cf56c9f6488806677a229698193ef6dd7cb74300c343bdb1930c17702c5ccf2f', '2026-11-06 18:50:55.702433+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0002', 'ca9877865861adf81cfb433750327462aedcfa1e60d4e87a7845d1a77f64c2ec', '2026-11-06 18:50:55.715025+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0003', 'fd77efdccf169dee81da809a54313be30a0aaf92cdea4f6c33e34555bb2396c8', '2026-11-06 18:50:55.718283+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0004', '856cc6940c934b59e37d511271630f77d72b235c92ab0e2e2085207d15750a75', '2026-11-06 18:50:55.720387+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0005', '4b0824aa4311df8c66b57b16f331e9dcf3dfc8d11c112a000d83f46b1fba1bd0', '2026-11-06 18:50:55.723099+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0006', '57037691db0c87e9eeb28927758ae35e426eb8a8b7f7b5b8440bb08817f39203', '2026-11-06 18:50:55.724945+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0007', '8322f0c560da60399baf59f0364e8125e836384cd8b4d9795bd1c114d4d7d514', '2026-11-06 18:50:55.728463+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0008', '4b32bec77fa021de97736856a70a45bf1e51e59e574987e0d044fe748ec4cf58', '2026-11-06 18:50:55.73036+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0009', '40558264e0589a236a8a5a688a42eb49acf8a774371b9e1c6a3e5e0a84065c7d', '2026-11-06 18:50:55.732462+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0010', '29832445f9d3bfaf0d97f11b2748a1ca533ff57c6f4bd96c594e83a6ab4f7c9a', '2026-11-06 18:50:55.734975+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0011', 'be590472124ab471453cfbbd7d3c1a0c57f792c97704707fba3682f4183f870d', '2026-11-06 18:50:55.7372+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0012', '6f52591c733daffdda7aca112ad5a21cfec5c0c36f97838d74b107a79b7100bf', '2026-11-06 18:50:55.739332+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0013', '86c8d0eff24f8f2deab4f33eccff6d0206b3a9a64943a812eec0965203dd5262', '2026-11-06 18:50:55.741455+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0014-search-write-through-v1', 'e91226e6e5897b86e296c43e75a3f8d00633a1a7752a46c4c9f7cabf44f3b747', '2026-11-06 18:50:55.750888+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0015-search-backfill-v1', '3f942dd9aefb26588756cd936f73e08704df8071454b1f3d6fba7fe41f373864', '2026-11-06 18:50:55.753298+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0016-status', '89fbf5684830326730fdbde5f2de9cea69dcc1661a5f9e17e897232d5d74c9b4', '2026-11-06 18:50:55.755615+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0016-tape-source-role', '2725fb5df8e2a82fe5936486e45e7f999bd0606cf3355d6bfbb01296d17374f7', '2026-11-06 18:50:55.757442+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0017-subagent-parentage', '46f54668e4e535b7e891170e85453eaa4ccb4f923f2fc666d0376967efa5295a', '2026-11-06 18:50:55.759331+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0017-transcript-entries', '828dfba948c6272dd747748c04ad777a0f84f5fde23d0b803fa5bf28872a6ef7', '2026-11-06 18:50:55.76178+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0018-llm-requests-created-at', '0f550cd1401ea9f6dc7d62c7d154e4a8a4624e8fb27d10e75ed2bc000a54f5e7', '2026-11-06 18:50:55.764295+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0019-participant-activity-indexes', '4bd9bfdadffe0d2c4de382feacce65c06987f061df940eecc7991699b1249348', '2026-11-06 18:50:55.774463+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0020-spend-usage-json', 'febf07cde8b9ffe09a497d44a0e524a5c994f7708a0fab6d245315e4ab1e717a', '2026-11-06 18:50:55.775937+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0020-spend-usage-json-size', '4f34eed7d24be1ea5e81263d9eb4dafa4a5c54da709332feb38b2f6fab6f7025', '2026-11-06 18:50:55.777843+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0020-spend-usage-json-size-plpgsql', '1d69838eefe8377d3f8010707c0ce816bafd340b3d9da3c0cc15bb4fad038e16', '2026-11-06 18:50:55.779802+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0021-spend-covering-index', 'e11f84353f7637fff2ccb5bf9aa54de9a9fe1494cd8181adf52676edf0bf8f5a', '2026-11-06 18:50:55.790433+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0022-spend-days', '66bddbc128d3257accf4501d5f2890a9cddf8b9ae5287b38dacabdaa4005bdad', '2026-11-06 18:50:55.792123+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0023-spend-days-backfill', '8c5baecc5ec81cf33f24c53c58bb6d93f7589458a4bd442ab67a19fa783398ca', '2026-11-06 18:50:55.796575+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0024-user-previews', 'ca1d0192587bdc5d07690988e7767c2d79d0f3ee8a1627fffcac24499d74df47', '2026-11-06 18:50:55.798907+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0025-org-activity-index', '00366567fac31a93877a9373dd7613084091565a4933372068d9d5fce9d9f4a1', '2026-11-06 18:50:55.806138+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0026-participant-read-at', 'a3949603eac7d7fb64dba0852a23b4ee7468717875774144e5d74d852e49418e', '2026-11-06 18:50:55.807778+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0027-agent-reply-index', '65af103073ef18b66547651fc007e4f1b704a98126e6974eea121ca877f1e090', '2026-11-06 18:50:55.815092+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0028-drop-run-tasks', '5aa0a3c8a071fffcddb859cdab12735dd331c97d3258da4807152b64e503ae22', '2026-11-06 18:50:55.816575+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0029-legacy-tape-steps', 'a103ebb697c0d2cdf4a843791127955ff6c42729ca1ba5880446e02aa24e7235', '2026-11-06 18:50:55.819218+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0030-legacy-tape-steps-size-guard', '3b7f668e1acedcda4613ba41110f62932b404ba93884c829aa209d744a7a12c8', '2026-11-06 18:50:55.825027+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0031-drop-session-tape', '3100b33fe1e55d5abe05f50b655f3ff73142e3608af3616ba4954209b5f42e5b', '2026-11-06 18:50:55.829977+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0032-session-goals', '67b3486e1426f893bfbf64fb5412083ca30a2287038afc358793c5222171dd2c', '2026-11-06 18:50:55.834252+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0033-client-tools', '3d46f3d967516132f7f67d0ce5ee46127a9a46761ad9d143aba12db374b293aa', '2026-11-06 18:50:55.837361+00');
SELECT pg_catalog.setval('public.runs_seq_seq', 1, false);
ALTER TABLE ONLY public.directory_channel_members
    ADD CONSTRAINT directory_channel_members_pkey PRIMARY KEY (org_id, channel_id, principal_id);
ALTER TABLE ONLY public.directory_channels
    ADD CONSTRAINT directory_channels_pkey PRIMARY KEY (org_id, channel_id);
ALTER TABLE ONLY public.directory_group_members
    ADD CONSTRAINT directory_group_members_pkey PRIMARY KEY (org_id, group_id, principal_id);
ALTER TABLE ONLY public.directory_groups
    ADD CONSTRAINT directory_groups_pkey PRIMARY KEY (org_id, group_id);
ALTER TABLE ONLY public.directory_members
    ADD CONSTRAINT directory_members_pkey PRIMARY KEY (org_id, principal_id);
ALTER TABLE ONLY public.directory_meta
    ADD CONSTRAINT directory_meta_pkey PRIMARY KEY (org_id);
ALTER TABLE ONLY public.directory_sync
    ADD CONSTRAINT directory_sync_pkey PRIMARY KEY (org_id);
ALTER TABLE ONLY public.legacy_tape_skipped
    ADD CONSTRAINT legacy_tape_skipped_pkey PRIMARY KEY (session_id);
ALTER TABLE ONLY public.legacy_tape_steps
    ADD CONSTRAINT legacy_tape_steps_pkey PRIMARY KEY (session_id, seq);
ALTER TABLE ONLY public.legacy_tape_steps_progress
    ADD CONSTRAINT legacy_tape_steps_progress_pkey PRIMARY KEY (singleton);
ALTER TABLE ONLY public.legacy_turn_runs
    ADD CONSTRAINT legacy_turn_runs_pkey PRIMARY KEY (session_id, seq);
ALTER TABLE ONLY public.llm_prompt_envelopes
    ADD CONSTRAINT llm_prompt_envelopes_pkey PRIMARY KEY (hash);
ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_pkey PRIMARY KEY (session_id, principal_id);
ALTER TABLE ONLY public.qm_schema_migrations
    ADD CONSTRAINT qm_schema_migrations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_idempotency_key_key UNIQUE (idempotency_key);
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.session_entries
    ADD CONSTRAINT session_entries_pkey PRIMARY KEY (session_id, seq);
ALTER TABLE ONLY public.session_entry_search
    ADD CONSTRAINT session_entry_search_pkey PRIMARY KEY (session_id, seq);
ALTER TABLE ONLY public.session_goals
    ADD CONSTRAINT session_goals_pkey PRIMARY KEY (session_id);
ALTER TABLE ONLY public.session_leases
    ADD CONSTRAINT session_leases_pkey PRIMARY KEY (session_id);
ALTER TABLE ONLY public.session_llm_requests
    ADD CONSTRAINT session_llm_requests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.session_pins
    ADD CONSTRAINT session_pins_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.session_spend_days
    ADD CONSTRAINT session_spend_days_pkey PRIMARY KEY (day);
ALTER TABLE ONLY public.session_spend_dirty
    ADD CONSTRAINT session_spend_dirty_day_writer_key UNIQUE (day, writer);
ALTER TABLE public.sessions
    ADD CONSTRAINT sessions_fork_provenance_pair CHECK (((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL))) NOT VALID;
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_thread_ref_key UNIQUE (thread_ref);
ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_pkey PRIMARY KEY (run_id, attempt, call_index);
CREATE INDEX directory_channels_lower_cid ON public.directory_channels USING btree (org_id, lower(channel_id));
CREATE INDEX directory_channels_name ON public.directory_channels USING btree (org_id, name_lc);
CREATE INDEX directory_group_members_principal ON public.directory_group_members USING btree (org_id, principal_id, group_id);
CREATE INDEX directory_members_lower_pid ON public.directory_members USING btree (org_id, lower(principal_id));
CREATE INDEX directory_members_name ON public.directory_members USING btree (org_id, display_name_lc);
CREATE INDEX idx_runs_created ON public.runs USING btree (created_at DESC);
CREATE UNIQUE INDEX idx_runs_one_running_per_session ON public.runs USING btree (session_id) WHERE (status = 'running'::text);
CREATE INDEX idx_runs_pending_child_returns ON public.runs USING btree (id) WHERE ((status = ANY (ARRAY['done'::text, 'failed'::text])) AND (returned_at IS NULL) AND (session_id ~~ 'agent:main:subagent:%'::text));
CREATE INDEX idx_runs_pending_priority ON public.runs USING btree (claim_priority, created_at, seq) WHERE (status = 'pending'::text);
CREATE INDEX idx_runs_session_active_created ON public.runs USING btree (session_id, created_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));
CREATE INDEX idx_runs_session_created_seq ON public.runs USING btree (session_id, created_at DESC, seq DESC);
CREATE INDEX idx_runs_status_created ON public.runs USING btree (status, created_at);
CREATE INDEX idx_runs_status_created_seq ON public.runs USING btree (status, created_at, seq);
CREATE INDEX idx_runs_terminal_finished ON public.runs USING btree (finished_at, id) WHERE (status = ANY (ARRAY['done'::text, 'failed'::text]));
CREATE INDEX idx_sessions_parent_session_id ON public.sessions USING btree (parent_session_id) WHERE (parent_session_id IS NOT NULL);
CREATE INDEX participants_by_principal ON public.participants USING btree (principal_id, session_id);
CREATE INDEX session_entries_agent_reply ON public.session_entries USING btree (session_id, created_at DESC) WHERE (type = ANY (ARRAY['assistant'::text, 'delivery'::text]));
CREATE INDEX session_entries_search_tsv ON public.session_entries USING gin (search_tsv) WHERE (type = ANY (ARRAY['user'::text, 'assistant'::text, 'text'::text]));
CREATE INDEX session_entries_session_created ON public.session_entries USING btree (session_id, created_at DESC);
CREATE INDEX session_entries_session_search_tsv ON public.session_entries USING gin (session_id, search_tsv) WHERE (type = ANY (ARRAY['user'::text, 'assistant'::text, 'text'::text]));
CREATE INDEX session_entries_user_activity ON public.session_entries USING btree (session_id, created_at DESC) WHERE (type = 'user'::text);
CREATE INDEX session_entries_user_attributed ON public.session_entries USING btree (session_id, created_at, seq) WHERE ((type = 'user'::text) AND ((payload IS NULL) OR (payload !~~ '%"overheard":true%'::text)));
CREATE INDEX session_entries_user_ts ON public.session_entries USING btree (created_at) WHERE (type = 'user'::text);
CREATE INDEX session_entry_search_session_tsv ON public.session_entry_search USING gin (session_id, search_tsv);
CREATE INDEX session_entry_search_tsv ON public.session_entry_search USING gin (search_tsv);
CREATE INDEX session_llm_requests_by_session ON public.session_llm_requests USING btree (session_id, created_at, step);
CREATE INDEX session_llm_requests_created_at ON public.session_llm_requests USING btree (created_at);
CREATE INDEX session_llm_requests_screens ON public.session_llm_requests USING btree (created_at DESC) WHERE (step = '-1'::integer);
CREATE INDEX session_llm_requests_spend ON public.session_llm_requests USING btree (created_at, (((public.spend_usage_json(usage_json) ->> 'costUsd'::text))::double precision), (((public.spend_usage_json(usage_json) ->> 'input'::text))::bigint), (((public.spend_usage_json(usage_json) ->> 'output'::text))::bigint), (((public.spend_usage_json(usage_json) ->> 'cacheRead'::text))::bigint), (((public.spend_usage_json(usage_json) ->> 'cacheWrite'::text))::bigint)) INCLUDE (session_id, model, usage_json) WHERE ((usage_json IS NOT NULL) AND ((public.spend_usage_json(usage_json) IS NOT NULL) AND (((octet_length(session_id) + octet_length(model)) + octet_length(usage_json)) <= 2000)));
CREATE INDEX session_llm_requests_spend_wide ON public.session_llm_requests USING btree (created_at) WHERE ((usage_json IS NOT NULL) AND (NOT ((public.spend_usage_json(usage_json) IS NOT NULL) AND (((octet_length(session_id) + octet_length(model)) + octet_length(usage_json)) <= 2000))));
CREATE INDEX session_pins_by_session ON public.session_pins USING btree (session_id, created_at);
CREATE INDEX sessions_by_activity ON public.sessions USING btree (COALESCE(last_activity, created_at) DESC, id DESC);
CREATE INDEX sessions_by_scope ON public.sessions USING btree (scope_id, created_at DESC);
CREATE INDEX sessions_by_scope_activity ON public.sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC);
CREATE TRIGGER session_entries_search_write_through AFTER INSERT OR DELETE OR UPDATE OF payload, type, created_at, session_id, seq ON public.session_entries FOR EACH ROW EXECUTE FUNCTION public.sync_session_entry_search();
CREATE TRIGGER session_llm_requests_spend_dirty AFTER INSERT OR DELETE OR UPDATE OF created_at, session_id, model, usage_json ON public.session_llm_requests FOR EACH ROW EXECUTE FUNCTION public.invalidate_request_spend();
CREATE TRIGGER sessions_spend_dirty AFTER INSERT OR DELETE OR UPDATE OF id, scope_id, origin, thread_ref, parent_session_id ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.invalidate_session_spend();
ALTER TABLE ONLY public.session_goals
    ADD CONSTRAINT session_goals_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;
