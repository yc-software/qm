SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;
SET LOCAL idle_in_transaction_session_timeout = 0;
SET LOCAL client_encoding = 'UTF8';
SET LOCAL standard_conforming_strings = on;
SET LOCAL check_function_bodies = false;
SET LOCAL xmloption = content;
SET LOCAL client_min_messages = warning;
SET LOCAL row_security = off;

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

CREATE FUNCTION public.acl_grants_bump_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN
        INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 1)
        ON CONFLICT (tenant_id, only_row) DO UPDATE SET v = acl_grants_version.v + 1;
        RETURN NULL;
      END
      $$;

CREATE FUNCTION public.claim_ack_emoji() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM ack_emoji WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_ack_emoji_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'ack_emoji'::text FROM ack_emoji WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_activity_seeds_configs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM activity_seeds_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_activity_seeds_configs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'activity_seeds_configs'::text FROM activity_seeds_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_ambient_cursors() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM ambient_cursors WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_ambient_cursors_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'ambient_cursors'::text FROM ambient_cursors WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_approval_grant_modes() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM approval_grant_modes WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_approval_grant_modes_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'approval_grant_modes'::text FROM approval_grant_modes WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_approval_grants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM approval_grants WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_approval_grants_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'approval_grants'::text FROM approval_grants WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_approval_grants_tenants_by_actorid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'approval_grants'::text FROM approval_grants
                WHERE lower(json->>'actorId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_approvals() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM approvals WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_approvals_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'approvals'::text FROM approvals WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_approvals_tenants_by_sessionid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'approvals'::text FROM approvals
                WHERE lower(json->>'sessionId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_available_runs(now bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT r.tenant_id, r.id FROM runs r WHERE r.status='pending' AND r.retry_after <= $1 AND r.tenant_id IN (SELECT qm_serving_tenants())
         AND NOT EXISTS (
           SELECT 1 FROM runs blocked WHERE blocked.tenant_id=r.tenant_id AND blocked.session_id=r.session_id
             AND (blocked.status='running' OR (blocked.status='pending' AND blocked.retry_after > $1))
         ) LIMIT 1 $_$;

CREATE FUNCTION public.claim_aws_deploy_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM aws_deploy_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_aws_deploy_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'aws_deploy_bodies'::text FROM aws_deploy_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_aws_sandbox_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM aws_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_aws_sandbox_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'aws_sandbox_bodies'::text FROM aws_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_base_model_configs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM base_model_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_base_model_configs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'base_model_configs'::text FROM base_model_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_branding_configs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM branding_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_branding_configs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'branding_configs'::text FROM branding_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_browse_max_steps_configs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM browse_max_steps_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_browse_max_steps_configs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'browse_max_steps_configs'::text FROM browse_max_steps_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_browser_sessions() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM browser_sessions WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_browser_sessions_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'browser_sessions'::text FROM browser_sessions WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_channel_header_pin_flag() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM channel_header_pin_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_channel_header_pin_flag_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'channel_header_pin_flag'::text FROM channel_header_pin_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_command_policies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM command_policies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_command_policies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'command_policies'::text FROM command_policies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_composio_returns() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM composio_returns WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_composio_returns_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'composio_returns'::text FROM composio_returns WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_connector_clients() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM connector_clients WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_connector_clients_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'connector_clients'::text FROM connector_clients WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_consent_links() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM consent_links WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_consent_links_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'consent_links'::text FROM consent_links WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_context_requests() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM context_requests WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_context_requests_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'context_requests'::text FROM context_requests WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_crons() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM crons WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_crons_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'crons'::text FROM crons WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_crons_tenants_by_ownerscopeid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'crons'::text FROM crons
                WHERE lower(json->>'ownerScopeId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_custom_model_providers() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM custom_model_providers WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_custom_model_providers_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'custom_model_providers'::text FROM custom_model_providers WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_deactivated_principals() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM deactivated_principals WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_deactivated_principals_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'deactivated_principals'::text FROM deactivated_principals WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_deliveries(text, bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT pg_advisory_xact_lock(hashtext('deliveries:claim:' || $1));
          UPDATE deliveries SET claim_expires_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT + $2
            WHERE (tenant_id, id) IN (
              SELECT tenant_id, id FROM deliveries d
               WHERE delivered_at IS NULL AND expired_at IS NULL AND NOT shadow
  AND (claim_expires_at IS NULL OR claim_expires_at <= (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT) AND destination->>'type' = $1 AND d.tenant_id IN (SELECT qm_serving_tenants())
                 AND NOT EXISTS (
                   SELECT 1 FROM deliveries o
                    WHERE o.tenant_id = d.tenant_id AND o.destination->>'type' = $1
                      AND o.destination->>'target' = d.destination->>'target'
                      AND o.delivered_at IS NULL AND o.expired_at IS NULL AND NOT o.shadow
                      AND (o.claim_expires_at > (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT OR (o.created_at, o.id) < (d.created_at, d.id)))
               ORDER BY created_at
               FOR UPDATE SKIP LOCKED)
            RETURNING tenant_id, id::text $_$;

CREATE FUNCTION public.claim_deploy_git_repos() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM deploy_git_repos WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_deploy_git_repos_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'deploy_git_repos'::text FROM deploy_git_repos WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_deployment_drafts() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM deployment_drafts WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_deployment_drafts_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'deployment_drafts'::text FROM deployment_drafts WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_deployment_identity() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM deployment_identity WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_deployment_identity_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'deployment_identity'::text FROM deployment_identity WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_deployments() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM deployments WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_deployments_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'deployments'::text FROM deployments WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_dirty_spend() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'spend'::text FROM session_spend_dirty ORDER BY tenant_id $$;

CREATE FUNCTION public.claim_do_managed_agents_sandbox_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM do_managed_agents_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_do_managed_agents_sandbox_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'do_managed_agents_sandbox_bodies'::text FROM do_managed_agents_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_e2b_sandbox_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM e2b_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_e2b_sandbox_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'e2b_sandbox_bodies'::text FROM e2b_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_egress_policies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM egress_policies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_egress_policies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'egress_policies'::text FROM egress_policies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_expired_file_uploads(bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ WITH due AS (
             SELECT tenant_id, id FROM file_uploads
             WHERE expires_at <= $1 AND next_attempt_at <= $1 AND state NOT IN ('complete','aborted','failed')
             ORDER BY next_attempt_at, expires_at, id FOR UPDATE SKIP LOCKED LIMIT 100
           ) UPDATE file_uploads SET next_attempt_at=$1+60000 FROM due
             WHERE file_uploads.tenant_id=due.tenant_id AND file_uploads.id=due.id
             RETURNING file_uploads.tenant_id, file_uploads.id $_$;

CREATE FUNCTION public.claim_expired_process_sessions(bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT tenant_id, process_id FROM process_sessions WHERE status = 'running' AND expires_at <= $1 $_$;

CREATE FUNCTION public.claim_expired_runs(now bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT tenant_id, id FROM runs WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1 AND tenant_id IN (SELECT qm_serving_tenants()) $_$;

CREATE FUNCTION public.claim_external_members() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM external_members WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_external_members_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'external_members'::text FROM external_members WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_external_slack_participants_flag() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM external_slack_participants_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_external_slack_participants_flag_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'external_slack_participants_flag'::text FROM external_slack_participants_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_feature_flags() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM feature_flags WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_feature_flags_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'feature_flags'::text FROM feature_flags WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_file_upload(text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT tenant_id, id FROM file_uploads WHERE id = $1 $_$;

CREATE FUNCTION public.claim_fly_deploy_configs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM fly_deploy_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_fly_deploy_configs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'fly_deploy_configs'::text FROM fly_deploy_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_idempotency() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM idempotency WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_idempotency_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'idempotency'::text FROM idempotency WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_individual_model_auth_flag() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM individual_model_auth_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_individual_model_auth_flag_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'individual_model_auth_flag'::text FROM individual_model_auth_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_interactive_fast_mode_flag() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM interactive_fast_mode_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_interactive_fast_mode_flag_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'interactive_fast_mode_flag'::text FROM interactive_fast_mode_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_keychain_asks() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM keychain_asks WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_keychain_asks_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'keychain_asks'::text FROM keychain_asks WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_keychain_credentials() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM keychain_credentials WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_keychain_credentials_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'keychain_credentials'::text FROM keychain_credentials WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_keychain_credentials_tenants_by_ownerid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'keychain_credentials'::text FROM keychain_credentials
                WHERE lower(json->>'ownerId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_keychain_grants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM keychain_grants WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_keychain_grants_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'keychain_grants'::text FROM keychain_grants WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_keychain_grants_tenants_by_ownerid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'keychain_grants'::text FROM keychain_grants
                WHERE lower(json->>'ownerId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_live_bot_process_sessions(bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT fill_process_session_bot_actors(); SELECT tenant_id, process_id FROM process_sessions WHERE status = 'running' AND expires_at > $1 AND bot_actor <> '' AND tenant_id IN (SELECT qm_serving_tenants()) $_$;

CREATE FUNCTION public.claim_loop_ingress() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM loop_ingress WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_loop_ingress_deliveries() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM loop_ingress_deliveries WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_loop_ingress_deliveries_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loop_ingress_deliveries'::text FROM loop_ingress_deliveries WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_loop_ingress_deliveries_tenants_by_queuekey(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loop_ingress_deliveries'::text FROM loop_ingress_deliveries
                WHERE lower(json->>'queueKey') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_loop_ingress_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loop_ingress'::text FROM loop_ingress WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_loop_ingress_tenants_by_loopid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loop_ingress'::text FROM loop_ingress
                WHERE lower(json->>'loopId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_loop_items() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM loop_items WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_loop_items_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loop_items'::text FROM loop_items WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_loop_items_tenants_by_loopid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loop_items'::text FROM loop_items
                WHERE lower(json->>'loopId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_loop_outputs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM loop_outputs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_loop_outputs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loop_outputs'::text FROM loop_outputs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_loop_outputs_tenants_by_itemid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loop_outputs'::text FROM loop_outputs
                WHERE lower(json->>'itemId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_loop_ship_grants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM loop_ship_grants WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_loop_ship_grants_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loop_ship_grants'::text FROM loop_ship_grants WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_loops() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM loops WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_loops_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'loops'::text FROM loops WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_mcp_servers() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM mcp_servers WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_mcp_servers_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'mcp_servers'::text FROM mcp_servers WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_memory_registry() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM memory_registry WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_memory_registry_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'memory_registry'::text FROM memory_registry WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_memory_tidy_profiles() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM memory_tidy_profiles WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_memory_tidy_profiles_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'memory_tidy_profiles'::text FROM memory_tidy_profiles WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_modal_sandbox_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM modal_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_modal_sandbox_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'modal_sandbox_bodies'::text FROM modal_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_model_credentials() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM model_credentials WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_model_credentials_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'model_credentials'::text FROM model_credentials WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_model_registry() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM model_registry WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_model_registry_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'model_registry'::text FROM model_registry WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_monitors() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM monitors WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_monitors_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'monitors'::text FROM monitors WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_monitors_tenants_by_ownerscopeid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'monitors'::text FROM monitors
                WHERE lower(json->>'ownerScopeId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_oauth_flows() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM oauth_flows WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_oauth_flows_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'oauth_flows'::text FROM oauth_flows WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_org_ambient_flag() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM org_ambient_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_org_ambient_flag_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'org_ambient_flag'::text FROM org_ambient_flag WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_pending_returns(lim integer, after_id text, now bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT tenant_id, id FROM (SELECT * FROM (
           SELECT * FROM runs WHERE status IN ('done','failed') AND returned_at IS NULL
           AND session_id LIKE 'agent:main:subagent:%' AND id > $2
           UNION
           SELECT child.* FROM runs wake JOIN runs child
           ON child.tenant_id = wake.tenant_id AND child.id = substring(wake.idempotency_key FROM length('subagent-return:') + 1)
           WHERE wake.status = 'pending' AND wake.attempts = 0 AND wake.turn_user_seq IS NULL
           AND wake.idempotency_key LIKE 'subagent-return:%'
           AND child.status IN ('done','failed') AND child.session_id LIKE 'agent:main:subagent:%'
           AND child.id > $2
         ) pending) due WHERE retry_after <= $3 AND due.tenant_id IN (SELECT qm_serving_tenants()) ORDER BY id LIMIT $1 $_$;

CREATE FUNCTION public.claim_persona_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'personas'::text FROM personas ORDER BY tenant_id $$;

CREATE FUNCTION public.claim_porter_deploy_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM porter_deploy_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_porter_deploy_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'porter_deploy_bodies'::text FROM porter_deploy_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_projects() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM projects WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_projects_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'projects'::text FROM projects WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_prompt_snapshots() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM prompt_snapshots WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_prompt_snapshots_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'prompt_snapshots'::text FROM prompt_snapshots WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_pruned_cron_fires(keep_per_cron integer, ended_before bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ DELETE FROM cron_fires cf
              USING (SELECT tenant_id, cron_id, fire_key,
                            ROW_NUMBER() OVER (PARTITION BY tenant_id, cron_id ORDER BY fired_at DESC, fire_key DESC) AS rn
                       FROM cron_fires) ranked
              WHERE cf.tenant_id = ranked.tenant_id AND cf.cron_id = ranked.cron_id AND cf.fire_key = ranked.fire_key
                AND ranked.rn > keep_per_cron
                AND cf.ended_at IS NOT NULL AND cf.ended_at < ended_before
              RETURNING cf.tenant_id, jsonb_build_array(cf.cron_id, cf.fire_key)::text $$;

CREATE FUNCTION public.claim_pruned_signals(before bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ DELETE FROM run_signals WHERE consumed_at IS NOT NULL AND consumed_at < $1 RETURNING tenant_id, id::text $_$;

CREATE FUNCTION public.claim_purged_envelopes(cutoff bigint, lim integer) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ DELETE FROM llm_prompt_envelopes
        WHERE (tenant_id, hash) IN (SELECT tenant_id, hash FROM llm_prompt_envelopes WHERE created_at < $1
                                     ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          AND created_at < $1
        RETURNING tenant_id, hash $_$;

CREATE FUNCTION public.claim_render_app_storage() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM render_app_storage WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_render_app_storage_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'render_app_storage'::text FROM render_app_storage WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_render_deploy_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM render_deploy_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_render_deploy_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'render_deploy_bodies'::text FROM render_deploy_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_render_deploy_credentials() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM render_deploy_credentials WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_render_deploy_credentials_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'render_deploy_credentials'::text FROM render_deploy_credentials WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_render_sandbox_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM render_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_render_sandbox_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'render_sandbox_bodies'::text FROM render_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_render_sandbox_cleanup() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM render_sandbox_cleanup WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_render_sandbox_cleanup_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'render_sandbox_cleanup'::text FROM render_sandbox_cleanup WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_render_scratch_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM render_scratch_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_render_scratch_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'render_scratch_bodies'::text FROM render_scratch_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_runs(lease_until bigint, worker text, now bigint, lim integer) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ WITH picked AS (
         SELECT candidate.tenant_id, candidate.id FROM runs candidate WHERE candidate.status='pending' AND candidate.retry_after <= $3
  AND NOT EXISTS (
    SELECT 1 FROM runs sibling WHERE sibling.tenant_id=candidate.tenant_id AND sibling.session_id=candidate.session_id
      AND (sibling.status='running' OR (sibling.status='pending'
        AND (sibling.retry_after > $3 OR (CASE
    WHEN (sibling.claim_priority > 0 AND sibling.last_stop::jsonb->>'kind' = 'parked') IS NOT TRUE AND (candidate.claim_priority > 0 AND candidate.last_stop::jsonb->>'kind' = 'parked') IS NOT TRUE
      THEN (sibling.created_at, sibling.seq) < (candidate.created_at, candidate.seq)
    ELSE ((CASE WHEN sibling.claim_priority <> 0 THEN 1
    WHEN EXISTS (
      SELECT 1 FROM runs ahead WHERE ahead.tenant_id=sibling.tenant_id AND ahead.session_id=sibling.session_id AND ahead.status='pending'
        AND ahead.claim_priority > 0 AND (ahead.claim_priority > 0 AND ahead.last_stop::jsonb->>'kind' = 'parked') IS NOT TRUE
        AND (ahead.created_at, ahead.seq) < (sibling.created_at, sibling.seq)
    ) THEN 1 ELSE 0 END), sibling.created_at, sibling.seq) < ((CASE WHEN candidate.claim_priority <> 0 THEN 1
    WHEN EXISTS (
      SELECT 1 FROM runs ahead WHERE ahead.tenant_id=candidate.tenant_id AND ahead.session_id=candidate.session_id AND ahead.status='pending'
        AND ahead.claim_priority > 0 AND (ahead.claim_priority > 0 AND ahead.last_stop::jsonb->>'kind' = 'parked') IS NOT TRUE
        AND (ahead.created_at, ahead.seq) < (candidate.created_at, candidate.seq)
    ) THEN 1 ELSE 0 END), candidate.created_at, candidate.seq) END))))
    OFFSET 0
  ) AND candidate.tenant_id IN (SELECT qm_serving_tenants())
         ORDER BY candidate.claim_priority ASC, candidate.created_at ASC, candidate.seq ASC FOR UPDATE SKIP LOCKED LIMIT $4
       )
       UPDATE runs SET status='running', lease_token=gen_random_uuid()::text, lease_expires_at=$1, worker_id=$2,
         attempts=attempts+1, started_at=COALESCE(started_at,$3)
       FROM picked WHERE runs.tenant_id = picked.tenant_id AND runs.id = picked.id RETURNING runs.tenant_id, runs.id $_$;

CREATE FUNCTION public.claim_sandbox_defaults() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM sandbox_defaults WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_sandbox_defaults_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'sandbox_defaults'::text FROM sandbox_defaults WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_sandbox_loads() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM sandbox_loads WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_sandbox_loads_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'sandbox_loads'::text FROM sandbox_loads WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_sandbox_resource_rollout() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM sandbox_resource_rollout WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_sandbox_resource_rollout_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'sandbox_resource_rollout'::text FROM sandbox_resource_rollout WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_sandbox_resources() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM sandbox_resources WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_sandbox_resources_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'sandbox_resources'::text FROM sandbox_resources WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_sandbox_routing() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM sandbox_routing WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_sandbox_routing_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'sandbox_routing'::text FROM sandbox_routing WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_secret_drops() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM secret_drops WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_secret_drops_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'secret_drops'::text FROM secret_drops WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_security_postures() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM security_postures WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_security_postures_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'security_postures'::text FROM security_postures WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_session_mailbox() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM session_mailbox WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_session_mailbox_by_wake(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM session_mailbox WHERE lower(json->>'wake') = lower(value) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_session_mailbox_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'session_mailbox'::text FROM session_mailbox WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_session_mailbox_tenants_by_recipientid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'session_mailbox'::text FROM session_mailbox
                WHERE lower(json->>'recipientId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_session_mailbox_tenants_by_wake(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'session_mailbox'::text FROM session_mailbox
                WHERE lower(json->>'wake') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_session_shares() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM session_shares WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_session_shares_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'session_shares'::text FROM session_shares WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_sharing_postures() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM sharing_postures WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_sharing_postures_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'sharing_postures'::text FROM sharing_postures WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_signaled_runs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, run_id FROM run_signals WHERE consumed_at IS NULL ORDER BY tenant_id, run_id $$;

CREATE FUNCTION public.claim_skill_bundles() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM skill_bundles WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_skill_bundles_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'skill_bundles'::text FROM skill_bundles WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_skill_packs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM skill_packs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_skill_packs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'skill_packs'::text FROM skill_packs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_skills() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM skills WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_skills_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'skills'::text FROM skills WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_skills_tenants_by_scopeid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'skills'::text FROM skills
                WHERE lower(json->>'scopeId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_slack_accounts() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM slack_accounts WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_slack_accounts_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'slack_accounts'::text FROM slack_accounts WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_slack_emoji_catalog() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM slack_emoji_catalog WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_slack_emoji_catalog_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'slack_emoji_catalog'::text FROM slack_emoji_catalog WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_slack_installation() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM slack_installation WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_slack_installation_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'slack_installation'::text FROM slack_installation WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_slack_session_status() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM slack_session_status WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_slack_session_status_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'slack_session_status'::text FROM slack_session_status WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_slack_staged_envelopes() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM slack_staged_envelopes WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_slack_staged_envelopes_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'slack_staged_envelopes'::text FROM slack_staged_envelopes WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_slack_task_acknowledgements() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM slack_task_acknowledgements WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_slack_task_acknowledgements_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'slack_task_acknowledgements'::text FROM slack_task_acknowledgements WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_smolmachines_sandbox_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM smolmachines_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_smolmachines_sandbox_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'smolmachines_sandbox_bodies'::text FROM smolmachines_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_soul_configs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM soul_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_soul_configs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'soul_configs'::text FROM soul_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_soul_history() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM soul_history WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_soul_history_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'soul_history'::text FROM soul_history WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_spend_limit_configs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM spend_limit_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_spend_limit_configs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'spend_limit_configs'::text FROM spend_limit_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_sprites_initialization() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM sprites_initialization WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_sprites_initialization_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'sprites_initialization'::text FROM sprites_initialization WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_stranded_cron_fires(ended bigint, stranded_note text, fired_before bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ UPDATE cron_fires SET status = 'failed', ended_at = ended, note = stranded_note
              WHERE status = 'running' AND fired_at <= fired_before
              RETURNING tenant_id, jsonb_build_array(cron_id, fire_key)::text $$;

CREATE FUNCTION public.claim_suggested_activity_profiles() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM suggested_activity_profiles WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_suggested_activity_profiles_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'suggested_activity_profiles'::text FROM suggested_activity_profiles WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_superserve_sandbox_bodies() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM superserve_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_superserve_sandbox_bodies_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'superserve_sandbox_bodies'::text FROM superserve_sandbox_bodies WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_swarms() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM swarms WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_swarms_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'swarms'::text FROM swarms WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_swarms_tenants_by_pending(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'swarms'::text FROM swarms
                WHERE lower(json->>'pending') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_terminal_runs(before bigint, after_finished bigint, after_id text, lim integer) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT tenant_id, id FROM runs WHERE status IN ('done','failed') AND finished_at <= $1
         AND (finished_at > $2 OR (finished_at = $2 AND id > $3))
       ORDER BY finished_at, id LIMIT $4 $_$;

CREATE FUNCTION public.claim_waiting_runs(created_before bigint, now bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT candidate.tenant_id, candidate.id FROM runs candidate WHERE candidate.status='pending' AND candidate.retry_after <= $2
  AND NOT EXISTS (
    SELECT 1 FROM runs sibling WHERE sibling.tenant_id=candidate.tenant_id AND sibling.session_id=candidate.session_id
      AND (sibling.status='running' OR (sibling.status='pending'
        AND (sibling.retry_after > $2 OR (CASE
    WHEN (sibling.claim_priority > 0 AND sibling.last_stop::jsonb->>'kind' = 'parked') IS NOT TRUE AND (candidate.claim_priority > 0 AND candidate.last_stop::jsonb->>'kind' = 'parked') IS NOT TRUE
      THEN (sibling.created_at, sibling.seq) < (candidate.created_at, candidate.seq)
    ELSE ((CASE WHEN sibling.claim_priority <> 0 THEN 1
    WHEN EXISTS (
      SELECT 1 FROM runs ahead WHERE ahead.tenant_id=sibling.tenant_id AND ahead.session_id=sibling.session_id AND ahead.status='pending'
        AND ahead.claim_priority > 0 AND (ahead.claim_priority > 0 AND ahead.last_stop::jsonb->>'kind' = 'parked') IS NOT TRUE
        AND (ahead.created_at, ahead.seq) < (sibling.created_at, sibling.seq)
    ) THEN 1 ELSE 0 END), sibling.created_at, sibling.seq) < ((CASE WHEN candidate.claim_priority <> 0 THEN 1
    WHEN EXISTS (
      SELECT 1 FROM runs ahead WHERE ahead.tenant_id=candidate.tenant_id AND ahead.session_id=candidate.session_id AND ahead.status='pending'
        AND ahead.claim_priority > 0 AND (ahead.claim_priority > 0 AND ahead.last_stop::jsonb->>'kind' = 'parked') IS NOT TRUE
        AND (ahead.created_at, ahead.seq) < (candidate.created_at, candidate.seq)
    ) THEN 1 ELSE 0 END), candidate.created_at, candidate.seq) END))))
    OFFSET 0
  ) AND candidate.tenant_id IN (SELECT qm_serving_tenants())
         AND candidate.claim_priority=0 AND candidate.created_at <= $1 LIMIT 1 $_$;

CREATE FUNCTION public.claim_web_ui_state() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM web_ui_state WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_web_ui_state_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'web_ui_state'::text FROM web_ui_state WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_webhook_history() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM webhook_history WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_webhook_history_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'webhook_history'::text FROM webhook_history WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_webhooks() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM webhooks WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_webhooks_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'webhooks'::text FROM webhooks WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_webhooks_tenants_by_ownerscopeid(value text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'webhooks'::text FROM webhooks
                WHERE lower(json->>'ownerScopeId') = lower(value) AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.claim_webui_model_configs() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, id FROM webui_model_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;

CREATE FUNCTION public.claim_webui_model_configs_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT DISTINCT tenant_id, 'webui_model_configs'::text FROM webui_model_configs WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.expire_deliveries(bigint) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ UPDATE deliveries SET expired_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
            WHERE (tenant_id, id) IN (SELECT tenant_id, id FROM deliveries WHERE delivered_at IS NULL AND expired_at IS NULL AND NOT shadow
  AND (claim_expires_at IS NULL OR claim_expires_at <= (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT) AND destination->'webTranscript'->>'kind' IS DISTINCT FROM 'slack_reply'
  AND created_at <= (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT - $1 FOR UPDATE SKIP LOCKED)
            RETURNING tenant_id, id::text $_$;

CREATE FUNCTION public.fill_process_session_bot_actors() RETURNS void
    LANGUAGE plpgsql
    AS $$ BEGIN IF to_regclass('runs') IS NOT NULL THEN UPDATE process_sessions p SET bot_actor = CASE WHEN to_jsonb(r) ->> 'bot_limited' = 'true' OR r.request::jsonb ->> 'botActor' = 'true' THEN coalesce(r.request::jsonb -> 'actor' ->> 'id', '') ELSE '' END FROM runs r WHERE r.tenant_id = p.tenant_id AND r.id = p.run_id AND p.status = 'running' AND p.bot_actor IS NULL AND pg_input_is_valid(r.request, 'jsonb') AND p.tenant_id IN (SELECT qm_serving_tenants()); END IF; END $$;

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

CREATE FUNCTION public.memory_facts_text_hash() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN
        NEW.text_hash := encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex');
        RETURN NEW;
      END $$;

CREATE FUNCTION public.pending_delivery_heads(text[]) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT DISTINCT tenant_id, jsonb_build_array(destination->>'type', destination->>'target')::text
             FROM deliveries
            WHERE delivered_at IS NULL AND expired_at IS NULL AND NOT shadow AND destination->>'type' = ANY($1) AND tenant_id IN (SELECT qm_serving_tenants()) $_$;

CREATE FUNCTION public.qm_boot_tenant() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END FROM (SELECT id FROM public.tenants LIMIT 2) one
    $$;

CREATE FUNCTION public.qm_bound_tenant() RETURNS uuid
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
DECLARE
  bound text := current_setting('qm.tenant_id', true);
BEGIN
  IF bound IS NULL OR bound = '' THEN
    RAISE insufficient_privilege USING MESSAGE = 'No tenant is bound to this query';
  END IF;
  RETURN bound::uuid;
END $$;

CREATE FUNCTION public.qm_serving_tenants() RETURNS SETOF uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
      BEGIN
        RETURN QUERY SELECT id FROM tenants
          WHERE settings->>'serving' IS DISTINCT FROM 'false' OR qm_boot_tenant() IS NOT NULL;
      END $$;

CREATE FUNCTION public.qm_set_tenant_handle(handle text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  BEGIN
    IF qm_tenant_handle(jsonb_build_object('handle', handle)) IS DISTINCT FROM handle THEN
      RAISE invalid_parameter_value USING MESSAGE = 'invalid app handle';
    END IF;
    UPDATE tenants SET settings = jsonb_set(settings, '{handle}', to_jsonb(handle)) WHERE id = qm_bound_tenant();
  END $$;

CREATE FUNCTION public.qm_tenant_for_app_handle(handle text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT id FROM tenants WHERE qm_tenant_handle(settings) = lower(handle)
$$;

CREATE FUNCTION public.qm_tenant_for_app_host(label text) RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  DECLARE found uuid;
  BEGIN
    IF strpos(label, '-') > 1 THEN
      found := qm_tenant_for_app_handle(split_part(label, '-', 1));
      IF found IS NOT NULL THEN RETURN found; END IF;
    END IF;
    RETURN qm_tenant_for_deployment(label);
  END $$;

CREATE FUNCTION public.qm_tenant_for_consent_link(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT (array_agg(DISTINCT tenant_id))[1] FROM (SELECT tenant_id FROM consent_links WHERE id = $1) found HAVING count(DISTINCT tenant_id) = 1 $_$;

CREATE FUNCTION public.qm_tenant_for_deployment(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT (array_agg(DISTINCT tenant_id))[1] FROM (SELECT tenant_id FROM deployments WHERE id = $1 OR json->>'name' = $1) found HAVING count(DISTINCT tenant_id) = 1 $_$;

CREATE FUNCTION public.qm_tenant_for_loop_ingress(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT (array_agg(DISTINCT tenant_id))[1] FROM (SELECT tenant_id FROM loop_ingress WHERE id = $1) found HAVING count(DISTINCT tenant_id) = 1 $_$;

CREATE FUNCTION public.qm_tenant_for_oauth_flow(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT (array_agg(DISTINCT tenant_id))[1] FROM (SELECT tenant_id FROM oauth_flows WHERE id = $1) found HAVING count(DISTINCT tenant_id) = 1 $_$;

CREATE FUNCTION public.qm_tenant_for_partner_chat(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT id FROM tenants WHERE settings->>'partnerChatAccount' = $1 AND id IN (SELECT qm_serving_tenants()) $_$;

CREATE FUNCTION public.qm_tenant_for_secret_drop(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT (array_agg(DISTINCT tenant_id))[1] FROM (SELECT tenant_id FROM secret_drops WHERE id = $1) found HAVING count(DISTINCT tenant_id) = 1 $_$;

CREATE FUNCTION public.qm_tenant_for_share(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT (array_agg(DISTINCT tenant_id))[1] FROM (SELECT tenant_id FROM session_shares WHERE id = $1) found HAVING count(DISTINCT tenant_id) = 1 $_$;

CREATE FUNCTION public.qm_tenant_for_slack_bridge(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT (array_agg(id))[1] FROM tenants WHERE settings->>'slackBridgeToken' = $1 HAVING count(*) = 1 $_$;

CREATE FUNCTION public.qm_tenant_for_slack_team(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT (array_agg(DISTINCT tenant_id))[1] FROM (SELECT tenant_id FROM slack_installation WHERE json->>'teamId' = $1 AND json->>'disabled' IS DISTINCT FROM 'true') found HAVING count(DISTINCT tenant_id) = 1 $_$;

CREATE FUNCTION public.qm_tenant_for_webhook(key text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT (array_agg(DISTINCT tenant_id))[1] FROM (SELECT tenant_id FROM webhooks WHERE id = $1) found HAVING count(DISTINCT tenant_id) = 1 $_$;

CREATE FUNCTION public.qm_tenant_handle(settings jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
      SELECT CASE WHEN h ~ '^[a-z0-9]{2,61}$' AND h <> ALL (ARRAY['auth', 'slack', 'mt', 'www', 'api', 'docs', 'apps', 'admin']) THEN h END
        FROM (SELECT coalesce(settings->>'handle',
          regexp_replace(lower(coalesce(settings->>'orgSlug', '')), '[^a-z0-9]', '', 'g')) AS h) picked
    $_$;

CREATE FUNCTION public.qm_tenants_for_email(email text) RETURNS TABLE(tenant_id uuid)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ BEGIN
      RETURN QUERY
        SELECT m.tenant_id FROM directory_members m
         WHERE lower(m.principal_id) = lower(email) AND m.type = 'internal'
        UNION
        SELECT g.tenant_id FROM admin_grants g WHERE lower(g.principal_id) = lower(email)
        UNION
        SELECT l.tenant_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
            AND u.kind = 'person' AND u.offboarded_at IS NULL WHERE l.alias_id = lower(btrim(email));
    END $$;

CREATE FUNCTION public.qm_tenants_for_gmail(key text) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT DISTINCT tenant_id FROM loop_ingress
        WHERE json->>'kind' = 'gmail' AND json->'gmail'->>'email' = lower($1) AND json->>'enabled' = 'true' $_$;

CREATE FUNCTION public.qm_tenants_for_principal(principal text) RETURNS SETOF uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ BEGIN
        RETURN QUERY
          SELECT l.tenant_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
            AND u.kind = 'person' AND u.offboarded_at IS NULL WHERE l.alias_id = CASE WHEN position('@' IN btrim(principal)) > 0 THEN lower(btrim(principal)) ELSE btrim(principal) END
          UNION
          SELECT g.tenant_id FROM admin_grants g WHERE g.principal_id = principal
          UNION
          SELECT g.tenant_id FROM admin_grants g
            JOIN user_links o ON o.tenant_id = g.tenant_id AND o.alias_id = CASE WHEN position('@' IN btrim(g.principal_id)) > 0 THEN lower(btrim(g.principal_id)) ELSE btrim(g.principal_id) END
            JOIN user_links l ON l.tenant_id = o.tenant_id AND l.user_id = o.user_id
           WHERE l.alias_id = CASE WHEN position('@' IN btrim(principal)) > 0 THEN lower(btrim(principal)) ELSE btrim(principal) END;
      END $$;

CREATE FUNCTION public.qm_tenants_with_slack() RETURNS SETOF uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ BEGIN RETURN QUERY SELECT DISTINCT tenant_id FROM slack_installation WHERE json->>'disabled' IS DISTINCT FROM 'true'; END $$;

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

CREATE FUNCTION public.undelivered_delivery_tenants(text) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$ SELECT DISTINCT tenant_id, $1 FROM deliveries
            WHERE delivered_at IS NULL AND expired_at IS NULL AND NOT shadow AND destination->>'type' = $1 AND tenant_id IN (SELECT qm_serving_tenants()) $_$;

SET LOCAL default_tablespace = '';

SET LOCAL default_table_access_method = heap;

CREATE TABLE public.ack_emoji (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.ack_emoji_picks (
    id bigint NOT NULL,
    org_id text NOT NULL,
    surface text NOT NULL,
    channel text NOT NULL,
    ts text NOT NULL,
    outcome text NOT NULL,
    picked text,
    icon text,
    message text,
    candidates text,
    model text,
    latency_ms integer,
    created_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.ack_emoji_picks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ack_emoji_picks_id_seq OWNED BY public.ack_emoji_picks.id;

CREATE TABLE public.acl_grants (
    owner_scope_id text NOT NULL,
    path text NOT NULL,
    grantee_scope_id text NOT NULL,
    permission text NOT NULL,
    granted_by text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.acl_grants_version (
    only_row boolean DEFAULT true NOT NULL,
    v bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT acl_grants_version_only_row_check CHECK (only_row)
);

CREATE TABLE public.activity_seeds_configs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.admin_grants (
    principal_id text NOT NULL,
    scope_id text NOT NULL,
    role text NOT NULL,
    granted_by text,
    created_at bigint,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.ambient_cursors (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.ambient_judgments (
    id bigint NOT NULL,
    org_id text NOT NULL,
    surface text NOT NULL,
    container text NOT NULL,
    decision text NOT NULL,
    reason text,
    asked_by text,
    prompt text,
    model text,
    latency_ms integer,
    ts_from text,
    ts_to text,
    created_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    start_error text
);

CREATE SEQUENCE public.ambient_judgments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ambient_judgments_id_seq OWNED BY public.ambient_judgments.id;

CREATE TABLE public.app_page_views (
    id bigint NOT NULL,
    deployment_id text NOT NULL,
    version integer,
    viewer text,
    auth_mode text NOT NULL,
    at bigint NOT NULL,
    path text NOT NULL,
    ip text,
    user_agent text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.app_page_views_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.app_page_views_id_seq OWNED BY public.app_page_views.id;

CREATE TABLE public.approval_grant_modes (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.approval_grants (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.approvals (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    at bigint NOT NULL,
    principal_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    scope_label text NOT NULL,
    status text,
    detail text,
    idempotency_key text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;

CREATE TABLE public.auth_broker_sessions (
    token_hash text NOT NULL,
    email text NOT NULL,
    authenticated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    absolute_expires_at timestamp with time zone NOT NULL,
    idle_seconds integer NOT NULL
);

CREATE TABLE public.aws_deploy_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.aws_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.base_model_configs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

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

CREATE TABLE public.branding_configs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.browse_max_steps_configs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.browser_sessions (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.budget_spend (
    id bigint NOT NULL,
    principal_id text NOT NULL,
    at bigint NOT NULL,
    usd double precision NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.budget_spend_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_spend_id_seq OWNED BY public.budget_spend.id;

CREATE TABLE public.channel_files (
    org_id text NOT NULL,
    container text NOT NULL,
    ts text NOT NULL,
    file_id text NOT NULL,
    name text,
    mimetype text,
    created_at bigint NOT NULL,
    title text,
    size bigint,
    surface text DEFAULT 'slack'::text NOT NULL,
    account text DEFAULT ''::text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.channel_header_pin_flag (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.channel_messages (
    org_id text NOT NULL,
    container text NOT NULL,
    ts text NOT NULL,
    sub text,
    author_id text,
    author_name text,
    text text DEFAULT ''::text NOT NULL,
    mentions jsonb,
    self boolean DEFAULT false NOT NULL,
    bot boolean DEFAULT false NOT NULL,
    mentions_self boolean DEFAULT false NOT NULL,
    edited_at bigint,
    deleted boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    handled boolean DEFAULT false NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(text, ''::text))) STORED,
    deleted_at bigint,
    broadcast boolean DEFAULT false NOT NULL,
    subtype text,
    bot_id text,
    raw jsonb,
    surface text DEFAULT 'slack'::text NOT NULL,
    account text DEFAULT ''::text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.channel_policy (
    org_id text NOT NULL,
    container text NOT NULL,
    orders text DEFAULT ''::text NOT NULL,
    bots jsonb DEFAULT '{}'::jsonb NOT NULL,
    set_by text,
    updated_at bigint NOT NULL,
    ambient_enabled boolean,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.channel_policy_history (
    id bigint NOT NULL,
    org_id text NOT NULL,
    container text NOT NULL,
    orders text NOT NULL,
    set_by text,
    session_id text,
    created_at bigint NOT NULL,
    bots jsonb,
    ambient_enabled boolean,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.channel_policy_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.channel_policy_history_id_seq OWNED BY public.channel_policy_history.id;

CREATE TABLE public.channel_state (
    org_id text NOT NULL,
    container text NOT NULL,
    last_ts text,
    oldest_ts text,
    name text,
    kind text,
    members jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at bigint NOT NULL,
    surface text DEFAULT 'slack'::text NOT NULL,
    account text DEFAULT ''::text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    source jsonb
);

CREATE TABLE public.command_policies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.composio_returns (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.connector_clients (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.consent_links (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.context_requests (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.credential_daily_calls (
    slug text NOT NULL,
    day bigint NOT NULL,
    sent integer NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.credential_usage (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    slug text NOT NULL,
    host text NOT NULL,
    status text NOT NULL,
    upstream_status integer,
    scope_label text NOT NULL,
    principal_id text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.credential_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.credential_usage_id_seq OWNED BY public.credential_usage.id;

CREATE TABLE public.cron_fires (
    cron_id text NOT NULL,
    fire_key text NOT NULL,
    thread_ref text NOT NULL,
    session_id text,
    fired_at bigint NOT NULL,
    scheduled_at bigint,
    ended_at bigint,
    status text,
    note text,
    reply text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.crons (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.custom_model_providers (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.deactivated_principals (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.decision_providers (
    provider_id text NOT NULL,
    protocol text NOT NULL,
    base_url text,
    credential text,
    updated_by text NOT NULL,
    updated_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.decision_rules (
    rule_id text NOT NULL,
    hook text NOT NULL,
    question text NOT NULL,
    options json NOT NULL,
    provider_id text NOT NULL,
    model text NOT NULL,
    mode text NOT NULL,
    on_error text NOT NULL,
    updated_by text NOT NULL,
    updated_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT decision_rules_mode_check CHECK ((mode = ANY (ARRAY['off'::text, 'observe'::text, 'enforce'::text])))
);

CREATE TABLE public.deliveries (
    id text NOT NULL,
    idempotency_key text NOT NULL,
    destination jsonb NOT NULL,
    text text NOT NULL,
    created_at bigint NOT NULL,
    delivered_at bigint,
    attachments jsonb,
    provenance jsonb,
    recipient_thread_ref text,
    shadow boolean DEFAULT false NOT NULL,
    deliver_latency_ms integer,
    slack_api_ms integer,
    claim_expires_at bigint,
    expired_at bigint,
    source_cron_id text,
    failed_reason text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.deploy_git_repos (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.deployment_access (
    id text NOT NULL,
    last_access_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.deployment_drafts (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.deployment_identity (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.deployment_layer (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE public.deployments (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
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
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    surface text NOT NULL
);

CREATE TABLE public.directory_members (
    org_id text NOT NULL,
    principal_id text NOT NULL,
    display_name text NOT NULL,
    display_name_lc text NOT NULL,
    type text NOT NULL,
    slack_id text,
    avatar_url text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    is_bot boolean
);

CREATE TABLE public.directory_meta (
    org_id text NOT NULL,
    workspace_url text,
    updated_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    app_icon_url text
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

CREATE TABLE public.do_managed_agents_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.durable_map_versions (
    tbl text NOT NULL,
    v bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.e2b_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.egress_events (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    source text NOT NULL,
    host text NOT NULL,
    allowed boolean NOT NULL,
    scope_label text NOT NULL,
    port integer,
    verdict text,
    via text,
    peer_ip text,
    principal_id text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.egress_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.egress_events_id_seq OWNED BY public.egress_events.id;

CREATE TABLE public.egress_policies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.environment_attachments (
    scope_id text NOT NULL,
    environment_id text NOT NULL,
    attached_by text NOT NULL,
    attached_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.environments (
    id text NOT NULL,
    org_id text NOT NULL,
    name text,
    owner_actor_id text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.error_events (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    scope_label text NOT NULL,
    category text NOT NULL,
    code text NOT NULL,
    message text NOT NULL,
    session_id text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.error_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.error_events_id_seq OWNED BY public.error_events.id;

CREATE TABLE public.external_members (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.external_slack_participants_flag (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.feature_flags (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.file_artifact_deletions (
    id text NOT NULL,
    deleted_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.file_artifacts (
    id text NOT NULL,
    kind text DEFAULT 'file'::text NOT NULL,
    owner_scope_id text NOT NULL,
    path text NOT NULL,
    name text NOT NULL,
    mimetype text NOT NULL,
    size_bytes bigint NOT NULL,
    blob_key text,
    sha256 text,
    direction text NOT NULL,
    created_by text NOT NULL,
    created_in_scope text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    source text DEFAULT 'live'::text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.file_uploads (
    id text NOT NULL,
    actor_id text NOT NULL,
    state text NOT NULL,
    size_bytes bigint NOT NULL,
    expires_at bigint NOT NULL,
    data jsonb NOT NULL,
    next_attempt_at bigint DEFAULT 0 NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.fly_deploy_configs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.fly_deploy_ports (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE public.fly_peer_claims (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE public.idempotency (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.individual_model_auth_flag (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.instance_heartbeats (
    instance_id text NOT NULL,
    build_sha text NOT NULL,
    started_at bigint NOT NULL,
    beat_at timestamp with time zone NOT NULL,
    running boolean DEFAULT false NOT NULL
);

CREATE TABLE public.interactive_fast_mode_flag (
    id text NOT NULL,
    json jsonb NOT NULL,
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

CREATE TABLE public.keychain_asks (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.keychain_credentials (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.keychain_grants (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.llm_prompt_envelopes (
    hash text NOT NULL,
    body text NOT NULL,
    created_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.loop_ingress (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.loop_ingress_deliveries (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.loop_items (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.loop_outputs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.loop_ship_grants (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.loops (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.mcp_servers (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.memory_facts (
    id bigint NOT NULL,
    scope_id text NOT NULL,
    text text NOT NULL,
    sensitivity text NOT NULL,
    sources text[] DEFAULT '{}'::text[] NOT NULL,
    source_unknown boolean NOT NULL,
    author text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint,
    text_hash text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    session_id text
);

CREATE SEQUENCE public.memory_facts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.memory_facts_id_seq OWNED BY public.memory_facts.id;

CREATE TABLE public.memory_registry (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.memory_tidy_profiles (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.modal_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.model_credentials (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.model_registry (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.monitors (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.oauth_flows (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.org_ambient_flag (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.participants (
    session_id text NOT NULL,
    principal_id text NOT NULL,
    title text,
    archived boolean DEFAULT false NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    color text,
    read_at bigint,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.persona_access (
    persona_id text NOT NULL,
    grantee_scope_id text NOT NULL,
    role text NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    CONSTRAINT persona_access_grantee_scope_id_check CHECK ((split_part(grantee_scope_id, ':'::text, 1) = ANY (ARRAY['personal'::text, 'team'::text, 'org'::text, 'channel'::text, 'group'::text]))),
    CONSTRAINT persona_access_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'write'::text, 'read'::text])))
);

CREATE TABLE public.persona_versions (
    persona_id text NOT NULL,
    version integer NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    instructions text NOT NULL,
    icon jsonb,
    restored_from integer,
    edited_by uuid NOT NULL,
    edited_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT persona_versions_version_check CHECK ((version > 0))
);

CREATE TABLE public.personas (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    icon jsonb,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT personas_name_check CHECK ((btrim(name) <> ''::text))
);

CREATE TABLE public.porter_deploy_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.process_sessions (
    process_id text NOT NULL,
    scope_id text NOT NULL,
    kind text NOT NULL,
    command text NOT NULL,
    started_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    status text NOT NULL,
    session_ref text,
    run_id text,
    sandbox_id text,
    purpose text,
    credential_files jsonb,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    bot_actor text
);

CREATE TABLE public.projects (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.prompt_snapshots (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.qm_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.render_app_storage (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.render_deploy_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.render_deploy_credentials (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.render_sandbox_bases (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE public.render_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.render_sandbox_cleanup (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.render_scratch_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.run_activity (
    id bigint NOT NULL,
    run_id text NOT NULL,
    seq bigint NOT NULL,
    parent_seq bigint,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.run_activity_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.run_activity_id_seq OWNED BY public.run_activity.id;

CREATE TABLE public.run_signals (
    id bigint NOT NULL,
    run_id text NOT NULL,
    kind text NOT NULL,
    text text,
    payload jsonb,
    created_at bigint NOT NULL,
    consumed_at bigint,
    dedupe_key text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE SEQUENCE public.run_signals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.run_signals_id_seq OWNED BY public.run_signals.id;

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
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    handbacks integer DEFAULT 0 NOT NULL,
    bot_limited boolean DEFAULT false NOT NULL
);

CREATE SEQUENCE public.runs_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.runs_seq_seq OWNED BY public.runs.seq;

CREATE TABLE public.sandbox_defaults (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.sandbox_loads (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.sandbox_resource_rollout (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.sandbox_resources (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.sandbox_routing (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.secret_drops (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.security_postures (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
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
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT session_goals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'complete'::text, 'cancelled'::text])))
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

CREATE TABLE public.session_mailbox (
    id text NOT NULL,
    json jsonb NOT NULL,
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

CREATE TABLE public.session_shares (
    id text NOT NULL,
    json jsonb NOT NULL,
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
    persona_id text,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT sessions_fork_provenance_pair CHECK (((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL)))
)
WITH (fillfactor='70');

CREATE TABLE public.sharing_postures (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.skill_bundles (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.skill_packs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.skills (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.slack_accounts (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.slack_emoji_catalog (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.slack_installation (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.slack_session_status (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.slack_staged_envelopes (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.slack_task_acknowledgements (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.smolmachines_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.soul_configs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.soul_history (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.source_auth_replay (
    event_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.spend_limit_configs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.sprites_initialization (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.suggested_activity_profiles (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.superserve_config_epochs (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE public.superserve_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.swarms (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.team_members (
    team_id text NOT NULL,
    principal_id text NOT NULL,
    role text NOT NULL,
    added_by text NOT NULL,
    added_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT team_members_role_check CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))
);

CREATE TABLE public.team_rooms (
    team_id text NOT NULL,
    scope_id text NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.teams (
    team_id text NOT NULL,
    name text NOT NULL,
    isolated_in_open boolean DEFAULT false NOT NULL,
    created_by text NOT NULL,
    created_at bigint NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT tenants_settings_check CHECK ((jsonb_typeof(settings) = 'object'::text))
);

CREATE TABLE public.user_links (
    alias_id text NOT NULL,
    user_id uuid NOT NULL,
    evidence text NOT NULL,
    linked_by uuid,
    created_at timestamp with time zone NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT user_links_alias_id_check CHECK ((alias_id <> ''::text))
);

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    primary_alias text NOT NULL,
    kind text DEFAULT 'person'::text NOT NULL,
    first_seen_at timestamp with time zone,
    source text,
    offboarded_at timestamp with time zone,
    offboarded_by uuid,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    display_name text,
    CONSTRAINT users_check CHECK (((first_seen_at IS NULL) = (source IS NULL))),
    CONSTRAINT users_check1 CHECK (((offboarded_at IS NOT NULL) OR (offboarded_by IS NULL))),
    CONSTRAINT users_display_name_check CHECK (((display_name IS NULL) OR ((display_name <> ''::text) AND (char_length(display_name) <= 200)))),
    CONSTRAINT users_kind_check CHECK ((kind = ANY (ARRAY['person'::text, 'app'::text]))),
    CONSTRAINT users_source_check CHECK ((source = ANY (ARRAY['turn'::text, 'invite'::text, 'admin'::text])))
);

CREATE TABLE public.web_ui_state (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.webhook_history (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.webhooks (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

CREATE TABLE public.webui_model_configs (
    id text NOT NULL,
    json jsonb NOT NULL,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL
);

ALTER TABLE ONLY public.ack_emoji_picks ALTER COLUMN id SET DEFAULT nextval('public.ack_emoji_picks_id_seq'::regclass);

ALTER TABLE ONLY public.ambient_judgments ALTER COLUMN id SET DEFAULT nextval('public.ambient_judgments_id_seq'::regclass);

ALTER TABLE ONLY public.app_page_views ALTER COLUMN id SET DEFAULT nextval('public.app_page_views_id_seq'::regclass);

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);

ALTER TABLE ONLY public.budget_spend ALTER COLUMN id SET DEFAULT nextval('public.budget_spend_id_seq'::regclass);

ALTER TABLE ONLY public.channel_policy_history ALTER COLUMN id SET DEFAULT nextval('public.channel_policy_history_id_seq'::regclass);

ALTER TABLE ONLY public.credential_usage ALTER COLUMN id SET DEFAULT nextval('public.credential_usage_id_seq'::regclass);

ALTER TABLE ONLY public.egress_events ALTER COLUMN id SET DEFAULT nextval('public.egress_events_id_seq'::regclass);

ALTER TABLE ONLY public.error_events ALTER COLUMN id SET DEFAULT nextval('public.error_events_id_seq'::regclass);

ALTER TABLE ONLY public.memory_facts ALTER COLUMN id SET DEFAULT nextval('public.memory_facts_id_seq'::regclass);

ALTER TABLE ONLY public.run_activity ALTER COLUMN id SET DEFAULT nextval('public.run_activity_id_seq'::regclass);

ALTER TABLE ONLY public.run_signals ALTER COLUMN id SET DEFAULT nextval('public.run_signals_id_seq'::regclass);

ALTER TABLE ONLY public.runs ALTER COLUMN seq SET DEFAULT nextval('public.runs_seq_seq'::regclass);

ALTER TABLE ONLY public.ack_emoji_picks
    ADD CONSTRAINT ack_emoji_picks_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.ack_emoji
    ADD CONSTRAINT ack_emoji_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.acl_grants
    ADD CONSTRAINT acl_grants_pkey PRIMARY KEY (tenant_id, owner_scope_id, path, grantee_scope_id, permission);

ALTER TABLE ONLY public.acl_grants_version
    ADD CONSTRAINT acl_grants_version_pkey PRIMARY KEY (tenant_id, only_row);

ALTER TABLE ONLY public.activity_seeds_configs
    ADD CONSTRAINT activity_seeds_configs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.admin_grants
    ADD CONSTRAINT admin_grants_pkey PRIMARY KEY (tenant_id, principal_id, scope_id, role);

ALTER TABLE ONLY public.ambient_cursors
    ADD CONSTRAINT ambient_cursors_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.ambient_judgments
    ADD CONSTRAINT ambient_judgments_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.app_page_views
    ADD CONSTRAINT app_page_views_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.approval_grant_modes
    ADD CONSTRAINT approval_grant_modes_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.approval_grants
    ADD CONSTRAINT approval_grants_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.auth_broker_sessions
    ADD CONSTRAINT auth_broker_sessions_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY public.aws_deploy_bodies
    ADD CONSTRAINT aws_deploy_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.aws_sandbox_bodies
    ADD CONSTRAINT aws_sandbox_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.base_model_configs
    ADD CONSTRAINT base_model_configs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (tenant_id, sha256);

ALTER TABLE ONLY public.branding_configs
    ADD CONSTRAINT branding_configs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.browse_max_steps_configs
    ADD CONSTRAINT browse_max_steps_configs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.budget_spend
    ADD CONSTRAINT budget_spend_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.channel_files
    ADD CONSTRAINT channel_files_pkey PRIMARY KEY (tenant_id, org_id, container, ts, file_id);

ALTER TABLE ONLY public.channel_header_pin_flag
    ADD CONSTRAINT channel_header_pin_flag_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.channel_messages
    ADD CONSTRAINT channel_messages_pkey PRIMARY KEY (tenant_id, org_id, container, ts);

ALTER TABLE ONLY public.channel_policy_history
    ADD CONSTRAINT channel_policy_history_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.channel_policy
    ADD CONSTRAINT channel_policy_pkey PRIMARY KEY (tenant_id, org_id, container);

ALTER TABLE ONLY public.channel_state
    ADD CONSTRAINT channel_state_pkey PRIMARY KEY (tenant_id, org_id, container);

ALTER TABLE ONLY public.command_policies
    ADD CONSTRAINT command_policies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.composio_returns
    ADD CONSTRAINT composio_returns_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.connector_clients
    ADD CONSTRAINT connector_clients_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.consent_links
    ADD CONSTRAINT consent_links_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.context_requests
    ADD CONSTRAINT context_requests_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.credential_daily_calls
    ADD CONSTRAINT credential_daily_calls_pkey PRIMARY KEY (tenant_id, slug, day);

ALTER TABLE ONLY public.credential_usage
    ADD CONSTRAINT credential_usage_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.cron_fires
    ADD CONSTRAINT cron_fires_pkey PRIMARY KEY (tenant_id, cron_id, fire_key);

ALTER TABLE ONLY public.crons
    ADD CONSTRAINT crons_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.custom_model_providers
    ADD CONSTRAINT custom_model_providers_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.deactivated_principals
    ADD CONSTRAINT deactivated_principals_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.decision_providers
    ADD CONSTRAINT decision_providers_pkey PRIMARY KEY (tenant_id, provider_id);

ALTER TABLE ONLY public.decision_rules
    ADD CONSTRAINT decision_rules_pkey PRIMARY KEY (tenant_id, rule_id);

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_idempotency_key_key UNIQUE (tenant_id, idempotency_key);

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.deploy_git_repos
    ADD CONSTRAINT deploy_git_repos_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.deployment_access
    ADD CONSTRAINT deployment_access_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.deployment_drafts
    ADD CONSTRAINT deployment_drafts_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.deployment_identity
    ADD CONSTRAINT deployment_identity_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.deployment_layer
    ADD CONSTRAINT deployment_layer_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (tenant_id, id);

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

ALTER TABLE ONLY public.do_managed_agents_sandbox_bodies
    ADD CONSTRAINT do_managed_agents_sandbox_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.durable_map_versions
    ADD CONSTRAINT durable_map_versions_pkey PRIMARY KEY (tenant_id, tbl);

ALTER TABLE ONLY public.e2b_sandbox_bodies
    ADD CONSTRAINT e2b_sandbox_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.egress_events
    ADD CONSTRAINT egress_events_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.egress_policies
    ADD CONSTRAINT egress_policies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.environment_attachments
    ADD CONSTRAINT environment_attachments_pkey PRIMARY KEY (tenant_id, scope_id);

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.error_events
    ADD CONSTRAINT error_events_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.external_members
    ADD CONSTRAINT external_members_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.external_slack_participants_flag
    ADD CONSTRAINT external_slack_participants_flag_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.file_artifact_deletions
    ADD CONSTRAINT file_artifact_deletions_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.file_artifacts
    ADD CONSTRAINT file_artifacts_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.fly_deploy_configs
    ADD CONSTRAINT fly_deploy_configs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.fly_deploy_ports
    ADD CONSTRAINT fly_deploy_ports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fly_peer_claims
    ADD CONSTRAINT fly_peer_claims_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.idempotency
    ADD CONSTRAINT idempotency_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.individual_model_auth_flag
    ADD CONSTRAINT individual_model_auth_flag_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.instance_heartbeats
    ADD CONSTRAINT instance_heartbeats_pkey PRIMARY KEY (instance_id);

ALTER TABLE ONLY public.interactive_fast_mode_flag
    ADD CONSTRAINT interactive_fast_mode_flag_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (tenant_id, session_id, seq);

ALTER TABLE ONLY public.keychain_asks
    ADD CONSTRAINT keychain_asks_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.keychain_credentials
    ADD CONSTRAINT keychain_credentials_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.keychain_grants
    ADD CONSTRAINT keychain_grants_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.llm_prompt_envelopes
    ADD CONSTRAINT llm_prompt_envelopes_pkey PRIMARY KEY (tenant_id, hash);

ALTER TABLE ONLY public.loop_ingress_deliveries
    ADD CONSTRAINT loop_ingress_deliveries_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.loop_ingress
    ADD CONSTRAINT loop_ingress_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.loop_items
    ADD CONSTRAINT loop_items_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.loop_outputs
    ADD CONSTRAINT loop_outputs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.loop_ship_grants
    ADD CONSTRAINT loop_ship_grants_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.loops
    ADD CONSTRAINT loops_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.memory_facts
    ADD CONSTRAINT memory_facts_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.memory_registry
    ADD CONSTRAINT memory_registry_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.memory_tidy_profiles
    ADD CONSTRAINT memory_tidy_profiles_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.modal_sandbox_bodies
    ADD CONSTRAINT modal_sandbox_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.model_credentials
    ADD CONSTRAINT model_credentials_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.model_registry
    ADD CONSTRAINT model_registry_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.monitors
    ADD CONSTRAINT monitors_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.oauth_flows
    ADD CONSTRAINT oauth_flows_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.org_ambient_flag
    ADD CONSTRAINT org_ambient_flag_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_pkey PRIMARY KEY (tenant_id, session_id, principal_id);

ALTER TABLE ONLY public.persona_access
    ADD CONSTRAINT persona_access_pkey PRIMARY KEY (tenant_id, persona_id, grantee_scope_id);

ALTER TABLE ONLY public.persona_versions
    ADD CONSTRAINT persona_versions_pkey PRIMARY KEY (tenant_id, persona_id, version);

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.porter_deploy_bodies
    ADD CONSTRAINT porter_deploy_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.process_sessions
    ADD CONSTRAINT process_sessions_pkey PRIMARY KEY (tenant_id, process_id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.prompt_snapshots
    ADD CONSTRAINT prompt_snapshots_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.qm_settings
    ADD CONSTRAINT qm_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.render_app_storage
    ADD CONSTRAINT render_app_storage_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.render_deploy_bodies
    ADD CONSTRAINT render_deploy_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.render_deploy_credentials
    ADD CONSTRAINT render_deploy_credentials_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.render_sandbox_bases
    ADD CONSTRAINT render_sandbox_bases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.render_sandbox_bodies
    ADD CONSTRAINT render_sandbox_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.render_sandbox_cleanup
    ADD CONSTRAINT render_sandbox_cleanup_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.render_scratch_bodies
    ADD CONSTRAINT render_scratch_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.run_activity
    ADD CONSTRAINT run_activity_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.run_signals
    ADD CONSTRAINT run_signals_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_idempotency_key_key UNIQUE (tenant_id, idempotency_key);

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.sandbox_defaults
    ADD CONSTRAINT sandbox_defaults_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.sandbox_loads
    ADD CONSTRAINT sandbox_loads_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.sandbox_resource_rollout
    ADD CONSTRAINT sandbox_resource_rollout_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.sandbox_resources
    ADD CONSTRAINT sandbox_resources_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.sandbox_routing
    ADD CONSTRAINT sandbox_routing_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.secret_drops
    ADD CONSTRAINT secret_drops_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.security_postures
    ADD CONSTRAINT security_postures_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.session_goals
    ADD CONSTRAINT session_goals_pkey PRIMARY KEY (tenant_id, session_id);

ALTER TABLE ONLY public.session_llm_requests
    ADD CONSTRAINT session_llm_requests_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.session_mailbox
    ADD CONSTRAINT session_mailbox_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.session_pins
    ADD CONSTRAINT session_pins_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.session_shares
    ADD CONSTRAINT session_shares_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.session_spend_days
    ADD CONSTRAINT session_spend_days_pkey PRIMARY KEY (tenant_id, day);

ALTER TABLE ONLY public.session_spend_dirty
    ADD CONSTRAINT session_spend_dirty_day_writer_key UNIQUE (tenant_id, day, writer);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_thread_ref_key UNIQUE (tenant_id, thread_ref);

ALTER TABLE ONLY public.sharing_postures
    ADD CONSTRAINT sharing_postures_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.skill_bundles
    ADD CONSTRAINT skill_bundles_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.skill_packs
    ADD CONSTRAINT skill_packs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.slack_accounts
    ADD CONSTRAINT slack_accounts_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.slack_emoji_catalog
    ADD CONSTRAINT slack_emoji_catalog_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.slack_installation
    ADD CONSTRAINT slack_installation_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.slack_session_status
    ADD CONSTRAINT slack_session_status_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.slack_staged_envelopes
    ADD CONSTRAINT slack_staged_envelopes_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.slack_task_acknowledgements
    ADD CONSTRAINT slack_task_acknowledgements_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.smolmachines_sandbox_bodies
    ADD CONSTRAINT smolmachines_sandbox_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.soul_configs
    ADD CONSTRAINT soul_configs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.soul_history
    ADD CONSTRAINT soul_history_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.source_auth_replay
    ADD CONSTRAINT source_auth_replay_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.spend_limit_configs
    ADD CONSTRAINT spend_limit_configs_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.sprites_initialization
    ADD CONSTRAINT sprites_initialization_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.suggested_activity_profiles
    ADD CONSTRAINT suggested_activity_profiles_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.superserve_config_epochs
    ADD CONSTRAINT superserve_config_epochs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.superserve_sandbox_bodies
    ADD CONSTRAINT superserve_sandbox_bodies_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.swarms
    ADD CONSTRAINT swarms_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (tenant_id, team_id, principal_id);

ALTER TABLE ONLY public.team_rooms
    ADD CONSTRAINT team_rooms_pkey PRIMARY KEY (tenant_id, team_id, scope_id);

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (tenant_id, team_id);

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_links
    ADD CONSTRAINT user_links_pkey PRIMARY KEY (tenant_id, alias_id);

ALTER TABLE ONLY public.user_links
    ADD CONSTRAINT user_links_user_id_alias_id_key UNIQUE (tenant_id, user_id, alias_id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_primary_alias_key UNIQUE (tenant_id, primary_alias);

ALTER TABLE ONLY public.web_ui_state
    ADD CONSTRAINT web_ui_state_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.webhook_history
    ADD CONSTRAINT webhook_history_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.webui_model_configs
    ADD CONSTRAINT webui_model_configs_pkey PRIMARY KEY (tenant_id, id);

CREATE INDEX ack_emoji_picks_org_channel_created ON public.ack_emoji_picks USING btree (org_id, channel, created_at DESC);

CREATE INDEX ack_emoji_picks_org_created ON public.ack_emoji_picks USING btree (org_id, created_at DESC, id DESC);

CREATE INDEX ack_emoji_picks_org_outcome ON public.ack_emoji_picks USING btree (org_id, outcome);

CREATE INDEX acl_grants_by_grantee ON public.acl_grants USING btree (grantee_scope_id, path text_pattern_ops);

CREATE INDEX ambient_judgments_org_container_created ON public.ambient_judgments USING btree (org_id, container, created_at DESC);

CREATE INDEX ambient_judgments_org_created ON public.ambient_judgments USING btree (org_id, created_at DESC, id DESC);

CREATE INDEX ambient_judgments_org_decision ON public.ambient_judgments USING btree (org_id, decision);

CREATE INDEX app_page_views_by_at ON public.app_page_views USING btree (at);

CREATE INDEX app_page_views_by_deployment_at ON public.app_page_views USING btree (deployment_id, at DESC);

CREATE INDEX app_page_views_by_viewer ON public.app_page_views USING btree (tenant_id, viewer, deployment_id, at DESC);

CREATE INDEX approval_grants_actorid_fold ON public.approval_grants USING hash (lower((json ->> 'actorId'::text)));

CREATE INDEX approval_grants_actorid_unicode ON public.approval_grants USING btree (id) WHERE ((json ->> 'actorId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX approvals_sessionid_fold ON public.approvals USING hash (lower((json ->> 'sessionId'::text)));

CREATE INDEX approvals_sessionid_unicode ON public.approvals USING btree (id) WHERE ((json ->> 'sessionId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX audit_log_by_action ON public.audit_log USING btree (action, at DESC);

CREATE INDEX audit_log_by_at ON public.audit_log USING btree (at DESC);

CREATE UNIQUE INDEX audit_log_by_idempotency_key ON public.audit_log USING btree (tenant_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE INDEX audit_log_by_scope_at ON public.audit_log USING btree (scope_label, at DESC);

CREATE INDEX auth_broker_sessions_email ON public.auth_broker_sessions USING btree (email);

CREATE INDEX auth_broker_sessions_expiry ON public.auth_broker_sessions USING btree (expires_at);

CREATE INDEX budget_spend_by_principal_at ON public.budget_spend USING btree (principal_id, at);

CREATE UNIQUE INDEX channel_files_surface_key ON public.channel_files USING btree (tenant_id, org_id, surface, account, container, ts, file_id);

CREATE INDEX channel_messages_by_container ON public.channel_messages USING btree (org_id, container, ts);

CREATE INDEX channel_messages_by_sub ON public.channel_messages USING btree (org_id, container, sub, ts);

CREATE INDEX channel_messages_deleted_by_container ON public.channel_messages USING btree (org_id, container, deleted_at) WHERE (deleted_at > 0);

CREATE INDEX channel_messages_edited_by_container ON public.channel_messages USING btree (org_id, container, edited_at) WHERE (edited_at > 0);

CREATE INDEX channel_messages_live_by_container ON public.channel_messages USING btree (org_id, container) WHERE (deleted = false);

CREATE UNIQUE INDEX channel_messages_surface_key ON public.channel_messages USING btree (tenant_id, org_id, surface, account, container, ts);

CREATE INDEX channel_messages_tsv ON public.channel_messages USING gin (tsv);

CREATE INDEX channel_policy_history_container ON public.channel_policy_history USING btree (org_id, container, id DESC);

CREATE UNIQUE INDEX channel_state_surface_key ON public.channel_state USING btree (tenant_id, org_id, surface, account, container);

CREATE INDEX consent_links_inbound_id ON public.consent_links USING btree (id);

CREATE INDEX credential_usage_by_scope_ts ON public.credential_usage USING btree (scope_label, ts DESC);

CREATE INDEX credential_usage_by_slug_ts_id ON public.credential_usage USING btree (slug, ts DESC, id DESC);

CREATE INDEX credential_usage_by_ts ON public.credential_usage USING btree (ts DESC);

CREATE INDEX crons_ownerscopeid_fold ON public.crons USING hash (lower((json ->> 'ownerScopeId'::text)));

CREATE INDEX crons_ownerscopeid_unicode ON public.crons USING btree (id) WHERE ((json ->> 'ownerScopeId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX crons_resource_search_gin ON public.crons USING gin (to_tsvector('simple'::regconfig, ((((COALESCE((json ->> 'title'::text), ''::text) || ' '::text) || COALESCE((json ->> 'action'::text), ''::text)) || ' '::text) || COALESCE((json ->> 'message'::text), ''::text))));

CREATE INDEX decision_rules_hook ON public.decision_rules USING btree (hook) WHERE (mode <> 'off'::text);

CREATE INDEX deployments_inbound_id ON public.deployments USING btree (id);

CREATE INDEX deployments_inbound_name ON public.deployments USING btree (((json ->> 'name'::text))) WHERE ((json ->> 'name'::text) IS NOT NULL);

CREATE UNIQUE INDEX deployments_name_unique ON public.deployments USING btree (tenant_id, ((json ->> 'name'::text))) WHERE ((json ->> 'name'::text) IS NOT NULL);

CREATE INDEX deployments_resource_search_gin ON public.deployments USING gin (to_tsvector('simple'::regconfig, ((COALESCE((json ->> 'displayName'::text), (json ->> 'name'::text), ''::text) || ' '::text) || COALESCE((json ->> 'name'::text), ''::text))));

CREATE INDEX directory_channels_lower_cid ON public.directory_channels USING btree (org_id, lower(channel_id));

CREATE INDEX directory_channels_name ON public.directory_channels USING btree (org_id, name_lc);

CREATE INDEX directory_group_members_principal ON public.directory_group_members USING btree (org_id, principal_id, group_id);

CREATE INDEX directory_members_lower_pid ON public.directory_members USING btree (org_id, lower(principal_id));

CREATE INDEX directory_members_name ON public.directory_members USING btree (org_id, display_name_lc);

CREATE INDEX directory_members_slack_id ON public.directory_members USING btree (org_id, slack_id);

CREATE INDEX egress_events_by_scope_ts ON public.egress_events USING btree (scope_label, ts DESC);

CREATE INDEX egress_events_by_ts ON public.egress_events USING btree (ts DESC);

CREATE INDEX environment_attachments_by_env ON public.environment_attachments USING btree (environment_id);

CREATE INDEX error_events_by_scope_ts ON public.error_events USING btree (scope_label, ts DESC);

CREATE INDEX error_events_by_session_ts ON public.error_events USING btree (session_id, ts DESC);

CREATE INDEX error_events_by_ts ON public.error_events USING btree (ts DESC);

CREATE INDEX file_artifacts_owner_created ON public.file_artifacts USING btree (owner_scope_id, created_at DESC, id DESC);

CREATE INDEX file_artifacts_owner_path ON public.file_artifacts USING btree (owner_scope_id, path);

CREATE INDEX file_artifacts_scope_created ON public.file_artifacts USING btree (created_in_scope, created_at DESC, id DESC) WHERE (enabled = true);

CREATE INDEX file_uploads_actor_state ON public.file_uploads USING btree (actor_id, state);

CREATE INDEX file_uploads_expiry ON public.file_uploads USING btree (expires_at) WHERE (state <> ALL (ARRAY['complete'::text, 'aborted'::text]));

CREATE INDEX file_uploads_retry ON public.file_uploads USING btree (next_attempt_at, expires_at) WHERE (state <> ALL (ARRAY['complete'::text, 'aborted'::text, 'failed'::text]));

CREATE INDEX idx_cron_fires_cron_fired_at ON public.cron_fires USING btree (cron_id, fired_at DESC);

CREATE INDEX idx_cron_fires_thread_ref ON public.cron_fires USING btree (thread_ref);

CREATE INDEX idx_deliveries_pending ON public.deliveries USING btree (((destination ->> 'type'::text)), created_at) WHERE (delivered_at IS NULL);

CREATE INDEX idx_deliveries_pending_heads ON public.deliveries USING btree (tenant_id, ((destination ->> 'type'::text)), ((destination ->> 'target'::text)), created_at, id) WHERE ((delivered_at IS NULL) AND (expired_at IS NULL) AND (NOT shadow));

CREATE INDEX idx_deliveries_pending_live ON public.deliveries USING btree (((destination ->> 'type'::text)), created_at) WHERE ((delivered_at IS NULL) AND (expired_at IS NULL));

CREATE INDEX idx_deliveries_recipient_thread ON public.deliveries USING btree (recipient_thread_ref, created_at) WHERE (recipient_thread_ref IS NOT NULL);

CREATE INDEX idx_deliveries_shadow ON public.deliveries USING btree (created_at) WHERE (shadow AND (delivered_at IS NULL));

CREATE INDEX idx_deliveries_source_session ON public.deliveries USING btree (((provenance ->> 'sourceSessionId'::text)), created_at) WHERE (provenance IS NOT NULL);

CREATE INDEX idx_deliveries_source_thread ON public.deliveries USING btree (((provenance ->> 'sourceThreadRef'::text)), created_at) WHERE (provenance IS NOT NULL);

CREATE INDEX idx_proc_scope_status ON public.process_sessions USING btree (scope_id, status);

CREATE INDEX idx_run_activity_created ON public.run_activity USING btree (created_at);

CREATE INDEX idx_run_activity_run ON public.run_activity USING btree (run_id, id);

CREATE INDEX idx_run_signals_pending ON public.run_signals USING btree (run_id) WHERE (consumed_at IS NULL);

CREATE INDEX idx_runs_created ON public.runs USING btree (created_at DESC);

CREATE UNIQUE INDEX idx_runs_one_running_per_session ON public.runs USING btree (tenant_id, session_id) WHERE (status = 'running'::text);

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

CREATE INDEX items_human_prompt ON public.items USING btree (tenant_id, session_id, seq DESC) WHERE ((kind = ANY (ARRAY['UserMessage'::public.item_kind, 'SteeringMessage'::public.item_kind])) AND (hidden IS DISTINCT FROM true) AND (NOT (body @> '{"overheard": true}'::jsonb)) AND (((body ->> 'speakerId'::text) IS NOT NULL) OR (body @> '{"slackReplyReceipt": true}'::jsonb) OR ((kind = 'SteeringMessage'::public.item_kind) AND (author IS NOT NULL))));

CREATE INDEX items_message_search ON public.items USING gin (tenant_id, search) WHERE ((kind = ANY (ARRAY['UserMessage'::public.item_kind, 'SteeringMessage'::public.item_kind, 'AgentMessage'::public.item_kind])) AND (variant IS DISTINCT FROM 'files_delivered'::text) AND (text IS NOT NULL));

CREATE UNIQUE INDEX items_one_call_per_kind ON public.items USING btree (tenant_id, session_id, kind, md5(call_id)) WHERE (call_id IS NOT NULL);

CREATE INDEX items_session_kind_created ON public.items USING btree (tenant_id, session_id, kind, created_at);

CREATE INDEX items_user_turns_by_author ON public.items USING btree (tenant_id, author, created_at) WHERE ((author IS NOT NULL) AND (author !~~ 'system:%'::text) AND (kind = ANY (ARRAY['UserMessage'::public.item_kind, 'SteeringMessage'::public.item_kind])) AND (NOT (body @> '{"overheard": true}'::jsonb)));

CREATE INDEX keychain_credentials_ownerid_fold ON public.keychain_credentials USING hash (lower((json ->> 'ownerId'::text)));

CREATE INDEX keychain_credentials_ownerid_unicode ON public.keychain_credentials USING btree (id) WHERE ((json ->> 'ownerId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX keychain_grants_ownerid_fold ON public.keychain_grants USING hash (lower((json ->> 'ownerId'::text)));

CREATE INDEX keychain_grants_ownerid_unicode ON public.keychain_grants USING btree (id) WHERE ((json ->> 'ownerId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX llm_prompt_envelopes_created_at ON public.llm_prompt_envelopes USING btree (created_at);

CREATE INDEX loop_ingress_deliveries_queuekey_fold ON public.loop_ingress_deliveries USING hash (lower((json ->> 'queueKey'::text)));

CREATE INDEX loop_ingress_deliveries_queuekey_unicode ON public.loop_ingress_deliveries USING btree (id) WHERE ((json ->> 'queueKey'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX loop_ingress_inbound_id ON public.loop_ingress USING btree (id);

CREATE INDEX loop_ingress_loopid_fold ON public.loop_ingress USING hash (lower((json ->> 'loopId'::text)));

CREATE INDEX loop_ingress_loopid_unicode ON public.loop_ingress USING btree (id) WHERE ((json ->> 'loopId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX loop_items_loopid_fold ON public.loop_items USING hash (lower((json ->> 'loopId'::text)));

CREATE INDEX loop_items_loopid_unicode ON public.loop_items USING btree (id) WHERE ((json ->> 'loopId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX loop_outputs_itemid_fold ON public.loop_outputs USING hash (lower((json ->> 'itemId'::text)));

CREATE INDEX loop_outputs_itemid_unicode ON public.loop_outputs USING btree (id) WHERE ((json ->> 'itemId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX memory_facts_live ON public.memory_facts USING btree (scope_id, id) WHERE (deleted_at IS NULL);

CREATE INDEX monitors_ownerscopeid_fold ON public.monitors USING hash (lower((json ->> 'ownerScopeId'::text)));

CREATE INDEX monitors_ownerscopeid_unicode ON public.monitors USING btree (id) WHERE ((json ->> 'ownerScopeId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX oauth_flows_inbound_id ON public.oauth_flows USING btree (id);

CREATE INDEX participants_by_principal ON public.participants USING btree (principal_id, session_id);

CREATE INDEX persona_access_grantee ON public.persona_access USING btree (grantee_scope_id);

CREATE UNIQUE INDEX persona_access_one_pin ON public.persona_access USING btree (tenant_id, grantee_scope_id) WHERE pinned;

CREATE UNIQUE INDEX run_signals_by_dedupe_key ON public.run_signals USING btree (tenant_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);

CREATE INDEX secret_drops_inbound_id ON public.secret_drops USING btree (id);

CREATE INDEX session_llm_requests_by_session ON public.session_llm_requests USING btree (session_id, created_at, step);

CREATE INDEX session_llm_requests_created_at ON public.session_llm_requests USING btree (created_at);

CREATE INDEX session_llm_requests_screens ON public.session_llm_requests USING btree (created_at DESC) WHERE (step = '-1'::integer);

CREATE INDEX session_llm_requests_session_spend_recovery ON public.session_llm_requests USING btree (session_id, created_at) WHERE (usage_json IS NOT NULL);

CREATE INDEX session_llm_requests_spend ON public.session_llm_requests USING btree (created_at, (((public.spend_usage_json(usage_json) ->> 'costUsd'::text))::double precision), (((public.spend_usage_json(usage_json) ->> 'input'::text))::bigint), (((public.spend_usage_json(usage_json) ->> 'output'::text))::bigint), (((public.spend_usage_json(usage_json) ->> 'cacheRead'::text))::bigint), (((public.spend_usage_json(usage_json) ->> 'cacheWrite'::text))::bigint)) INCLUDE (session_id, model, usage_json) WHERE ((usage_json IS NOT NULL) AND ((public.spend_usage_json(usage_json) IS NOT NULL) AND (((octet_length(session_id) + octet_length(model)) + octet_length(usage_json)) <= 2000)));

CREATE INDEX session_llm_requests_spend_wide ON public.session_llm_requests USING btree (created_at) WHERE ((usage_json IS NOT NULL) AND (NOT ((public.spend_usage_json(usage_json) IS NOT NULL) AND (((octet_length(session_id) + octet_length(model)) + octet_length(usage_json)) <= 2000))));

CREATE INDEX session_mailbox_recipientid_fold ON public.session_mailbox USING hash (lower((json ->> 'recipientId'::text)));

CREATE INDEX session_mailbox_recipientid_unicode ON public.session_mailbox USING btree (id) WHERE ((json ->> 'recipientId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX session_mailbox_wake_fold ON public.session_mailbox USING hash (lower((json ->> 'wake'::text)));

CREATE INDEX session_mailbox_wake_unicode ON public.session_mailbox USING btree (id) WHERE ((json ->> 'wake'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX session_pins_by_session ON public.session_pins USING btree (session_id, created_at);

CREATE INDEX session_shares_inbound_id ON public.session_shares USING btree (id);

CREATE INDEX sessions_by_activity ON public.sessions USING btree (COALESCE(last_activity, created_at) DESC, id DESC);

CREATE INDEX sessions_by_scope ON public.sessions USING btree (scope_id, created_at DESC);

CREATE INDEX sessions_by_scope_activity ON public.sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC);

CREATE INDEX sessions_conversations_by_scope_activity ON public.sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC) WHERE (origin = 'conversation'::text);

CREATE INDEX sessions_other_background_by_scope_activity ON public.sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC) WHERE (origin <> ALL (ARRAY['conversation'::text, 'cron'::text]));

CREATE INDEX sessions_side_chat_origin ON public.sessions USING btree (forked_from_session_id) WHERE (side_chat IS NOT NULL);

CREATE INDEX skills_resource_name_idx ON public.skills USING btree ((((json -> 'manifest'::text) ->> 'name'::text)));

CREATE INDEX skills_resource_search_gin ON public.skills USING gin (to_tsvector('simple'::regconfig, ((COALESCE(((json -> 'manifest'::text) ->> 'name'::text), ''::text) || ' '::text) || COALESCE(((json -> 'manifest'::text) ->> 'description'::text), ''::text))));

CREATE INDEX skills_scopeid_fold ON public.skills USING hash (lower((json ->> 'scopeId'::text)));

CREATE INDEX skills_scopeid_unicode ON public.skills USING btree (id) WHERE ((json ->> 'scopeId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX source_auth_replay_expires_at ON public.source_auth_replay USING btree (expires_at);

CREATE INDEX swarms_pending_fold ON public.swarms USING hash (lower((json ->> 'pending'::text)));

CREATE INDEX swarms_pending_unicode ON public.swarms USING btree (id) WHERE ((json ->> 'pending'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX team_members_principal ON public.team_members USING btree (principal_id);

CREATE INDEX team_rooms_scope ON public.team_rooms USING btree (scope_id);

CREATE UNIQUE INDEX tenants_app_handle ON public.tenants USING btree (public.qm_tenant_handle(settings));

CREATE UNIQUE INDEX tenants_partner_chat_account ON public.tenants USING btree (((settings ->> 'partnerChatAccount'::text)));

CREATE INDEX webhooks_inbound_id ON public.webhooks USING btree (id);

CREATE INDEX webhooks_ownerscopeid_fold ON public.webhooks USING hash (lower((json ->> 'ownerScopeId'::text)));

CREATE INDEX webhooks_ownerscopeid_unicode ON public.webhooks USING btree (id) WHERE ((json ->> 'ownerScopeId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX webhooks_resource_search_gin ON public.webhooks USING gin (to_tsvector('simple'::regconfig, ((COALESCE((json ->> 'action'::text), ''::text) || ' '::text) || COALESCE(((json -> 'verification'::text) ->> 'scheme'::text), ''::text))));

CREATE STATISTICS public.approval_grants_actorid_stats ON (json ->> 'actorId'::text) FROM public.approval_grants;

CREATE STATISTICS public.approvals_sessionid_stats ON (json ->> 'sessionId'::text) FROM public.approvals;

CREATE STATISTICS public.crons_ownerscopeid_stats ON (json ->> 'ownerScopeId'::text) FROM public.crons;

CREATE STATISTICS public.keychain_credentials_ownerid_stats ON (json ->> 'ownerId'::text) FROM public.keychain_credentials;

CREATE STATISTICS public.keychain_grants_ownerid_stats ON (json ->> 'ownerId'::text) FROM public.keychain_grants;

CREATE STATISTICS public.loop_ingress_deliveries_queuekey_stats ON (json ->> 'queueKey'::text) FROM public.loop_ingress_deliveries;

CREATE STATISTICS public.loop_ingress_loopid_stats ON (json ->> 'loopId'::text) FROM public.loop_ingress;

CREATE STATISTICS public.loop_items_loopid_stats ON (json ->> 'loopId'::text) FROM public.loop_items;

CREATE STATISTICS public.loop_outputs_itemid_stats ON (json ->> 'itemId'::text) FROM public.loop_outputs;

CREATE STATISTICS public.monitors_ownerscopeid_stats ON (json ->> 'ownerScopeId'::text) FROM public.monitors;

CREATE STATISTICS public.session_mailbox_recipientid_stats ON (json ->> 'recipientId'::text) FROM public.session_mailbox;

CREATE STATISTICS public.session_mailbox_wake_stats ON (json ->> 'wake'::text) FROM public.session_mailbox;

CREATE STATISTICS public.skills_scopeid_stats ON (json ->> 'scopeId'::text) FROM public.skills;

CREATE STATISTICS public.swarms_pending_stats ON (json ->> 'pending'::text) FROM public.swarms;

CREATE STATISTICS public.webhooks_ownerscopeid_stats ON (json ->> 'ownerScopeId'::text) FROM public.webhooks;

CREATE TRIGGER acl_grants_bump AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.acl_grants FOR EACH STATEMENT EXECUTE FUNCTION public.acl_grants_bump_version();

CREATE TRIGGER blobs_immutable BEFORE DELETE OR UPDATE ON public.blobs FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

CREATE TRIGGER blobs_no_truncate BEFORE TRUNCATE ON public.blobs FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();

CREATE TRIGGER items_append_only BEFORE UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

CREATE TRIGGER items_delete_through_session BEFORE DELETE ON public.items FOR EACH ROW EXECUTE FUNCTION public.forbid_direct_delete();

CREATE TRIGGER items_no_truncate BEFORE TRUNCATE ON public.items FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();

CREATE TRIGGER memory_facts_text_hash BEFORE INSERT OR UPDATE OF text ON public.memory_facts FOR EACH ROW EXECUTE FUNCTION public.memory_facts_text_hash();

CREATE TRIGGER session_llm_requests_spend_dirty AFTER INSERT OR DELETE OR UPDATE OF created_at, session_id, model, usage_json ON public.session_llm_requests FOR EACH ROW EXECUTE FUNCTION public.invalidate_request_spend();

CREATE TRIGGER sessions_spend_dirty AFTER INSERT OR DELETE OR UPDATE OF id, scope_id, origin, thread_ref, parent_session_id ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.invalidate_session_spend();

ALTER TABLE ONLY public.ack_emoji_picks
    ADD CONSTRAINT ack_emoji_picks_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.ack_emoji
    ADD CONSTRAINT ack_emoji_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.acl_grants
    ADD CONSTRAINT acl_grants_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.acl_grants_version
    ADD CONSTRAINT acl_grants_version_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.activity_seeds_configs
    ADD CONSTRAINT activity_seeds_configs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.admin_grants
    ADD CONSTRAINT admin_grants_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.ambient_cursors
    ADD CONSTRAINT ambient_cursors_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.ambient_judgments
    ADD CONSTRAINT ambient_judgments_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.app_page_views
    ADD CONSTRAINT app_page_views_deployment_id_fkey FOREIGN KEY (tenant_id, deployment_id) REFERENCES public.deployments(tenant_id, id);

ALTER TABLE ONLY public.app_page_views
    ADD CONSTRAINT app_page_views_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.approval_grant_modes
    ADD CONSTRAINT approval_grant_modes_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.approval_grants
    ADD CONSTRAINT approval_grants_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.aws_deploy_bodies
    ADD CONSTRAINT aws_deploy_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.aws_sandbox_bodies
    ADD CONSTRAINT aws_sandbox_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.base_model_configs
    ADD CONSTRAINT base_model_configs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.branding_configs
    ADD CONSTRAINT branding_configs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.browse_max_steps_configs
    ADD CONSTRAINT browse_max_steps_configs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.budget_spend
    ADD CONSTRAINT budget_spend_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.channel_files
    ADD CONSTRAINT channel_files_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.channel_header_pin_flag
    ADD CONSTRAINT channel_header_pin_flag_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.channel_messages
    ADD CONSTRAINT channel_messages_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.channel_policy_history
    ADD CONSTRAINT channel_policy_history_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.channel_policy
    ADD CONSTRAINT channel_policy_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.channel_state
    ADD CONSTRAINT channel_state_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.command_policies
    ADD CONSTRAINT command_policies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.composio_returns
    ADD CONSTRAINT composio_returns_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.connector_clients
    ADD CONSTRAINT connector_clients_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.consent_links
    ADD CONSTRAINT consent_links_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.context_requests
    ADD CONSTRAINT context_requests_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.credential_daily_calls
    ADD CONSTRAINT credential_daily_calls_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.credential_usage
    ADD CONSTRAINT credential_usage_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.cron_fires
    ADD CONSTRAINT cron_fires_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.crons
    ADD CONSTRAINT crons_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.custom_model_providers
    ADD CONSTRAINT custom_model_providers_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.deactivated_principals
    ADD CONSTRAINT deactivated_principals_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.decision_providers
    ADD CONSTRAINT decision_providers_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.decision_rules
    ADD CONSTRAINT decision_rules_provider_id_fkey FOREIGN KEY (tenant_id, provider_id) REFERENCES public.decision_providers(tenant_id, provider_id);

ALTER TABLE ONLY public.decision_rules
    ADD CONSTRAINT decision_rules_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.deploy_git_repos
    ADD CONSTRAINT deploy_git_repos_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.deployment_access
    ADD CONSTRAINT deployment_access_id_fkey FOREIGN KEY (tenant_id, id) REFERENCES public.deployments(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.deployment_access
    ADD CONSTRAINT deployment_access_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.deployment_drafts
    ADD CONSTRAINT deployment_drafts_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.deployment_identity
    ADD CONSTRAINT deployment_identity_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.directory_channel_members
    ADD CONSTRAINT directory_channel_members_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.directory_channels
    ADD CONSTRAINT directory_channels_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.directory_group_members
    ADD CONSTRAINT directory_group_members_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.directory_groups
    ADD CONSTRAINT directory_groups_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.directory_members
    ADD CONSTRAINT directory_members_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.directory_meta
    ADD CONSTRAINT directory_meta_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.directory_sync
    ADD CONSTRAINT directory_sync_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.do_managed_agents_sandbox_bodies
    ADD CONSTRAINT do_managed_agents_sandbox_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.durable_map_versions
    ADD CONSTRAINT durable_map_versions_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.e2b_sandbox_bodies
    ADD CONSTRAINT e2b_sandbox_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.egress_events
    ADD CONSTRAINT egress_events_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.egress_policies
    ADD CONSTRAINT egress_policies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.environment_attachments
    ADD CONSTRAINT environment_attachments_environment_id_fkey FOREIGN KEY (tenant_id, environment_id) REFERENCES public.environments(tenant_id, id);

ALTER TABLE ONLY public.environment_attachments
    ADD CONSTRAINT environment_attachments_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.error_events
    ADD CONSTRAINT error_events_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.external_members
    ADD CONSTRAINT external_members_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.external_slack_participants_flag
    ADD CONSTRAINT external_slack_participants_flag_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.file_artifact_deletions
    ADD CONSTRAINT file_artifact_deletions_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.file_artifacts
    ADD CONSTRAINT file_artifacts_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.fly_deploy_configs
    ADD CONSTRAINT fly_deploy_configs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.idempotency
    ADD CONSTRAINT idempotency_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.individual_model_auth_flag
    ADD CONSTRAINT individual_model_auth_flag_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.interactive_fast_mode_flag
    ADD CONSTRAINT interactive_fast_mode_flag_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_blob FOREIGN KEY (tenant_id, blob_sha) REFERENCES public.blobs(tenant_id, sha256);

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_session_id_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES public.sessions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.keychain_asks
    ADD CONSTRAINT keychain_asks_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.keychain_credentials
    ADD CONSTRAINT keychain_credentials_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.keychain_grants
    ADD CONSTRAINT keychain_grants_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.llm_prompt_envelopes
    ADD CONSTRAINT llm_prompt_envelopes_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.loop_ingress_deliveries
    ADD CONSTRAINT loop_ingress_deliveries_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.loop_ingress
    ADD CONSTRAINT loop_ingress_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.loop_items
    ADD CONSTRAINT loop_items_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.loop_outputs
    ADD CONSTRAINT loop_outputs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.loop_ship_grants
    ADD CONSTRAINT loop_ship_grants_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.loops
    ADD CONSTRAINT loops_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.memory_facts
    ADD CONSTRAINT memory_facts_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.memory_registry
    ADD CONSTRAINT memory_registry_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.memory_tidy_profiles
    ADD CONSTRAINT memory_tidy_profiles_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.modal_sandbox_bodies
    ADD CONSTRAINT modal_sandbox_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.model_credentials
    ADD CONSTRAINT model_credentials_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.model_registry
    ADD CONSTRAINT model_registry_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.monitors
    ADD CONSTRAINT monitors_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.oauth_flows
    ADD CONSTRAINT oauth_flows_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.org_ambient_flag
    ADD CONSTRAINT org_ambient_flag_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.persona_access
    ADD CONSTRAINT persona_access_granted_by_fkey FOREIGN KEY (tenant_id, granted_by) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.persona_access
    ADD CONSTRAINT persona_access_persona_id_fkey FOREIGN KEY (tenant_id, persona_id) REFERENCES public.personas(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.persona_access
    ADD CONSTRAINT persona_access_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.persona_versions
    ADD CONSTRAINT persona_versions_edited_by_fkey FOREIGN KEY (tenant_id, edited_by) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.persona_versions
    ADD CONSTRAINT persona_versions_persona_id_fkey FOREIGN KEY (tenant_id, persona_id) REFERENCES public.personas(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.persona_versions
    ADD CONSTRAINT persona_versions_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.porter_deploy_bodies
    ADD CONSTRAINT porter_deploy_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.process_sessions
    ADD CONSTRAINT process_sessions_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.prompt_snapshots
    ADD CONSTRAINT prompt_snapshots_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.render_app_storage
    ADD CONSTRAINT render_app_storage_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.render_deploy_bodies
    ADD CONSTRAINT render_deploy_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.render_deploy_credentials
    ADD CONSTRAINT render_deploy_credentials_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.render_sandbox_bodies
    ADD CONSTRAINT render_sandbox_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.render_sandbox_cleanup
    ADD CONSTRAINT render_sandbox_cleanup_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.render_scratch_bodies
    ADD CONSTRAINT render_scratch_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.run_activity
    ADD CONSTRAINT run_activity_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.run_signals
    ADD CONSTRAINT run_signals_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.sandbox_defaults
    ADD CONSTRAINT sandbox_defaults_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.sandbox_loads
    ADD CONSTRAINT sandbox_loads_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.sandbox_resource_rollout
    ADD CONSTRAINT sandbox_resource_rollout_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.sandbox_resources
    ADD CONSTRAINT sandbox_resources_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.sandbox_routing
    ADD CONSTRAINT sandbox_routing_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.secret_drops
    ADD CONSTRAINT secret_drops_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.security_postures
    ADD CONSTRAINT security_postures_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.session_goals
    ADD CONSTRAINT session_goals_session_id_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES public.sessions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.session_goals
    ADD CONSTRAINT session_goals_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.session_llm_requests
    ADD CONSTRAINT session_llm_requests_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.session_mailbox
    ADD CONSTRAINT session_mailbox_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.session_pins
    ADD CONSTRAINT session_pins_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.session_shares
    ADD CONSTRAINT session_shares_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.session_spend_days
    ADD CONSTRAINT session_spend_days_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.session_spend_dirty
    ADD CONSTRAINT session_spend_dirty_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.sharing_postures
    ADD CONSTRAINT sharing_postures_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.skill_bundles
    ADD CONSTRAINT skill_bundles_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.skill_packs
    ADD CONSTRAINT skill_packs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.slack_accounts
    ADD CONSTRAINT slack_accounts_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.slack_emoji_catalog
    ADD CONSTRAINT slack_emoji_catalog_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.slack_installation
    ADD CONSTRAINT slack_installation_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.slack_session_status
    ADD CONSTRAINT slack_session_status_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.slack_staged_envelopes
    ADD CONSTRAINT slack_staged_envelopes_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.slack_task_acknowledgements
    ADD CONSTRAINT slack_task_acknowledgements_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.smolmachines_sandbox_bodies
    ADD CONSTRAINT smolmachines_sandbox_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.soul_configs
    ADD CONSTRAINT soul_configs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.soul_history
    ADD CONSTRAINT soul_history_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.spend_limit_configs
    ADD CONSTRAINT spend_limit_configs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.sprites_initialization
    ADD CONSTRAINT sprites_initialization_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.suggested_activity_profiles
    ADD CONSTRAINT suggested_activity_profiles_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.superserve_sandbox_bodies
    ADD CONSTRAINT superserve_sandbox_bodies_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.swarms
    ADD CONSTRAINT swarms_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (tenant_id, team_id) REFERENCES public.teams(tenant_id, team_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.team_rooms
    ADD CONSTRAINT team_rooms_team_id_fkey FOREIGN KEY (tenant_id, team_id) REFERENCES public.teams(tenant_id, team_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.team_rooms
    ADD CONSTRAINT team_rooms_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.user_links
    ADD CONSTRAINT user_links_linked_by_fkey FOREIGN KEY (tenant_id, linked_by) REFERENCES public.users(tenant_id, id) ON DELETE SET NULL (linked_by);

ALTER TABLE ONLY public.user_links
    ADD CONSTRAINT user_links_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.user_links
    ADD CONSTRAINT user_links_user_id_fkey FOREIGN KEY (tenant_id, user_id) REFERENCES public.users(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_offboarded_by_fkey FOREIGN KEY (tenant_id, offboarded_by) REFERENCES public.users(tenant_id, id) ON DELETE SET NULL (offboarded_by);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_primary_alias_link FOREIGN KEY (tenant_id, id, primary_alias) REFERENCES public.user_links(tenant_id, user_id, alias_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.web_ui_state
    ADD CONSTRAINT web_ui_state_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.webhook_history
    ADD CONSTRAINT webhook_history_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.webui_model_configs
    ADD CONSTRAINT webui_model_configs_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE public.ack_emoji ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ack_emoji_picks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.acl_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.acl_grants_version ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.activity_seeds_configs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.admin_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ambient_cursors ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ambient_judgments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.app_page_views ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.approval_grant_modes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.approval_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.aws_deploy_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.aws_sandbox_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.base_model_configs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.blobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.branding_configs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.browse_max_steps_configs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.browser_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.budget_spend ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.channel_files ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.channel_header_pin_flag ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.channel_messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.channel_policy ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.channel_policy_history ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.channel_state ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.command_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.composio_returns ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.connector_clients ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.consent_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.context_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.credential_daily_calls ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.credential_usage ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cron_fires ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.crons ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.custom_model_providers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.deactivated_principals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.decision_providers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.decision_rules ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.deploy_git_repos ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.deployment_access ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.deployment_drafts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.deployment_identity ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.directory_channel_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.directory_channels ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.directory_group_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.directory_groups ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.directory_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.directory_meta ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.directory_sync ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.do_managed_agents_sandbox_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.durable_map_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.e2b_sandbox_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.egress_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.egress_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.environment_attachments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.environments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.error_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.external_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.external_slack_participants_flag ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.file_artifact_deletions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.file_artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.file_uploads ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fly_deploy_configs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.idempotency ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.individual_model_auth_flag ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.interactive_fast_mode_flag ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.keychain_asks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.keychain_credentials ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.keychain_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.llm_prompt_envelopes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.loop_ingress ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.loop_ingress_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.loop_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.loop_outputs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.loop_ship_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.loops ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.mcp_servers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.memory_facts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.memory_registry ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.memory_tidy_profiles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.modal_sandbox_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.model_credentials ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.model_registry ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.monitors ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.oauth_flows ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.org_ambient_flag ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.persona_access ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.persona_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.personas ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.porter_deploy_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.process_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.prompt_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.render_app_storage ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.render_deploy_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.render_deploy_credentials ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.render_sandbox_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.render_sandbox_cleanup ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.render_scratch_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.run_activity ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.run_signals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sandbox_defaults ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sandbox_loads ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sandbox_resource_rollout ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sandbox_resources ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sandbox_routing ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.secret_drops ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.security_postures ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.session_goals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.session_llm_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.session_mailbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.session_pins ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.session_shares ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.session_spend_days ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.session_spend_dirty ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sharing_postures ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.skill_bundles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.skill_packs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.skills ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.slack_accounts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.slack_emoji_catalog ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.slack_installation ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.slack_session_status ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.slack_staged_envelopes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.slack_task_acknowledgements ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.smolmachines_sandbox_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.soul_configs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.soul_history ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.spend_limit_configs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sprites_initialization ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.suggested_activity_profiles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.superserve_sandbox_bodies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.swarms ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.team_rooms ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.ack_emoji USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.ack_emoji_picks USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.acl_grants USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.acl_grants_version USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.activity_seeds_configs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.admin_grants USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.ambient_cursors USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.ambient_judgments USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.app_page_views USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.approval_grant_modes USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.approval_grants USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.approvals USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.audit_log USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.aws_deploy_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.aws_sandbox_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.base_model_configs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.blobs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.branding_configs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.browse_max_steps_configs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.browser_sessions USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.budget_spend USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.channel_files USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.channel_header_pin_flag USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.channel_messages USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.channel_policy USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.channel_policy_history USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.channel_state USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.command_policies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.composio_returns USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.connector_clients USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.consent_links USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.context_requests USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.credential_daily_calls USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.credential_usage USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.cron_fires USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.crons USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.custom_model_providers USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.deactivated_principals USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.decision_providers USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.decision_rules USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.deliveries USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.deploy_git_repos USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.deployment_access USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.deployment_drafts USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.deployment_identity USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.deployments USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.directory_channel_members USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.directory_channels USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.directory_group_members USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.directory_groups USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.directory_members USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.directory_meta USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.directory_sync USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.do_managed_agents_sandbox_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.durable_map_versions USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.e2b_sandbox_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.egress_events USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.egress_policies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.environment_attachments USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.environments USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.error_events USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.external_members USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.external_slack_participants_flag USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.feature_flags USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.file_artifact_deletions USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.file_artifacts USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.file_uploads USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.fly_deploy_configs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.idempotency USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.individual_model_auth_flag USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.interactive_fast_mode_flag USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.items USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.keychain_asks USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.keychain_credentials USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.keychain_grants USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.llm_prompt_envelopes USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.loop_ingress USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.loop_ingress_deliveries USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.loop_items USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.loop_outputs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.loop_ship_grants USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.loops USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.mcp_servers USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.memory_facts USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.memory_registry USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.memory_tidy_profiles USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.modal_sandbox_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.model_credentials USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.model_registry USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.monitors USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.oauth_flows USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.org_ambient_flag USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.participants USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.persona_access USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.persona_versions USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.personas USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.porter_deploy_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.process_sessions USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.projects USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.prompt_snapshots USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.render_app_storage USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.render_deploy_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.render_deploy_credentials USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.render_sandbox_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.render_sandbox_cleanup USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.render_scratch_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.run_activity USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.run_signals USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.runs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.sandbox_defaults USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.sandbox_loads USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.sandbox_resource_rollout USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.sandbox_resources USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.sandbox_routing USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.secret_drops USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.security_postures USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.session_goals USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.session_llm_requests USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.session_mailbox USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.session_pins USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.session_shares USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.session_spend_days USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.session_spend_dirty USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.sessions USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.sharing_postures USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.skill_bundles USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.skill_packs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.skills USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.slack_accounts USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.slack_emoji_catalog USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.slack_installation USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.slack_session_status USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.slack_staged_envelopes USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.slack_task_acknowledgements USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.smolmachines_sandbox_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.soul_configs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.soul_history USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.spend_limit_configs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.sprites_initialization USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.suggested_activity_profiles USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.superserve_sandbox_bodies USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.swarms USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.team_members USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.team_rooms USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.teams USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.tenants FOR SELECT USING ((id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.user_links USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.users USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.web_ui_state USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.webhook_history USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.webhooks USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

CREATE POLICY tenant_isolation ON public.webui_model_configs USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.web_ui_state ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.webhook_history ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.webui_model_configs ENABLE ROW LEVEL SECURITY;

INSERT INTO public.tenants DEFAULT VALUES;
