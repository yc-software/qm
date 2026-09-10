import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("every maintained sandbox image installs the pinned Aside CLI with verified architecture checksums", () => {
  for (const path of ["fly/Dockerfile", "porter/Dockerfile", "deploy/e2b/e2b.Dockerfile"]) {
    const dockerfile = read(path);
    assert.match(dockerfile, /ARG ASIDE_CLI_VERSION=1\.26\.906\.1630/, path);
    assert.match(dockerfile, /AsideCLI-linux-\$\{ASIDE_ARCH\}-\$\{ASIDE_CLI_VERSION\}\.tar\.gz/, path);
    assert.match(dockerfile, /ASIDE_SHA=.*;;[\s\S]*ASIDE_SHA=.*;;/, path);
    assert.match(dockerfile, /echo "\$ASIDE_SHA {2}\/tmp\/aside\.tgz" \| sha256sum -c -/, path);
    assert.match(dockerfile, /install \/tmp\/aside \/usr\/local\/bin\/aside/, path);
    assert.match(dockerfile, /libatomic1/, path);
  }
});

test("the Aside browser skill routes only to an enabled online host and keeps login secrets out of chat", () => {
  const skill = read("skills-seed/aside-browser/SKILL.md");
  assert.match(skill, /remoteControlEnabled: true/);
  assert.match(skill, /online: true/);
  assert.match(skill, /grantMode":"once/);
  assert.match(skill, /ASIDE_EMAIL/);
  assert.match(skill, /ASIDE_PASSWORD/);
  assert.match(skill, /printf '%s\\n' "\$ASIDE_PASSWORD" \| aside login --email "\$ASIDE_EMAIL"/);
  assert.match(skill, /DELETE \/v1\/keychain\/credentials\/:id/);
  assert.match(skill, /aside exec --host <host-id> --permission guard/);
  assert.doesNotMatch(skill, /cat ~\/\.aside\/cli\/auth\.json/);
});

test("the generic browse skill prefers a connected Aside remote session without forcing setup", () => {
  const skill = read("skills-seed/browse/SKILL.md");
  assert.match(skill, /aside host list --json/);
  assert.match(skill, /read\s+`skills\/aside-browser\/SKILL\.md`/);
  assert.match(skill, /do not turn a normal browse request into an Aside setup flow/);
});
