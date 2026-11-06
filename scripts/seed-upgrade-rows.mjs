import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query("BEGIN");
await client.query("SET CONSTRAINTS ALL IMMEDIATE");

const { rows: columns } = await client.query(`
  SELECT format('%I.%I', c.table_schema, c.table_name) AS table_name, c.column_name, c.data_type, c.udt_name,
    c.is_nullable, c.column_default, c.is_generated, c.is_identity
  FROM information_schema.columns c
  JOIN pg_class k ON k.oid = format('%I.%I', c.table_schema, c.table_name)::regclass
  WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
    AND k.relkind IN ('r', 'p') AND NOT k.relispartition
  ORDER BY 1, c.ordinal_position`);

const tables = new Map();
for (const column of columns) {
  if (!tables.has(column.table_name)) tables.set(column.table_name, []);
  tables.get(column.table_name).push(column);
}

function value(column) {
  const type = column.udt_name;
  if (column.data_type === "ARRAY") return "'{}'";
  if (type === "uuid") return "gen_random_uuid()";
  if (type === "jsonb" || type === "json") return "'{}'";
  if (/^(int|float|numeric)/.test(type)) return "1";
  if (type === "bool") return "false";
  if (type.startsWith("timestamp") || type === "date") return "now()";
  if (type === "bytea") return "'\\x00'";
  if (type === "vector") return null;
  return "'upgrade-check'";
}

let pending = [];
for (const [table, cols] of tables) {
  const { rows } = await client.query(`SELECT EXISTS (SELECT 1 FROM ${table}) AS present`);
  if (!rows[0].present) pending.push([table, cols]);
}

const seeded = [];
let failures = new Map();
for (let pass = 0; pending.length && pass < 6; pass++) {
  const next = [];
  failures = new Map();
  for (const [table, cols] of pending) {
    const chosen = cols.filter((c) => c.is_generated !== "ALWAYS" && c.is_identity !== "YES" && !c.column_default);
    const values = chosen.map((c) => value(c));
    if (values.includes(null)) {
      failures.set(table, "unsupported column type");
      continue;
    }
    const sql = `INSERT INTO ${table} (${chosen.map((c) => `"${c.column_name}"`).join(", ")}) VALUES (${values.join(", ")})`;
    try {
      await client.query("SAVEPOINT seed");
      await client.query(sql);
      await client.query("RELEASE SAVEPOINT seed");
      seeded.push(table);
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT seed");
      failures.set(table, error.message);
      next.push([table, cols]);
    }
  }
  pending = next;
}

await client.query("COMMIT");
await client.end();
console.log(`[upgrade-check] seeded ${seeded.length} of ${tables.size} tables`);
for (const [table, reason] of failures) console.log(`[upgrade-check] left ${table} empty: ${reason}`);
