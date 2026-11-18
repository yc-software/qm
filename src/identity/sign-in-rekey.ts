import { fold } from "./user-tenancy.ts";

type Ids = { tenant: string; alias: string; canonical: string };
type Kind = "principal" | "scope";

interface Column {
  table: string;
  column: string;
  kind: Kind;
  unique?: readonly string[];
}

interface Document {
  table: string;
  id?: Kind | "principal#";
  principals?: readonly string[];
  scopes?: readonly string[];
  lists?: readonly string[];
}

interface Step {
  table: string;
  label?: string;
  needs?: readonly string[];
  once?: string[];
  each?: (ids: Ids) => string[];
  from: string;
  hit: (ids: Ids) => string;
  conflicts: (ids: Ids) => string;
}

const SCOPE_SETTINGS = [
  "soul_configs",
  "base_model_configs",
  "webui_model_configs",
  "spend_limit_configs",
  "browse_max_steps_configs",
  "activity_seeds_configs",
  "ack_emoji",
  "branding_configs",
  "command_policies",
  "security_postures",
  "sharing_postures",
  "approval_grant_modes",
  "egress_policies",
  "channel_header_pin_flag",
  "external_slack_participants_flag",
  "individual_model_auth_flag",
];

const COLUMNS: Column[] = [
  { table: "participants", column: "principal_id", kind: "principal", unique: ["session_id"] },
  { table: "sessions", column: "scope_id", kind: "scope" },
  { table: "acl_grants", column: "owner_scope_id", kind: "scope", unique: ["path", "grantee_scope_id", "permission"] },
  { table: "acl_grants", column: "grantee_scope_id", kind: "scope", unique: ["owner_scope_id", "path", "permission"] },
  { table: "admin_grants", column: "principal_id", kind: "principal", unique: ["scope_id", "role"] },
  { table: "file_artifacts", column: "owner_scope_id", kind: "scope" },
  { table: "file_artifacts", column: "created_in_scope", kind: "scope" },
  { table: "file_artifacts", column: "created_by", kind: "principal" },
  { table: "file_uploads", column: "actor_id", kind: "principal" },
  { table: "memory_facts", column: "scope_id", kind: "scope" },
  { table: "memory_facts", column: "author", kind: "principal" },
  { table: "memory_fact_vectors", column: "scope_id", kind: "scope", unique: ["model", "fact_id"] },
  { table: "environments", column: "owner_actor_id", kind: "principal" },
  { table: "environment_attachments", column: "scope_id", kind: "scope", unique: [] },
  { table: "team_members", column: "principal_id", kind: "principal", unique: ["team_id"] },
  { table: "persona_access", column: "grantee_scope_id", kind: "scope", unique: ["persona_id"] },
];

const TRIGGER = { principals: ["owner", "createdBy"], scopes: ["ownerScopeId"] };

const DOCUMENTS: Document[] = [
  ...SCOPE_SETTINGS.map((table): Document => ({ table, id: "scope", scopes: ["scopeId"] })),
  { table: "sandbox_defaults", id: "scope" },
  { table: "memory_tidy_profiles", id: "scope" },
  { table: "suggested_activity_profiles", id: "principal" },
  { table: "web_ui_state", id: "principal#" },
  { table: "slack_accounts", id: "principal", principals: ["principalId"] },
  { table: "keychain_grants", principals: ["ownerId", "usedBy"], scopes: ["audienceScopeId"] },
  { table: "approval_grants", principals: ["actorId"] },
  { table: "loop_ship_grants", principals: ["actorId"] },
  ...["crons", "loops", "webhooks", "monitors"].map((table): Document => ({ table, ...TRIGGER })),
  { table: "loop_ingress", principals: ["owner"] },
  { table: "skills", principals: ["createdBy"], scopes: ["scopeId"] },
  { table: "skill_packs", principals: ["createdBy"], scopes: ["targetScopeId"] },
  { table: "deployments", principals: ["createdBy"], scopes: ["ownerScopeId", "createdInScope"] },
  { table: "sandbox_resources", principals: ["createdBy"], scopes: ["ownerScopeId"] },
  { table: "projects", principals: ["ownerId"], lists: ["memberIds", "channelMemberIds"] },
];

