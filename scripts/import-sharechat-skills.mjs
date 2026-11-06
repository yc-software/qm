#!/usr/bin/env node
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { createSkillPackStore } from "../src/skills/skill-pack-store.ts";
import { importPack } from "../src/skills/ingest.ts";
import fs from "node:fs";
import path from "node:path";

const targetScope = process.argv[2] || "org:sharechat";
const repoRoot = path.resolve("./work/sharechat-skills");

console.log(`Starting skill pack import into ${targetScope}...`);
console.log(`Source repository: ${repoRoot}`);

const configPath = path.join(repoRoot, "pack.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const files = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else {
      const bytes = fs.readFileSync(full);
      files.push({
        path: path.relative(repoRoot, full).split(path.sep).join("/"),
        text: bytes.toString("utf8"),
        binary: bytes.includes(0),
      });
    }
  }
}

walk(path.join(repoRoot, "skills"));
console.log(`Discovered ${files.length} asset files across all skills.`);

const connectionString = process.env.DATABASE_URL || "postgres://postgres:qm-dev@127.0.0.1:55432/qm_dev_4f4c65c942c2";

const maps = createPostgresMapFactory(connectionString);
const skillsBacking = maps.map("skills", ["scopeId", "createdBy"]);
const packsBacking = maps.map("skill_packs");
const skillStore = createSkillStore({ backing: skillsBacking });
const packStore = createSkillPackStore({ backing: packsBacking });

// 1. Create or retrieve the pack record
const existingPacks = await packStore.list();
let pack = existingPacks.find((p) => p.url === `file://${repoRoot}`);
if (!pack) {
  pack = await packStore.create({
    kind: "git",
    url: `file://${repoRoot}`,
    ref: "main",
    syncMode: "pinned",
    trustTier: "internal",
    targetScopeId: targetScope,
    subset: "all",
    createdBy: "admin:sharechat-migration",
    config,
  });
  console.log(`Created skill pack record: ${pack.id}`);
} else {
  console.log(`Found existing skill pack record: ${pack.id}`);
}

// 2. Perform importPack
const repo = { commit: "acbd4e338d18637acdfbc2edcc2409ccbbc5d830", files };
const existingSkills = await skillStore.list();
const inScopeNames = new Set(
  existingSkills.filter((s) => s.scopeId === targetScope && s.status === "published").map((s) => s.manifest.name),
);

const result = await importPack(repo, skillStore, {
  pack,
  selected: "all",
  nativeNames: inScopeNames,
  targetScopeId: targetScope,
});

console.log("\n--- Import Summary ---");
console.log(`Installed new skills : ${result.imported.length}`);
console.log(`Updated skills       : ${result.updated.length}`);
console.log(`Skipped skills       : ${result.skipped.length}`);

await packStore.recordImport(pack.id, {
  at: Date.now(),
  commit: repo.commit,
  status: "ok",
  counts: result.counts,
});

console.log(`\nImport complete! Total skills now available in ${targetScope}.`);
process.exit(0);
