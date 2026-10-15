import { fileURLToPath } from "node:url";

export async function ensurePlaywright() {
  return fileURLToPath(new URL("./playwright.mjs", import.meta.url));
}
