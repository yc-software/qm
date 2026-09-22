import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";
import { loadConfig } from "../src/config.ts";
import { materializeSkillTree } from "../src/skills/materialize.ts";
import { computeBundleHash, type SkillBundle } from "../src/skills/skill-bundle-store.ts";
import type { SkillFile, SkillResolution } from "../src/skills/skill-store.ts";

if (!process.env.SPRITES_TOKEN) {
  console.error("set SPRITES_TOKEN (mint one with `sprite login`)");
  process.exit(1);
}

function res(name: string, body: string, files: SkillFile[] = []): SkillResolution {
  return { skill: { manifest: { name, body, files } }, shadowed: [] } as unknown as SkillResolution;
}
function bundle(packId: string, files: SkillFile[]): SkillBundle {
  return { packId, commit: "c", files, hash: computeBundleHash(files) };
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const scope = scopeId("personal", "qm-skills-smoke");
const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "skills-smoke-")));
const sb = createSpritesSandbox(ws, loadConfig().spritesSandbox);

let h: Awaited<ReturnType<typeof sb.provision>> | undefined;
try {
  console.log("provisioning sprite for", scope, "…");
  h = await sb.provision([{ scopeId: scope, mountPath: "", mode: "rw" }]);
  console.log("  sprite:", h.id, "coldStart:", h.coldStart);

  const heavy = res("popular-web-designs", "# Popular web designs\nthe entry point", [
    { path: "scripts/render.py", content: "print('render')\n" },
    { path: "references/catalog.md", content: "# big catalog\n" },
  ]);

  console.log("materializeSkillTree (lazy, assets + bundle, one tar) …");
  const b = bundle("pack1", [{ path: "lib/cite.mjs", content: "export const cite = 1\n" }]);
  await materializeSkillTree(sb, h, "skills", heavy, [b]);
  assert(
    (await sb.readFile(h, "skills/popular-web-designs/scripts/render.py"))?.includes("render"),
    "asset laid lazily",
  );
  assert(
    (await sb.readFile(h, "skills/popular-web-designs/references/catalog.md"))?.includes("catalog"),
    "ref laid lazily",
  );
  assert(
    (await sb.readFile(h, "skills/.packs/pack1/lib/cite.mjs"))?.includes("cite"),
    "pack bundle overlaid at repo-relative path",
  );
  console.log("  ok: assets + bundle landed via tar");

  console.log("\nALL SKILLS MATERIALIZE SMOKE CHECKS PASSED");
} finally {
  console.log("destroying smoke sprite …");
  if (h) await sb.teardown(h, { destroy: true });
}
