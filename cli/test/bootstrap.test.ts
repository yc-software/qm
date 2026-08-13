import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const npmVersionGuard =
  'node -e \'const [major, minor] = process.argv[1].split(".").map(Number); if (!(major > 11 || (major === 11 && minor >= 10))) throw Error("npm 11.10.0 or newer is required")\' "$(npm --version)" &&';

function packRelease(root: string, version: string): { bytes: Buffer; filename: string; version: string } {
  const packageDir = join(root, `package-${version}`);
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "@yc-software/qm", version, bin: { qm: "qm.js" } }, null, 2)}\n`,
  );
  writeFileSync(join(packageDir, "qm.js"), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(version)});\n`);
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: packageDir,
      encoding: "utf8",
    }),
  ) as Array<{ filename: string }>;
  const filename = packed[0]!.filename;
  return { bytes: readFileSync(join(root, filename)), filename, version };
}

test("every latest CLI bootstrap enforces the seven-day release cooldown", () => {
  const packageManifest = JSON.parse(readFileSync(join(repoRoot, "cli", "package.json"), "utf8")) as {
    engines?: Record<string, string>;
  };
  assert.equal(packageManifest.engines?.npm, ">=11.10.0");
  const matches = execFileSync("git", ["grep", "-n", "@yc-software/qm@latest", "--", "*.md"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  assert.equal(matches.length, 3);
  for (const match of matches) {
    assert.match(match, /npm exec --yes --min-release-age=7 --package=@yc-software\/qm@latest/);
    const path = match.slice(0, match.indexOf(":"));
    assert.ok(readFileSync(join(repoRoot, path), "utf8").includes(`${npmVersionGuard}\nnpm exec`));
  }
});

test("the CLI bootstrap rejects old npm before resolving latest", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-bootstrap-old-npm-"));
  try {
    const bin = join(root, "bin");
    const marker = join(root, "resolution-attempted");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '11.9.0'; exit 0; fi\ntouch ${JSON.stringify(marker)}\nexit 99\n`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    const result = spawnSync(
      "sh",
      ["-c", `${npmVersionGuard}\nnpm exec --yes --min-release-age=7 --package=@yc-software/qm@latest -- qm version`],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm 11\.10\.0 or newer is required/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI bootstrap selects a release on the eligible side of the cooldown", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-bootstrap-"));
  const eligible = packRelease(root, "1.0.0");
  const ineligible = packRelease(root, "1.1.0");
  let registry: Server | undefined;
  try {
    const releases = [eligible, ineligible];
    registry = createServer((request, response) => {
      const origin = `http://${request.headers.host}`;
      if (request.url && decodeURIComponent(request.url) === "/@yc-software/qm") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: "@yc-software/qm",
            "dist-tags": { latest: ineligible.version },
            versions: Object.fromEntries(
              releases.map((release) => [
                release.version,
                {
                  name: "@yc-software/qm",
                  version: release.version,
                  bin: { qm: "qm.js" },
                  dist: {
                    tarball: `${origin}/@yc-software/qm/-/${release.filename}`,
                    shasum: createHash("sha1").update(release.bytes).digest("hex"),
                    integrity: `sha512-${createHash("sha512").update(release.bytes).digest("base64")}`,
                  },
                },
              ]),
            ),
            time: {
              [eligible.version]: new Date(Date.now() - 7 * 86_400_000 - 3_600_000).toISOString(),
              [ineligible.version]: new Date(Date.now() - 7 * 86_400_000 + 3_600_000).toISOString(),
            },
          }),
        );
        return;
      }
      const release = releases.find((candidate) => request.url === `/@yc-software/qm/-/${candidate.filename}`);
      if (release) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(release.bytes);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve, reject) => registry!.once("error", reject).listen(0, "127.0.0.1", resolve));
    const registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
    const consumer = join(root, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "empty-npmrc"), "");
    const { stdout } = await execFileAsync(
      "sh",
      ["-c", `${npmVersionGuard}\nnpm exec --yes --min-release-age=7 --package=@yc-software/qm@latest -- qm`],
      {
        cwd: consumer,
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: join(root, "npm-cache"),
          NPM_CONFIG_REGISTRY: registryUrl,
          NPM_CONFIG_USERCONFIG: join(consumer, "empty-npmrc"),
        },
        timeout: 60_000,
      },
    );
    assert.equal(stdout, eligible.version);
  } finally {
    if (registry) {
      registry.closeAllConnections();
      await new Promise<void>((resolve) => registry!.close(() => resolve()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
