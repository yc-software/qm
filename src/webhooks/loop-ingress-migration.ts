const RANDOM_SECRET = "replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')";

const SLACK_FILTERS = `CASE WHEN i.json ->> 'kind' = 'slack' THEN NULLIF(
       CASE WHEN jsonb_typeof(i.json -> 'channels') = 'array' AND jsonb_array_length(i.json -> 'channels') > 0
         THEN jsonb_build_array(jsonb_build_object('path', 'event.channel', 'in', i.json -> 'channels')) ELSE '[]'::jsonb END
       || CASE WHEN COALESCE(i.json ->> 'teamId', '') <> ''
         THEN jsonb_build_array(jsonb_build_object('path', 'team_id', 'in', jsonb_build_array(i.json ->> 'teamId'))) ELSE '[]'::jsonb END,
       '[]'::jsonb) END`;

function loopIngressToWebhooks(tenant: boolean): string {
  const col = tenant ? "tenant_id, " : "";
  const same = (a: string, b: string) => (tenant ? ` AND ${a}.tenant_id = ${b}.tenant_id` : "");
  return `INSERT INTO webhooks (${col}id, owner_scope_id, owner, created_by, destination, enabled, created_at,
       last_fired_at, action, verification, filters, last_error)
     SELECT ${tenant ? "i.tenant_id, " : ""}i.id,
            COALESCE(c.owner_scope_id, l.json ->> 'ownerScopeId', 'personal:' || (i.json ->> 'owner')),
            i.json ->> 'owner',
            i.json ->> 'owner',
            c.destination,
            COALESCE((i.json ->> 'enabled')::boolean, false) AND COALESCE(c.enabled, false),
            COALESCE((i.json ->> 'createdAt')::numeric::bigint, (extract(epoch FROM clock_timestamp()) * 1000)::bigint),
            (i.json ->> 'lastReceivedAt')::numeric::bigint,
            COALESCE(c.action, l.json ->> 'playbook', ''),
            jsonb_build_object(
              'scheme', CASE i.json ->> 'kind' WHEN 'slack' THEN 'slack' WHEN 'gmail' THEN 'google-pubsub' ELSE 'hmac-sha256' END,
              'secret', COALESCE(NULLIF(i.json ->> 'secret', ''), ${RANDOM_SECRET})),
            ${SLACK_FILTERS},
            i.json ->> 'lastError'
     FROM loop_ingress i
     LEFT JOIN loops l ON l.id = i.json ->> 'loopId'${same("l", "i")}
     LEFT JOIN crons c ON c.id = l.json ->> 'cronId'${same("c", "l")}
     WHERE i.json ->> 'kind' IN ('webhook', 'slack', 'gmail')
     ON CONFLICT DO NOTHING;`;
}

export const LOOP_INGRESS_TO_WEBHOOKS_MIGRATION = {
  id: "triggers/webhooks/0003-loop-ingress",
  statements: [
    `DO $loop_ingress$
     BEGIN
       IF to_regclass('loop_ingress') IS NULL THEN
         RETURN;
       END IF;
       IF to_regclass('loops') IS NULL THEN
         IF EXISTS (SELECT 1 FROM loop_ingress) THEN
           RAISE EXCEPTION 'loop_ingress has rows but loops is missing';
         END IF;
         RETURN;
       END IF;
       IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'loop_ingress'::regclass AND attname = 'tenant_id' AND NOT attisdropped) THEN
         ${loopIngressToWebhooks(true)}
       ELSE
         ${loopIngressToWebhooks(false)}
       END IF;
     END
     $loop_ingress$`,
    "DROP TABLE IF EXISTS loop_ingress_deliveries",
    "DROP TABLE IF EXISTS loop_ingress",
  ],
};
