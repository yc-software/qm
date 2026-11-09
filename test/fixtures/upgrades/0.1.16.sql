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
CREATE TYPE public.item_kind AS ENUM (
    'UserMessage',
    'SteeringMessage',
    'AgentMessage',
    'Reasoning',
    'ToolCall',
    'ToolResult',
    'Elicitation',
    'ElicitationResponse',
    'Wake',
    'Error',
    'ContextCompaction',
    'Retraction',
    'Stop',
    'RuntimeChange'
);
CREATE TYPE public.wake_cause AS ENUM (
    'cron',
    'webhook',
    'child_done',
    'system'
);
CREATE FUNCTION public.forbid_direct_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
   BEGIN
     IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
     RAISE EXCEPTION 'DELETE on % is only allowed through its session', TG_TABLE_NAME
       USING ERRCODE = 'integrity_constraint_violation';
   END $$;
CREATE FUNCTION public.forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
   BEGIN
     RAISE EXCEPTION '% on % is forbidden', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
   END $$;
CREATE FUNCTION public.invalidate_request_spend() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
   BEGIN
     INSERT INTO session_spend_dirty(tenant_id, day)
     SELECT DISTINCT tenant, floor(at::numeric / 86400000)::bigint
       FROM (VALUES
         (CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.tenant_id END,
          CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.created_at END),
         (CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.tenant_id END,
          CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.created_at END)
       ) changed(tenant, at) WHERE at IS NOT NULL
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
     INSERT INTO session_spend_dirty(tenant_id, session_id)
     SELECT DISTINCT tenant, id FROM (VALUES (OLD.tenant_id, OLD.id), (NEW.tenant_id, NEW.id)) changed(tenant, id)
      WHERE id IS NOT NULL;
     RETURN NULL;
   END $$;
CREATE FUNCTION public.qm_bound_tenant() RETURNS uuid
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
DECLARE
  bound text := current_setting('qm.tenant_id', true);
  sole uuid;
BEGIN
  IF bound IS NULL OR bound = '' THEN
    SELECT tenant.sole INTO sole FROM qm_sole_tenant() tenant;
    IF sole IS NULL THEN
      RAISE insufficient_privilege USING MESSAGE = 'No tenant is bound to this query';
    END IF;
    RETURN sole;
  END IF;
  RETURN bound::uuid;
