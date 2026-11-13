#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const [service, dir, ...rest] = process.argv.slice(2);
const labelAt = rest.indexOf("--label");
const label = labelAt >= 0 ? rest[labelAt + 1] : undefined;
if (!service || !dir || (labelAt >= 0 && !label)) {
  console.error("usage: save-login.mjs <service> <dir> [--start | --label <account>]");
  process.exit(2);
}
const { AGENT_API_URL, AGENT_API_TOKEN } = process.env;
if (!AGENT_API_URL || !AGENT_API_TOKEN) {
  console.error("AGENT_API_URL and AGENT_API_TOKEN must be set");
  process.exit(2);
}
const reason = (error) => [error.message, error.cause?.code, error.cause?.message].filter(Boolean).join(": ");
const headers = { "x-agent-capability": AGENT_API_TOKEN, "content-type": "application/json" };
const ticketFile = `${resolve(dir)}.ticket`;
const replaceRefused = (text) => {
  try {
    return ["human_consent_required", "inactive_run"].includes(JSON.parse(text).error);
  } catch {
    return false;
  }
};

if (rest.includes("--start")) {
  const response = await fetch(`${AGENT_API_URL}/v1/keychain/login-tickets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ service }),
  }).catch((error) => ({ ok: false, status: 0, text: async () => reason(error) }));
  if (!response.ok) {
    const text = await response.text();
    console.error(
      `no sign-in ticket (${response.status}): ${text}${replaceRefused(text) ? `; a new login still saves, but replacing an existing ${service} login needs the save to run in the person's own turn` : ""}`,
    );
    process.exit(0);
  }
  writeFileSync(ticketFile, (await response.json()).loginTicket, { mode: 0o600 });
  console.log(`started the ${service} sign-in`);
  process.exit(0);
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
const remove = () => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(ticketFile, { force: true });
};
const discard = (message) => {
  remove();
  console.error(`${message}; ${dir} was removed`);
  process.exit(1);
};
if (!files.length) discard(`${dir} contained no files, so the login did not complete`);

const loginTicket = existsSync(ticketFile) ? readFileSync(ticketFile, "utf8") : undefined;
const response = await fetch(`${AGENT_API_URL}/v1/keychain/credentials`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    service,
    files,
    ...(label ? { accountLabel: label } : {}),
    ...(loginTicket ? { loginTicket } : {}),
  }),
}).catch((error) => {
  console.error(`keychain save failed: ${reason(error)}; run this again to retry`);
  process.exit(1);
});
const text = await response.text();
if (response.status === 400 || response.status === 413)
  discard(`keychain rejected the login (${response.status}): ${text}`);
if (response.status === 403 && replaceRefused(text))
  discard(
    `keychain kept the existing ${service} login (403): ${text}; replacing it needs a sign-in started in the person's own running turn, so start again from step 1 there`,
  );
if (!response.ok) {
  console.error(`keychain save failed (${response.status}): ${text}; run this again to retry`);
  process.exit(1);
}
const { credential } = JSON.parse(text);
remove();
console.log(`saved ${credential.service} (${files.length} files) as ${credential.credentialHandle}`);