const MOVES = `SELECT l.tenant_id AS t, l.alias_id AS a, u.primary_alias AS c
  FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
 WHERE l.alias_id <> u.primary_alias
   AND l.tenant_id = coalesce(nullif(current_setting('qm.tenant_id', true), '')::uuid, l.tenant_id)`;

const MOVE: Ids = { tenant: "m.t", alias: "m.a", canonical: "m.c" };

const isPrincipal = (expr: string, ids: Ids) => `${fold(expr)} = ${ids.alias}`;
const isScope = (expr: string, ids: Ids) =>
  `(${expr} LIKE 'personal:%' AND ${fold(`substr(${expr}, 10)`)} = ${ids.alias})`;
const matches = (kind: Kind, expr: string, ids: Ids) =>
  kind === "principal" ? isPrincipal(expr, ids) : isScope(expr, ids);
const target = (kind: Kind, ids: Ids) => (kind === "principal" ? ids.canonical : `'personal:' || ${ids.canonical}`);

function columnStep({ table, column, kind, unique }: Column): Step {
  const hit = (ids: Ids) => `x.tenant_id = ${ids.tenant} AND ${matches(kind, `x.${column}`, ids)}`;
  const taken = (ids: Ids) =>
    unique
      ? `EXISTS (SELECT 1 FROM ${table} y WHERE y.tenant_id = x.tenant_id AND y.${column} = ${target(kind, ids)}${unique
          .map((key) => ` AND y.${key} = x.${key}`)
          .join("")})`
      : "false";
  return {
    table,
    label: `${table}.${column}`,
    once: [
      ...(unique ? [`DELETE FROM ${table} x USING (${MOVES}) m WHERE ${hit(MOVE)} AND ${taken(MOVE)}`] : []),
      `UPDATE ${table} x SET ${column} = ${target(kind, MOVE)} FROM (${MOVES}) m WHERE ${hit(MOVE)}`,
    ],
    from: `${table} x`,
    hit,
    conflicts: taken,
  };
}

function idMatch(doc: Document, ids: Ids): string {
  if (doc.id === "principal#") return `(position('#' IN x.id) > 0 AND ${isPrincipal("split_part(x.id, '#', 1)", ids)})`;
  return doc.id ? matches(doc.id, "x.id", ids) : "false";
}

function idTarget(doc: Document, ids: Ids): string {
  if (doc.id === "principal#") return `${ids.canonical} || substr(x.id, position('#' IN x.id))`;
  return doc.id ? target(doc.id, ids) : "x.id";
}

function listed(json: string, field: string, ids: Ids): string {
  const elements = `SELECT DISTINCT ON (v) v, o FROM (SELECT CASE WHEN ${isPrincipal("e", ids)} THEN ${ids.canonical}
      ELSE e END AS v, o FROM jsonb_array_elements_text(${json} -> '${field}') WITH ORDINALITY AS a(e, o)) s ORDER BY v, o`;
  return `CASE WHEN jsonb_typeof(${json} -> '${field}') = 'array' THEN jsonb_set(${json}, '{${field}}',
    (SELECT coalesce(jsonb_agg(v ORDER BY o), '[]'::jsonb) FROM (${elements}) d)) ELSE ${json} END`;
}

