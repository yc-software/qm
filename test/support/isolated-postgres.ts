import { randomUUID } from "node:crypto";
import pg from "pg";

export async function isolatedPostgres(prefix = "qm_workflow", connectionString = process.env.DATABASE_URL!) {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const control = new pg.Pool({ connectionString });
  await control.query(`CREATE DATABASE ${name}`);
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  url.searchParams.delete("options");
  url.searchParams.set("application_name", name);
  const admin = new pg.Pool({ connectionString: url.toString() });
  admin.on("error", () => {});
  admin.on("connect", (client) => client.on("error", () => {}));
  return {
    url: url.toString(),
    admin,
    async cleanup() {
      await admin.end();
      const deadline = performance.now() + 1_000;
      while (performance.now() < deadline) {
        const { rows } = await control.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=$1) AS connected",
          [name],
        );
        if (!rows[0].connected) break;
        await control.query("SELECT pg_sleep(0.01)");
      }
      await control.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await control.end();
    },
  };
}