END $$;
CREATE FUNCTION public.qm_host_tenant(requested text) RETURNS TABLE(tenant_id uuid, multi boolean, retired boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
      SELECT (SELECT h.tenant_id FROM tenant_hosts h WHERE h.host = lower(requested)),
        EXISTS (SELECT 1 FROM tenant_hosts) OR EXISTS (SELECT 1 FROM retired_tenant_hosts),
        EXISTS (SELECT 1 FROM retired_tenant_hosts r WHERE r.host = lower(requested))
    $$;
CREATE FUNCTION public.qm_retire_tenant_hosts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
      BEGIN
        INSERT INTO retired_tenant_hosts(host) SELECT h.host FROM tenant_hosts h WHERE h.tenant_id = OLD.id
          ON CONFLICT (host) DO NOTHING;
        RETURN OLD;
      END
    $$;
CREATE FUNCTION public.qm_sole_tenant(OUT sole uuid, OUT tenants bigint) RETURNS record
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
       SELECT CASE WHEN count(*) = 1 THEN min(id::text)::uuid END, count(*) FROM tenants
     $$;
CREATE FUNCTION public.qm_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$ SELECT id FROM qm_tenant $$;
CREATE FUNCTION public.qm_tenant_settings() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
      SELECT settings FROM tenants WHERE id = qm_bound_tenant()
    $$;
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
SET default_tablespace = '';
SET default_table_access_method = heap;
CREATE TABLE public.blobs (
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    sha256 bytea NOT NULL,
    size bigint NOT NULL,
    mime text,
    storage_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT blobs_sha256_check CHECK ((length(sha256) = 32)),
    CONSTRAINT blobs_size_check CHECK ((size >= 0)),
    CONSTRAINT blobs_storage_key_check CHECK ((storage_key <> ''::text))
);
CREATE TABLE public.directory_channel_members (
    org_id text NOT NULL,
    channel_id text NOT NULL,
    principal_id text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.directory_channels (
    org_id text NOT NULL,
    channel_id text NOT NULL,
    name text NOT NULL,
    name_lc text NOT NULL,
    is_private boolean DEFAULT false NOT NULL,
    is_external boolean DEFAULT false NOT NULL,
    roster_known boolean DEFAULT false NOT NULL,
    observed_at bigint,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.directory_group_members (
    org_id text NOT NULL,
    group_id text NOT NULL,
    principal_id text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.directory_groups (
    org_id text NOT NULL,
    group_id text NOT NULL,
    roster_known boolean DEFAULT false NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.directory_members (
    org_id text NOT NULL,
    principal_id text NOT NULL,
    display_name text NOT NULL,
    display_name_lc text NOT NULL,
    type text NOT NULL,
    slack_id text,
    avatar_url text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.directory_meta (
    org_id text NOT NULL,
    workspace_url text,
    updated_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.directory_sync (
    org_id text NOT NULL,
    members_hash text,
    channels_hash text,
    groups_hash text,
    updated_at bigint NOT NULL,
    members_synced_at bigint,
    channels_synced_at bigint,
    groups_synced_at bigint,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.items (
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    session_id text NOT NULL,
    seq bigint NOT NULL,
    turn_id uuid,
    kind public.item_kind NOT NULL,
    author text,
    call_id text,
    elicit_id text,
    wake_cause public.wake_cause,
    error_code text,
    text text,
    tool text,
    step integer,
    variant text,
    is_error boolean,
    hidden boolean,
    external_id text,
    through_seq bigint,
    approved boolean,
    blob_sha bytea,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(text, ''::text))) STORED,
    body jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT items_approved_kind CHECK (((approved IS NULL) OR (kind = 'ElicitationResponse'::public.item_kind))),
    CONSTRAINT items_author_check CHECK ((author <> ''::text)),
    CONSTRAINT items_author_kind CHECK (((author IS NULL) OR (kind = ANY (ARRAY['UserMessage'::public.item_kind, 'SteeringMessage'::public.item_kind, 'ElicitationResponse'::public.item_kind, 'Stop'::public.item_kind, 'RuntimeChange'::public.item_kind])))),
    CONSTRAINT items_blob_sha_kind CHECK (((blob_sha IS NULL) OR (kind = 'ToolResult'::public.item_kind))),
    CONSTRAINT items_body_check CHECK ((jsonb_typeof(body) = 'object'::text)),
    CONSTRAINT items_call_id_check CHECK ((call_id <> ''::text)),
    CONSTRAINT items_call_id_kind CHECK (((call_id IS NULL) OR (kind = ANY (ARRAY['ToolCall'::public.item_kind, 'ToolResult'::public.item_kind])))),
    CONSTRAINT items_elicit_id_check CHECK ((elicit_id <> ''::text)),
    CONSTRAINT items_elicit_id_kind CHECK (((elicit_id IS NOT NULL) = (kind = ANY (ARRAY['Elicitation'::public.item_kind, 'ElicitationResponse'::public.item_kind])))),
    CONSTRAINT items_error_code_check CHECK ((error_code <> ''::text)),
    CONSTRAINT items_error_code_kind CHECK (((error_code IS NOT NULL) = (kind = 'Error'::public.item_kind))),
    CONSTRAINT items_external_id_check CHECK ((external_id <> ''::text)),
    CONSTRAINT items_external_id_kind CHECK (((external_id IS NULL) OR (kind = 'UserMessage'::public.item_kind))),
    CONSTRAINT items_hidden_kind CHECK (((hidden IS NULL) OR (kind = 'UserMessage'::public.item_kind))),
    CONSTRAINT items_is_error_kind CHECK (((is_error IS NULL) OR (kind = 'ToolResult'::public.item_kind))),
    CONSTRAINT items_seq_check CHECK ((seq >= 0)),
    CONSTRAINT items_step_check CHECK ((step >= 0)),
    CONSTRAINT items_step_kind CHECK (((step IS NULL) OR (kind = ANY (ARRAY['ToolCall'::public.item_kind, 'ToolResult'::public.item_kind, 'Reasoning'::public.item_kind, 'AgentMessage'::public.item_kind])))),
    CONSTRAINT items_text_check CHECK ((text <> ''::text)),
    CONSTRAINT items_text_kind CHECK (((text IS NULL) OR (kind = ANY (ARRAY['UserMessage'::public.item_kind, 'SteeringMessage'::public.item_kind, 'AgentMessage'::public.item_kind, 'Reasoning'::public.item_kind, 'ToolResult'::public.item_kind, 'Error'::public.item_kind, 'ContextCompaction'::public.item_kind])))),
    CONSTRAINT items_through_seq_kind CHECK (((through_seq IS NULL) OR (kind = 'ContextCompaction'::public.item_kind))),
    CONSTRAINT items_tool_check CHECK ((tool <> ''::text)),
    CONSTRAINT items_tool_kind CHECK (((tool IS NULL) OR (kind = ANY (ARRAY['ToolCall'::public.item_kind, 'ToolResult'::public.item_kind])))),
    CONSTRAINT items_variant_check CHECK ((variant = ANY (ARRAY['narration'::text, 'files_delivered'::text]))),
    CONSTRAINT items_variant_kind CHECK (((variant IS NULL) OR (kind = 'AgentMessage'::public.item_kind))),
    CONSTRAINT items_wake_cause_kind CHECK (((wake_cause IS NOT NULL) = (kind = 'Wake'::public.item_kind)))
);
CREATE TABLE public.llm_prompt_envelopes (
    hash text NOT NULL,
    body text NOT NULL,
    created_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.participants (
    session_id text NOT NULL,
    principal_id text NOT NULL,
    valid_from bigint DEFAULT 0 NOT NULL,
    valid_to bigint,
    valid_from_seq integer DEFAULT 0,
    valid_to_seq integer,
    title text,
    archived boolean DEFAULT false NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    color text,
    read_at bigint,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.qm_schema_migrations (
    id text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.qm_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.qm_tenant (
    id uuid NOT NULL
);
CREATE TABLE public.retired_tenant_hosts (
    host text NOT NULL,
    retired_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retired_tenant_hosts_host_check CHECK (((host = lower(host)) AND (host <> ''::text)))
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
    preemptions integer DEFAULT 0 NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE SEQUENCE public.runs_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.runs_seq_seq OWNED BY public.runs.seq;
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
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT session_goals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'complete'::text, 'cancelled'::text])))
);
CREATE TABLE public.session_leases (
    session_id text NOT NULL,
    token text NOT NULL,
    expires_at bigint NOT NULL,
    holder text,
    acquired_at bigint,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.session_llm_requests (
    id text NOT NULL,
    session_id text NOT NULL,
    turn_seq integer,
    step integer NOT NULL,
    model text NOT NULL,
    scope_label text NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    ttft_ms integer,
    duration_ms integer,
    step_gap_ms integer,
    tool_wall_json text,
    usage_json text,
    transport_json text,
    gap_phases_json text,
    prompt_hash text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.session_pins (
    id text NOT NULL,
    session_id text NOT NULL,
    text text,
    entry_seq integer,
    added_by text NOT NULL,
    created_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.session_spend_days (
    day bigint NOT NULL,
    rows jsonb NOT NULL,
    updated_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);
CREATE TABLE public.session_spend_dirty (
    day bigint,
    session_id text,
    writer xid8 DEFAULT pg_current_xact_id() NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
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
    client_tools jsonb,
    last_user_activity bigint,
    side_chat jsonb,
    slack_binding jsonb,
    runtime jsonb,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT sessions_fork_provenance_pair CHECK (((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL)))
)
WITH (fillfactor='70');
CREATE TABLE public.tenant_hosts (
    host text NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_hosts_host_check CHECK (((host = lower(host)) AND (host <> ''::text)))
);
CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT tenants_settings_check CHECK ((jsonb_typeof(settings) = 'object'::text))
);
ALTER TABLE ONLY public.runs ALTER COLUMN seq SET DEFAULT nextval('public.runs_seq_seq'::regclass);
INSERT INTO public.qm_schema_migrations VALUES ('0000-tenancy/base', 'a8d92d4e6edcca2b8e2e0635347c2bcbc549dc2826def55a9af0afe4bdeea70b', '2026-11-09 21:16:27.463974+00');
INSERT INTO public.qm_schema_migrations VALUES ('0000-tenancy/sole-tenant', '7905025bbf4b0062e0694b4c91f9872e6ac97a694dac65dec579b0104fce6f24', '2026-11-09 21:16:27.470273+00');
INSERT INTO public.qm_schema_migrations VALUES ('0000-tenancy/sole-tenant-search-path', 'd58bb3de5c31432bff3c79cbbb95a154e6bb773c9b074cd174061475197666cf', '2026-11-09 21:16:27.474048+00');
INSERT INTO public.qm_schema_migrations VALUES ('0000-tenancy/unbound-sole-tenant', '3015703fe1161ae34c14142f25c125017c516ffac4efe11f70249d5f5750f277', '2026-11-09 21:16:27.477112+00');
INSERT INTO public.qm_schema_migrations VALUES ('0001-tenancy/hosts-and-settings', '2313feb6dca8bfa9ba419f353dc72d693aef84f22de7cd4ecf1eb127a6fa80c0', '2026-11-09 21:16:27.480224+00');
INSERT INTO public.qm_schema_migrations VALUES ('0001-tenancy/hosts-search-path', 'df39e37ea5acfab70ffa36507b1ea405f3a5b02311ebfeb15e1c9bc7a26ee30b', '2026-11-09 21:16:27.487867+00');
INSERT INTO public.qm_schema_migrations VALUES ('0001-tenancy/retired-hosts', 'cf7c13a450c2964a8ad1b6d0402f7dad449b8c872e97ba9993d77af5691268c2', '2026-11-09 21:16:27.491216+00');
INSERT INTO public.qm_schema_migrations VALUES ('0001-tenancy/tenant-row-security', '4091f31ff00a2cbe54944dd5af102622116bf96de4f91697079229dbdcc89516', '2026-11-09 21:16:27.49829+00');
INSERT INTO public.qm_schema_migrations VALUES ('directory/store/0006-base-schema', 'e8dcd5c2a3a8fcba7b1c14db1d1aceb57ca7ef6e1c7366ace6df65043f731198', '2026-11-09 21:16:27.505982+00');
INSERT INTO public.qm_schema_migrations VALUES ('directory/store/0006-tenants', 'a8aba57e368b6642c4843311a61a7933b09f4dd030eac4b771d951e0633b401a', '2026-11-09 21:16:27.52125+00');
INSERT INTO public.qm_schema_migrations VALUES ('directory/store/0006-tenants-lookups', 'fb0824d7f55c9b6c4822ed3f1a9566a6d6a230a11e95ff0c840cf4506d846f40', '2026-11-09 21:16:27.653999+00');
INSERT INTO public.qm_schema_migrations VALUES ('directory/store/0006-tenants-swap', '743623ba605c535d6b7c23a0e049d03e5a77eac6eeade64e34a12d683975e04d', '2026-11-09 21:16:27.656595+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0011-base-schema', '77ca2d1c3ec5253374c0eadbf47d91d53c6d2c3fc7232079b33006bc9233a24e', '2026-11-09 21:16:27.668249+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0012-tenants', 'a7d063bc5d1b00a1a9bd7131bbebf9305e9ff60e8a1e51cfff32c0c6da4b375d', '2026-11-09 21:16:27.680227+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0012-tenants-lookups', '6f5143e98460c4b164aa28ab6b5e2c429803a005fafba6ac641503e5fd31e687', '2026-11-09 21:16:27.737219+00');
INSERT INTO public.qm_schema_migrations VALUES ('runs/store/0012-tenants-swap', '1ea89263a9cabdf39ebce593a7d9ba7ea417928c384923121efaade449ea4a1a', '2026-11-09 21:16:27.739627+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0047-base-schema', '09cc3da1e893709927f3a18d593d543289d9d92dc416c56f426e3a5d69957099', '2026-11-09 21:16:27.744671+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0048-message-search-index', 'f1996db3a8774e9c0b1e7dc35ecc70b2cfb1d64e8923225e40cdfc351a0b9cf4', '2026-11-09 21:16:27.810133+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0049-drop-items-search', '0d987ff91662ce4509dfe4a31b7d3400ae5369ae3e3fbae1a31e30d223483c66', '2026-11-09 21:16:27.812627+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0049-seeded-tenant', '763c5b0f30c70d15ec4cd991c180f1630236dbcad611dc7347324a00a86a5d25', '2026-11-09 21:16:27.815808+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0050-tenant-backfill', '73f0b5440a2bccaefe16bbdc2d826e95bcf8da2e8af937c6c911c9f48e75a18e', '2026-11-09 21:16:27.81946+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0051-spend-recovery-index', '4afb2779caa4de04dbd6210f1bf1fda4ae52e6e3158294ce42ef1f9821f89c41', '2026-11-09 21:16:27.831447+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0052-session-facts', 'cc6b8210d1fb814301e48e051fb225e96e67a09827241f78d5ef31b5524d4784', '2026-11-09 21:16:27.834273+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0054-session-facts-copy', '233524866d2259689e40a9d9e95dfdc514981fe8e8dc3f3919293506e382b637', '2026-11-09 21:16:27.848539+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0054-tenant-tables', '2f5d1a5445a510d30e8bf931d897a6d0cb937eb0bdc5295c95f6fdc26fbe80d5', '2026-11-09 21:16:27.851109+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0054-tenant-tables-lookups', '0bd2437aed7c67ec7c3f546d3bcfdb4eef235f96c235c19a96809b7f8eb5afed', '2026-11-09 21:16:28.03951+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0054-tenant-tables-swap', '0f1c53116bc610a39a64133a776d499229f5341a9cd654444feefd31602353a9', '2026-11-09 21:16:28.041582+00');
INSERT INTO public.qm_schema_migrations VALUES ('sessions/store/0055-participant-membership', '3432fb84aca3eb8b5dcd9856cb8b8151428f5ccf7b1e5bf80fb75045f6841fc0', '2026-11-09 21:16:28.054807+00');
INSERT INTO public.qm_tenant VALUES ('cdf993bc-79b9-40f3-a33e-c1b623c68344');
INSERT INTO public.tenants VALUES ('cdf993bc-79b9-40f3-a33e-c1b623c68344', '2026-11-09 21:16:27.81946+00', '{}');
SELECT pg_catalog.setval('public.runs_seq_seq', 1, false);
ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (tenant_id, sha256);
ALTER TABLE ONLY public.directory_channel_members
    ADD CONSTRAINT directory_channel_members_pkey PRIMARY KEY (tenant_id, org_id, channel_id, principal_id);
ALTER TABLE ONLY public.directory_channels
    ADD CONSTRAINT directory_channels_pkey PRIMARY KEY (tenant_id, org_id, channel_id);
ALTER TABLE ONLY public.directory_group_members
    ADD CONSTRAINT directory_group_members_pkey PRIMARY KEY (tenant_id, org_id, group_id, principal_id);
ALTER TABLE ONLY public.directory_groups
    ADD CONSTRAINT directory_groups_pkey PRIMARY KEY (tenant_id, org_id, group_id);
ALTER TABLE ONLY public.directory_members
    ADD CONSTRAINT directory_members_pkey PRIMARY KEY (tenant_id, org_id, principal_id);
ALTER TABLE ONLY public.directory_meta
    ADD CONSTRAINT directory_meta_pkey PRIMARY KEY (tenant_id, org_id);
ALTER TABLE ONLY public.directory_sync
    ADD CONSTRAINT directory_sync_pkey PRIMARY KEY (tenant_id, org_id);
ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (tenant_id, session_id, seq);
ALTER TABLE ONLY public.llm_prompt_envelopes
    ADD CONSTRAINT llm_prompt_envelopes_pkey PRIMARY KEY (tenant_id, hash);
ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_pkey PRIMARY KEY (tenant_id, session_id, principal_id);
ALTER TABLE ONLY public.qm_schema_migrations
    ADD CONSTRAINT qm_schema_migrations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.qm_settings
    ADD CONSTRAINT qm_settings_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.qm_tenant
    ADD CONSTRAINT qm_tenant_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.retired_tenant_hosts
    ADD CONSTRAINT retired_tenant_hosts_pkey PRIMARY KEY (host);
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (tenant_id, id);
ALTER TABLE ONLY public.session_goals
    ADD CONSTRAINT session_goals_pkey PRIMARY KEY (tenant_id, session_id);
ALTER TABLE ONLY public.session_leases
    ADD CONSTRAINT session_leases_pkey PRIMARY KEY (tenant_id, session_id);
ALTER TABLE ONLY public.session_llm_requests
    ADD CONSTRAINT session_llm_requests_pkey PRIMARY KEY (tenant_id, id);
ALTER TABLE ONLY public.session_pins
    ADD CONSTRAINT session_pins_pkey PRIMARY KEY (tenant_id, id);
ALTER TABLE ONLY public.session_spend_days
    ADD CONSTRAINT session_spend_days_pkey PRIMARY KEY (tenant_id, day);
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (tenant_id, id);
ALTER TABLE ONLY public.tenant_hosts
    ADD CONSTRAINT tenant_hosts_pkey PRIMARY KEY (host);
ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);
CREATE INDEX directory_channel_members_key_lookup ON public.directory_channel_members USING btree (org_id, channel_id, principal_id);
CREATE INDEX directory_channels_key_lookup ON public.directory_channels USING btree (org_id, channel_id);
CREATE INDEX directory_channels_lower_cid ON public.directory_channels USING btree (org_id, lower(channel_id));
CREATE INDEX directory_channels_name ON public.directory_channels USING btree (org_id, name_lc);
CREATE INDEX directory_group_members_key_lookup ON public.directory_group_members USING btree (org_id, group_id, principal_id);
CREATE INDEX directory_group_members_principal ON public.directory_group_members USING btree (org_id, principal_id, group_id);
CREATE INDEX directory_groups_key_lookup ON public.directory_groups USING btree (org_id, group_id);
CREATE INDEX directory_members_key_lookup ON public.directory_members USING btree (org_id, principal_id);
CREATE INDEX directory_members_lower_pid ON public.directory_members USING btree (org_id, lower(principal_id));
CREATE INDEX directory_members_name ON public.directory_members USING btree (org_id, display_name_lc);
CREATE INDEX directory_meta_key_lookup ON public.directory_meta USING btree (org_id);
CREATE INDEX directory_sync_key_lookup ON public.directory_sync USING btree (org_id);
CREATE INDEX idx_runs_created ON public.runs USING btree (created_at DESC);
CREATE UNIQUE INDEX idx_runs_one_running_per_session ON public.runs USING btree (tenant_id, session_id) WHERE (status = 'running'::text);
CREATE INDEX idx_runs_one_running_per_session_lookup ON public.runs USING btree (session_id) WHERE (status = 'running'::text);
CREATE INDEX idx_runs_pending_child_returns ON public.runs USING btree (id) WHERE ((status = ANY (ARRAY['done'::text, 'failed'::text])) AND (returned_at IS NULL) AND (session_id ~~ 'agent:main:subagent:%'::text));
CREATE INDEX idx_runs_pending_priority ON public.runs USING btree (claim_priority, created_at, seq) WHERE (status = 'pending'::text);
CREATE INDEX idx_runs_session_active_created ON public.runs USING btree (session_id, created_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));
CREATE INDEX idx_runs_session_created_seq ON public.runs USING btree (session_id, created_at DESC, seq DESC);
CREATE INDEX idx_runs_status_created ON public.runs USING btree (status, created_at);
CREATE INDEX idx_runs_status_created_seq ON public.runs USING btree (status, created_at, seq);
CREATE INDEX idx_runs_terminal_finished ON public.runs USING btree (finished_at, id) WHERE (status = ANY (ARRAY['done'::text, 'failed'::text]));
CREATE INDEX idx_sessions_parent_session_id ON public.sessions USING btree (parent_session_id) WHERE (parent_session_id IS NOT NULL);
CREATE INDEX items_by_elicit ON public.items USING btree (tenant_id, session_id, elicit_id) WHERE (elicit_id IS NOT NULL);
CREATE INDEX items_by_external_id ON public.items USING btree (tenant_id, session_id, external_id) WHERE (external_id IS NOT NULL);
CREATE INDEX items_by_turn ON public.items USING btree (tenant_id, turn_id, seq) WHERE (turn_id IS NOT NULL);
CREATE INDEX items_message_search ON public.items USING gin (tenant_id, search) WHERE ((kind = ANY (ARRAY['UserMessage'::public.item_kind, 'SteeringMessage'::public.item_kind, 'AgentMessage'::public.item_kind])) AND (variant IS DISTINCT FROM 'files_delivered'::text) AND (text IS NOT NULL));
CREATE UNIQUE INDEX items_one_call_per_kind ON public.items USING btree (tenant_id, session_id, kind, md5(call_id)) WHERE (call_id IS NOT NULL);
CREATE INDEX items_session_kind_created ON public.items USING btree (tenant_id, session_id, kind, created_at);
CREATE INDEX llm_prompt_envelopes_created_at ON public.llm_prompt_envelopes USING btree (created_at);
CREATE INDEX llm_prompt_envelopes_key_lookup ON public.llm_prompt_envelopes USING btree (hash);
CREATE INDEX participants_by_principal ON public.participants USING btree (principal_id, session_id);
CREATE INDEX participants_key_lookup ON public.participants USING btree (session_id, principal_id);
CREATE UNIQUE INDEX qm_tenant_singleton ON public.qm_tenant USING btree ((true));
CREATE UNIQUE INDEX runs_idempotency_key_key ON public.runs USING btree (tenant_id, idempotency_key);
CREATE INDEX runs_idempotency_key_key_lookup ON public.runs USING btree (idempotency_key);
CREATE INDEX runs_key_lookup ON public.runs USING btree (id);
CREATE INDEX session_goals_key_lookup ON public.session_goals USING btree (session_id);
CREATE INDEX session_leases_key_lookup ON public.session_leases USING btree (session_id);
CREATE INDEX session_llm_requests_by_session ON public.session_llm_requests USING btree (session_id, created_at, step);
CREATE INDEX session_llm_requests_created_at ON public.session_llm_requests USING btree (created_at);
CREATE INDEX session_llm_requests_key_lookup ON public.session_llm_requests USING btree (id);
CREATE INDEX session_llm_requests_screens ON public.session_llm_requests USING btree (created_at DESC) WHERE (step = '-1'::integer);
CREATE INDEX session_llm_requests_session_spend_recovery ON public.session_llm_requests USING btree (session_id, created_at) WHERE (usage_json IS NOT NULL);
CREATE INDEX session_llm_requests_spend ON public.session_llm_requests USING btree (created_at, (((public.spend_usage_json(usage_json) ->> 'costUsd'::text))::double precision), (((public.spend_usage_json(usage_json) ->> 'input'::text))::bigint), (((public.spend_usage_json(usage_json) ->> 'output'::text))::bigint), (((public.spend_usage_json(usage_json) ->> 'cacheRead'::text))::bigint), (((public.spend_usage_json(usage_json) ->> 'cacheWrite'::text))::bigint)) INCLUDE (session_id, model, usage_json) WHERE ((usage_json IS NOT NULL) AND ((public.spend_usage_json(usage_json) IS NOT NULL) AND (((octet_length(session_id) + octet_length(model)) + octet_length(usage_json)) <= 2000)));
CREATE INDEX session_llm_requests_spend_wide ON public.session_llm_requests USING btree (created_at) WHERE ((usage_json IS NOT NULL) AND (NOT ((public.spend_usage_json(usage_json) IS NOT NULL) AND (((octet_length(session_id) + octet_length(model)) + octet_length(usage_json)) <= 2000))));
CREATE INDEX session_pins_by_session ON public.session_pins USING btree (session_id, created_at);
CREATE INDEX session_pins_key_lookup ON public.session_pins USING btree (id);
CREATE INDEX session_spend_days_key_lookup ON public.session_spend_days USING btree (day);
CREATE UNIQUE INDEX session_spend_dirty_day_writer_key ON public.session_spend_dirty USING btree (tenant_id, day, writer);
CREATE INDEX session_spend_dirty_day_writer_key_lookup ON public.session_spend_dirty USING btree (day, writer);
CREATE INDEX sessions_by_activity ON public.sessions USING btree (COALESCE(last_activity, created_at) DESC, id DESC);
CREATE INDEX sessions_by_scope ON public.sessions USING btree (scope_id, created_at DESC);
CREATE INDEX sessions_by_scope_activity ON public.sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC);
CREATE INDEX sessions_conversations_by_scope_activity ON public.sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC) WHERE (origin = 'conversation'::text);
CREATE INDEX sessions_key_lookup ON public.sessions USING btree (id);
CREATE INDEX sessions_other_background_by_scope_activity ON public.sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC) WHERE (origin <> ALL (ARRAY['conversation'::text, 'cron'::text]));
CREATE INDEX sessions_side_chat_origin ON public.sessions USING btree (forked_from_session_id) WHERE (side_chat IS NOT NULL);
CREATE UNIQUE INDEX sessions_thread_ref_key ON public.sessions USING btree (tenant_id, thread_ref);
CREATE INDEX sessions_thread_ref_key_lookup ON public.sessions USING btree (thread_ref);
CREATE INDEX tenant_hosts_tenant ON public.tenant_hosts USING btree (tenant_id);
CREATE TRIGGER blobs_immutable BEFORE DELETE OR UPDATE ON public.blobs FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER blobs_no_truncate BEFORE TRUNCATE ON public.blobs FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER items_append_only BEFORE UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER items_delete_through_session BEFORE DELETE ON public.items FOR EACH ROW EXECUTE FUNCTION public.forbid_direct_delete();
CREATE TRIGGER items_no_truncate BEFORE TRUNCATE ON public.items FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER session_llm_requests_spend_dirty AFTER INSERT OR DELETE OR UPDATE OF created_at, session_id, model, usage_json ON public.session_llm_requests FOR EACH ROW EXECUTE FUNCTION public.invalidate_request_spend();
CREATE TRIGGER sessions_spend_dirty AFTER INSERT OR DELETE OR UPDATE OF id, scope_id, origin, thread_ref, parent_session_id ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.invalidate_session_spend();
CREATE TRIGGER tenants_retire_hosts BEFORE DELETE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.qm_retire_tenant_hosts();
ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.directory_channel_members
    ADD CONSTRAINT directory_channel_members_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.directory_channels
    ADD CONSTRAINT directory_channels_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.directory_group_members
    ADD CONSTRAINT directory_group_members_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.directory_groups
    ADD CONSTRAINT directory_groups_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.directory_members
    ADD CONSTRAINT directory_members_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.directory_meta
    ADD CONSTRAINT directory_meta_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.directory_sync
    ADD CONSTRAINT directory_sync_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_blob FOREIGN KEY (tenant_id, blob_sha) REFERENCES public.blobs(tenant_id, sha256);
ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_session_id_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES public.sessions(tenant_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.llm_prompt_envelopes
    ADD CONSTRAINT llm_prompt_envelopes_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.session_goals
    ADD CONSTRAINT session_goals_session_id_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES public.sessions(tenant_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE ONLY public.session_goals
    ADD CONSTRAINT session_goals_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.session_leases
    ADD CONSTRAINT session_leases_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.session_llm_requests
    ADD CONSTRAINT session_llm_requests_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.session_pins
    ADD CONSTRAINT session_pins_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.session_spend_days
    ADD CONSTRAINT session_spend_days_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.session_spend_dirty
    ADD CONSTRAINT session_spend_dirty_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
ALTER TABLE ONLY public.tenant_hosts
    ADD CONSTRAINT tenant_hosts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directory_channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directory_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directory_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directory_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directory_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directory_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.directory_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.llm_prompt_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retired_tenant_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_llm_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_spend_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_spend_dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_hosts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.blobs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.directory_channel_members USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.directory_channels USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.directory_group_members USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.directory_groups USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.directory_members USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.directory_meta USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.directory_sync USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.items USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.llm_prompt_envelopes USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.participants USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.runs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.session_goals USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.session_leases USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.session_llm_requests USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.session_pins USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.session_spend_days USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.session_spend_dirty USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.sessions USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.tenant_hosts FOR SELECT USING ((tenant_id = public.qm_bound_tenant()));
CREATE POLICY tenant_isolation ON public.tenants FOR SELECT USING ((id = public.qm_bound_tenant()));
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