function documentStep(doc: Document): Step {
  const fields = (ids: Ids) => [
    ...(doc.principals ?? []).map((f) => [f, isPrincipal(`x.json ->> '${f}'`, ids), ids.canonical] as const),
    ...(doc.scopes ?? []).map((f) => [f, isScope(`x.json ->> '${f}'`, ids), target("scope", ids)] as const),
  ];
  const inList = (ids: Ids, f: string) =>
    `EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(x.json -> '${f}') = 'array'
       THEN x.json -> '${f}' END) e WHERE ${isPrincipal("e", ids)})`;
  const hit = (ids: Ids) =>
    `x.tenant_id = ${ids.tenant} AND (${[
      idMatch(doc, ids),
      ...fields(ids).map(([, m]) => m),
      ...(doc.lists ?? []).map((f) => inList(ids, f)),
    ].join(" OR ")})`;
  const taken = (ids: Ids) =>
    doc.id
      ? `(${idMatch(doc, ids)} AND EXISTS (SELECT 1 FROM ${doc.table} y WHERE y.tenant_id = x.tenant_id AND y.id = ${idTarget(doc, ids)}))`
      : "false";
  const json = (ids: Ids) =>
    (doc.lists ?? []).reduce(
      (expr, f) => listed(expr, f, ids),
      fields(ids).reduce(
        (expr, [f, m, value]) =>
          `CASE WHEN ${m} THEN jsonb_set(${expr}, '{${f}}', to_jsonb(${value})) ELSE ${expr} END`,
        "x.json",
      ),
    );
  return {
    table: doc.table,
    each: (ids) => [
      ...(doc.id ? [`DELETE FROM ${doc.table} x WHERE ${hit(ids)} AND ${taken(ids)}`] : []),
      `UPDATE ${doc.table} x SET id = CASE WHEN ${idMatch(doc, ids)} THEN ${idTarget(doc, ids)} ELSE x.id END,
         json = ${json(ids)} WHERE ${hit(ids)}`,
    ],
    from: `${doc.table} x`,
    hit,
    conflicts: taken,
  };
}

const hash = (...parts: string[]) =>
  `left(encode(sha256(${parts.map((part) => `convert_to(${part}, 'UTF8')`).join(" || '\\x00'::bytea || ")}), 'hex'), 16)`;
const SLOT = `'oauth:' || CASE WHEN coalesce(x.json -> 'refresh' ->> 'accountType', 'default') = 'default' THEN ''
  ELSE x.json -> 'refresh' ->> 'accountType' END`;
const connectorId = (owner: string) => hash(owner, "x.json ->> 'service'", SLOT);
const ownCredential = (ids: Ids) => `x.tenant_id = ${ids.tenant} AND ${isPrincipal("x.json ->> 'ownerId'", ids)}`;
const connector = (ids: Ids) =>
  `${ownCredential(ids)} AND x.json ->> 'managed' = 'connector' AND x.id = ${connectorId("(x.json ->> 'ownerId')")}`;
const connectorTaken = (ids: Ids) =>
  `EXISTS (SELECT 1 FROM keychain_credentials y WHERE y.tenant_id = x.tenant_id AND y.id = ${connectorId(ids.canonical)})`;

const keychainStep: Step = {
  table: "keychain_credentials",
  needs: ["keychain_grants"],
  each: (ids) => {
    const grant = `g.tenant_id = x.tenant_id AND g.json ->> 'credentialId' = x.id`;
    const newId = `CASE WHEN ${connector(ids)} THEN ${connectorId(ids.canonical)} ELSE x.id END`;
    return [
      `DELETE FROM keychain_grants g USING keychain_credentials x WHERE ${grant} AND ${connector(ids)} AND ${connectorTaken(ids)}`,
      `DELETE FROM keychain_credentials x WHERE ${connector(ids)} AND ${connectorTaken(ids)}`,
      `UPDATE keychain_grants g SET json = jsonb_set(g.json, '{credentialId}', to_jsonb(${connectorId(ids.canonical)}))
         FROM keychain_credentials x WHERE ${grant} AND ${connector(ids)}`,
      `UPDATE keychain_credentials x SET id = ${newId},
         json = jsonb_set(jsonb_set(x.json, '{ownerId}', to_jsonb(${ids.canonical})), '{id}', to_jsonb(${newId}))
       WHERE ${ownCredential(ids)}`,
    ];
  },
  from: "keychain_credentials x",
  hit: ownCredential,
  conflicts: (ids) => `x.json ->> 'managed' = 'connector' AND x.id = ${connectorId("(x.json ->> 'ownerId')")}
    AND ${connectorTaken(ids)}`,
};

