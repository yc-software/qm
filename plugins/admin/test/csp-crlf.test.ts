import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = /<script>([\s\S]*?)<\/script>/i;
const root = mkdtempSync(join(tmpdir(), "admin-crlf-"));
cpSync(new URL("../../chassis/src", import.meta.url), join(root, "chassis/src"), { recursive: true });
cpSync(new URL("../src", import.meta.url), join(root, "admin/src"), { recursive: true });
mkdirSync(join(root, "admin/public"));
const lfHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
writeFileSync(join(root, "admin/public/index.html"), lfHtml.replaceAll("\n", "\r\n"));
writeFileSync(join(root, "admin/public/admin-components.css"), "");
writeFileSync(join(root, "admin/public/brand-mark.svg"), "");

delete process.env.ADMIN_BASE_PATH;
process.env.CORE_API_URL = "http://127.0.0.1:9";
const { server } = (await import(
  pathToFileURL(join(root, "admin/src/index.ts")).href
)) as typeof import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

test("a CRLF index.html is served LF-normalized with the script hash a browser computes", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.ok(!body.includes("\r"));
  const lfScript = lfHtml.match(SCRIPT)?.[1]?.replaceAll("__ADMIN_BASE__", "") ?? "";
  assert.equal(body.match(SCRIPT)?.[1], lfScript);
  const hash = createHash("sha256").update(lfScript).digest("base64");
  assert.ok(r.headers.get("content-security-policy")?.includes(`script-src 'sha256-${hash}'`));
});
