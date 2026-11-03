import { useOwnerDatabase } from "../../src/tenants/claim.ts";

if (process.env.DATABASE_OWNER_URL) useOwnerDatabase(process.env.DATABASE_OWNER_URL);
