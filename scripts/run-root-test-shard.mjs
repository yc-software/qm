#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";

const ROOT_TEST_DIR = new URL("../test/", import.meta.url);
const PINNED_SLOW_TESTS = ["test/orchestrator.test.ts"];

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function parseShard(value) {
  if (!value) {
    throw new Error("Pass --shard <index>/<total> or set CORE_TEST_SHARD");
  }

  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Shard must use <index>/<total>, got ${value}`);
  }

  const index = parsePositiveInteger(match[1], "shard index");
  const total = parsePositiveInteger(match[2], "shard total");
  if (index > total) {
    throw new Error(`Shard index ${index} cannot be greater than total ${total}`);
  }
  return { index, total };
}

async function rootTestFiles() {
  const entries = await readdir(ROOT_TEST_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

function ensurePinnedTestsExist(allFiles) {
  const all = new Set(allFiles);
  const missing = PINNED_SLOW_TESTS.filter((file) => !all.has(file));
  if (missing.length > 0) {
    throw new Error(`Pinned slow test file(s) missing from root test suite: ${missing.join(", ")}`);
  }
}

function filesForShard(allFiles, { index, total }) {
  if (total === 1) return allFiles;

  const pinned = new Set(PINNED_SLOW_TESTS);
  if (index === 1) {
    return allFiles.filter((file) => pinned.has(file));
  }

  const restShardIndex = index - 2;
  const restShardTotal = total - 1;
  return allFiles
    .filter((file) => !pinned.has(file))
    .filter((_, restIndex) => restIndex % restShardTotal === restShardIndex);
}

function printFiles(header, files) {
  console.log(`${header} (${files.length} file${files.length === 1 ? "" : "s"}):`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
}

function verifyShards(allFiles, total) {
  const seen = new Map();
  for (let index = 1; index <= total; index += 1) {
    const files = filesForShard(allFiles, { index, total });
    if (files.length === 0) {
      throw new Error(`Shard ${index}/${total} has no files`);
    }
    for (const file of files) {
      const shards = seen.get(file) ?? [];
      shards.push(index);
      seen.set(file, shards);
    }
  }

  const missing = allFiles.filter((file) => !seen.has(file));
  const duplicated = [...seen.entries()].filter(([, shards]) => shards.length !== 1);
  if (missing.length > 0 || duplicated.length > 0) {
    if (missing.length > 0) {
      console.error(`Missing files:\n${missing.map((file) => `  ${file}`).join("\n")}`);
    }
    if (duplicated.length > 0) {
      console.error(
        `Duplicated files:\n${duplicated.map(([file, shards]) => `  ${file}: ${shards.join(", ")}`).join("\n")}`,
      );
    }
    throw new Error("Root test shard plan does not cover every file exactly once");
  }

  console.log(`Root test shard plan covers ${allFiles.length} files exactly once across ${total} shards.`);
  for (let index = 1; index <= total; index += 1) {
    const files = filesForShard(allFiles, { index, total });
    console.log(`  shard ${index}/${total}: ${files.length} files`);
  }
}

async function main() {
  const { values: flags } = parseArgs({
    options: {
      shard: { type: "string" },
      shards: { type: "string" },
      check: { type: "boolean" },
      list: { type: "boolean" },
    },
  });
  const allFiles = await rootTestFiles();
  ensurePinnedTestsExist(allFiles);

  if (flags.check) {
    const total = parsePositiveInteger(flags.shards ?? process.env.CORE_TEST_TOTAL_SHARDS ?? "5", "shards");
    verifyShards(allFiles, total);
    return;
  }

  const shard = parseShard(flags.shard ?? process.env.CORE_TEST_SHARD);
  const files = filesForShard(allFiles, shard);
  if (files.length === 0) {
    throw new Error(`Shard ${shard.index}/${shard.total} has no files`);
  }

  if (flags.list) {
    printFiles(`Root test shard ${shard.index}/${shard.total}`, files);
    return;
  }

  printFiles(`Running root test shard ${shard.index}/${shard.total}`, files);
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--test", ...files], {
    cwd: new URL("../", import.meta.url),
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
