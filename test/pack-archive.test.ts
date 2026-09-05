import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { readSkillPackArchive, MAX_SKILL_ARCHIVE_BYTES } from "../src/skills/pack-archive.ts";
import { skillZip } from "./support/skill-zip.ts";

const md = "---\nname: zip-skill\ndescription: a skill\n---\n# Instructions\nRead rules.json.\n";
const read = (bytes: Buffer) => readSkillPackArchive(Readable.from([bytes]));

test("reads wrapped UTF-8 skill packs and preserves the complete text assets", async () => {
  const bytes = skillZip([
    { path: "pack/", text: "" },
    { path: "pack/SKILL.md", text: md },
    { path: "pack/rules.json", text: '{"label":"配色"}' },
  ]);
  const repo = await read(bytes);
  assert.equal(repo.commit, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(repo.files.map((file) => file.path).sort(), ["SKILL.md", "rules.json"]);
  assert.equal(repo.files.find((file) => file.path === "rules.json")?.text, '{"label":"配色"}');
});

for (const [name, entry, expected] of [
  ["parent traversal", { path: "../SKILL.md", text: md }, /invalid|relative/i],
  ["absolute paths", { path: "/SKILL.md", text: md }, /absolute|invalid/i],
  ["backslashes", { path: "pack\\SKILL.md", text: md }, /backslash|invalid/i],
  ["symlinks", { path: "SKILL.md", text: md, mode: 0o120777 }, /unsupported ZIP entry/],
  ["encrypted entries", { path: "SKILL.md", text: md, flags: 0x801 }, /encrypted/],
  ["bad CRC", { path: "SKILL.md", text: md, crc: 1 }, /integrity/],
  ["dishonest expanded size", { path: "SKILL.md", text: md, size: 1 }, /size|byte/i],
  ["binary attachments", { path: "image.png", bytes: Buffer.from([0x89, 0x50, 0, 1]) }, /binary attachment/],
  ["invalid UTF-8", { path: "SKILL.md", bytes: Buffer.from([0xc3, 0x28]) }, /encoded data|encoding|binary attachment/i],
  ["Git history", { path: ".git/config", text: "internal" }, /remove .git/],
] as const) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(read(skillZip([entry])), expected);
  });
}

test("rejects duplicate paths, empty archives and archives without skills", async () => {
  await assert.rejects(
    read(
      skillZip([
        { path: "SKILL.md", text: md },
        { path: "SKILL.md", text: "other" },
      ]),
    ),
    /duplicate/,
  );
  await assert.rejects(read(skillZip([])), /SKILL.md/);
  await assert.rejects(read(skillZip([{ path: "README.md", text: "readme" }])), /SKILL.md/);
  await assert.rejects(read(Buffer.from("not a zip")), /ZIP|zip/i);
});

test("bounds compressed and expanded input, including highly compressible payloads", async () => {
  await assert.rejects(read(Buffer.alloc(MAX_SKILL_ARCHIVE_BYTES + 1)), /16 MiB/);
  const bomb = skillZip([{ path: "SKILL.md", text: "a".repeat(32 * 1024 * 1024 + 1) }]);
  assert.ok(bomb.length < 100000);
  await assert.rejects(read(bomb), /32 MiB/);
  await assert.rejects(
    read(skillZip(Array.from({ length: 5001 }, (_, i) => ({ path: `file-${i}`, text: "" })))),
    /5000 entries/,
  );
});

test("rejects a file used as the parent of another file", async () => {
  await assert.rejects(
    read(
      skillZip([
        { path: "SKILL.md", text: md },
        { path: "assets", text: "file" },
        { path: "assets/rules.json", text: "{}" },
      ]),
    ),
    /conflicting ZIP path/,
  );
});
