#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const MAX_FILES = 500;
const MAX_BYTES = 4 * 1024 * 1024;
const SKIPPED_DIRS = new Set(["logs"]);

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
let bytes = 0;
const walk = (path) => {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(full);
    } else if (entry.isFile()) {
      const data = readFileSync(full);
      bytes += data.length;
      files.push({
        path: relative(dir, full),
        contentBase64: data.toString("base64"),
        mode: lstatSync(full).mode & 0o777,
      });
    }
    if (files.length > MAX_FILES || bytes > MAX_BYTES) {
      rmSync(dir, { recursive: true, force: true });
      console.error(
        `${dir} was too large to save as a login (limit ${MAX_FILES} files, ${MAX_BYTES} bytes) and was removed`,
      );
      process.exit(1);
    }
  }
};
walk(dir);
if (!files.length) {
  rmSync(dir, { recursive: true, force: true });
  console.error(`${dir} contained no files, so the login did not complete; it was removed`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "save-login-"));
try {
  const body = join(scratch, "body.json");
  writeFileSync(body, JSON.stringify({ service, files, ...(label ? { accountLabel: label } : {}) }), { mode: 0o600 });
  const result = spawnSync(
    "curl",
    [
      "-sS",
      "-w",
      "\n%{http_code}",
      "-X",
      "POST",
      `${AGENT_API_URL}/v1/keychain/credentials`,
      "-H",
      `x-agent-capability: ${AGENT_API_TOKEN}`,
      "-H",
      "content-type: application/json",
      "--data-binary",
      `@${body}`,
    ],
    { encoding: "utf8" },
  );
  const [response, status] = [result.stdout.slice(0, result.stdout.lastIndexOf("\n")), result.stdout.split("\n").pop()];
  if (result.status !== 0 || status !== "200") {
    console.error(`keychain save failed (${status || result.status}): ${response || result.stderr}`);
    process.exit(1);
  }
  const { credential } = JSON.parse(response);
  rmSync(dir, { recursive: true, force: true });
  console.log(`saved ${credential.service} (${files.length} files) as ${credential.credentialHandle}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