const token = (value: string) => `to_jsonb(${value})::text`;
const brain = (owner: string) => `'member-' || ${hash(owner)}`;
const registryHit = (ids: Ids) =>
  `x.tenant_id = ${ids.tenant} AND (strpos(x.json::text, ${token(ids.alias)}) > 0
    OR strpos(x.json::text, ${token(`'personal:' || ${ids.alias}`)}) > 0)`;
const registryTaken = (ids: Ids) =>
  `(strpos(x.json::text, ${token(brain(ids.alias))}) > 0 AND strpos(x.json::text, ${token(brain(ids.canonical))}) > 0)`;

const registryStep: Step = {
  table: "memory_registry",
  each: (ids) => {
    const swaps = [
      [brain(ids.alias), brain(ids.canonical)],
      [`'personal:' || ${ids.alias}`, `'personal:' || ${ids.canonical}`],
      [ids.alias, ids.canonical],
    ] as const;
    const json = swaps.reduce((text, [from, to]) => `replace(${text}, ${token(from)}, ${token(to)})`, "x.json::text");
    return [
      `UPDATE memory_registry x SET json = (${json})::jsonb WHERE ${registryHit(ids)} AND NOT ${registryTaken(ids)}`,
    ];
  },
  from: "memory_registry x",
  hit: registryHit,
  conflicts: registryTaken,
};

const pinTaken = (ids: Ids) =>
  `EXISTS (SELECT 1 FROM persona_access y WHERE y.tenant_id = x.tenant_id AND y.pinned
     AND y.grantee_scope_id = 'personal:' || ${ids.canonical})`;
const pinHit = (ids: Ids) => `x.tenant_id = ${ids.tenant} AND x.pinned AND ${isScope("x.grantee_scope_id", ids)}`;

const pinStep: Step = {
  table: "persona_access",
  once: [`UPDATE persona_access x SET pinned = false FROM (${MOVES}) m WHERE ${pinHit(MOVE)} AND ${pinTaken(MOVE)}`],
  from: "persona_access x",
  hit: pinHit,
  conflicts: pinTaken,
};

const STEPS: Step[] = [keychainStep, registryStep, pinStep, ...COLUMNS.map(columnStep), ...DOCUMENTS.map(documentStep)];

const guarded = (step: Step, statements: string[], using = "") =>
  statements.length
    ? `  IF ${[step.table, ...(step.needs ?? [])].map((table) => `to_regclass('${table}') IS NOT NULL`).join(" AND ")} THEN
${statements.map((sql) => `    EXECUTE $sql$${sql}$sql$${using};`).join("\n")}
  END IF;`
    : "";

const PARAMS: Ids = { tenant: "$1", alias: "$2", canonical: "$3" };

export const REKEY_LINKED_SIGN_INS = `DO $rekey$
DECLARE
  m record;
  tenant uuid;
  bound text := current_setting('qm.tenant_id', true);
BEGIN
  FOR tenant IN SELECT DISTINCT t FROM (${MOVES}) moves LOOP
  PERFORM set_config('qm.tenant_id', tenant::text, true);
${STEPS.map((step) => guarded(step, step.once ?? []))
  .filter(Boolean)
  .join("\n")}
  FOR m IN ${MOVES} LOOP
${STEPS.map((step) => guarded(step, step.each?.(PARAMS) ?? [], " USING m.t, m.a, m.c"))
  .filter(Boolean)
  .join("\n")}
  END LOOP;
  END LOOP;
  PERFORM set_config('qm.tenant_id', coalesce(bound, ''), true);
END $rekey$`;

export function rekeyPlan(tables: ReadonlySet<string>): string {
  return STEPS.filter((step) => tables.has(step.table))
    .map(
      (step) => `SELECT m.t AS tenant_id, '${step.label ?? step.table}' AS store, count(*) AS rows,
        count(*) FILTER (WHERE ${step.conflicts(MOVE)}) AS conflicts
   FROM (${MOVES}) m JOIN ${step.from} ON ${step.hit(MOVE)} GROUP BY m.t`,
    )
    .join("\nUNION ALL\n");
}
