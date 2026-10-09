#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const [service, dir, ...rest] = process.argv.slice(2);
const labelAt = rest.indexOf("--label");
const label = labelAt >= 0 ? rest[labelAt + 1] : undefined;
if (!service || !dir || (labelAt >= 0 && !label)) {
  console.error("usage: save-login.mjs <service> <dir> [--label <account>]");
  process.exit(2);
}
const { AGENT_API_URL, AGENT_API_TOKEN } = process.env;
if (!AGENT_API_URL || !AGENT_API_TOKEN) {
  console.error("AGENT_API_URL and AGENT_API_TOKEN must be set");
  process.exit(2);
}

const files = [];
const walk = (path) => {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory() && entry.name !== "logs") walk(full);
    else if (entry.isFile())
      files.push({
        path: relative(dir, full),
        contentBase64: readFileSync(full).toString("base64"),
        mode: lstatSync(full).mode & 0o777,
      });
  }
};
walk(dir);
const discard = (message) => {
  rmSync(dir, { recursive: true, force: true });
  console.error(`${message}; ${dir} was removed`);
  process.exit(1);
};
if (!files.length) discard(`${dir} contained no files, so the login did not complete`);

const response = await fetch(`${AGENT_API_URL}/v1/keychain/credentials`, {
  method: "POST",
  headers: { "x-agent-capability": AGENT_API_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ service, files, ...(label ? { accountLabel: label } : {}) }),
}).catch((error) => {
  console.error(`keychain save failed: ${error.message}; run this again to retry`);
  process.exit(1);
});
const text = await response.text();
if (response.status === 400 || response.status === 413)
  discard(`keychain rejected the login (${response.status}): ${text}`);
if (!response.ok) {
  console.error(`keychain save failed (${response.status}): ${text}; run this again to retry`);
  process.exit(1);
}
const { credential } = JSON.parse(text);
rmSync(dir, { recursive: true, force: true });
console.log(`saved ${credential.service} (${files.length} files) as ${credential.credentialHandle}`);
