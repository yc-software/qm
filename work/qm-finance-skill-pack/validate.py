from pathlib import Path
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parent
SKILLS = ROOT / "skills"
NAME_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_-])?$")
FORBIDDEN = {
    "hermes": re.compile(r"hermes", re.I),
    "hermes-home": re.compile(r"HERMES_HOME|\.hermes", re.I),
    "hindsight": re.compile(r"hindsight(?:_recall)?", re.I),
    "direct-netsuite-client": re.compile(r"netsuite_kb|NETSUITE_(?:ACCOUNT|CONSUMER|TOKEN)|suitetalk\.api\.netsuite\.com", re.I),
    "hermes-tool-syntax": re.compile(r"\b(?:terminal|execute_code|delegate_task|session_search|skill_view|skill_manage)\s*\(", re.I),
    "absolute-profile-path": re.compile(r"/(?:home|Users)/[^\s`'\"]+/(?:\.finny|\.hermes)|/Applications/hermes", re.I),
}
SECRET_PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "github-token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    "openai-key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b"),
    "aws-key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
}
TEXT_SUFFIXES = {".md", ".py", ".js", ".mjs", ".ts", ".json", ".jsonc", ".yaml", ".yml", ".txt", ".csv", ".sql", ".sh", ".toml"}


def frontmatter(text: str) -> tuple[dict[str, object], str]:
    if not text.startswith("---\n"):
        raise ValueError("missing YAML frontmatter")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise ValueError("unterminated YAML frontmatter")
    attrs: dict[str, object] = {}
    for raw in text[4:end].splitlines():
        if not raw.strip() or raw.startswith(" "):
            continue
        if ":" not in raw:
            raise ValueError(f"invalid frontmatter line: {raw}")
        key, value = raw.split(":", 1)
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            attrs[key] = [item.strip().strip("\"'") for item in value[1:-1].split(",") if item.strip()]
        else:
            attrs[key] = value.strip("\"'")
    return attrs, text[end + 5 :]


def main() -> int:
    errors: list[str] = []
    names: dict[str, Path] = {}
    manifest: list[dict[str, object]] = []
    config = json.loads((ROOT / "pack.config.json").read_text())
    if config.get("skillGlobs") != ["skills/*"]:
        errors.append("pack.config.json: skillGlobs must be exactly ['skills/*']")
    skill_dirs = sorted(path for path in SKILLS.iterdir() if path.is_dir())
    for skill_dir in skill_dirs:
        if not (skill_dir / "SKILL.md").is_file():
            errors.append(f"{skill_dir.relative_to(ROOT)}: missing SKILL.md")
    for cache in ROOT.rglob("__pycache__"):
        errors.append(f"{cache.relative_to(ROOT)}: generated cache directory")
    for cache in ROOT.rglob(".pytest_cache"):
        errors.append(f"{cache.relative_to(ROOT)}: generated cache directory")
    for skill_md in sorted(SKILLS.glob("*/SKILL.md")):
        skill_dir = skill_md.parent
        try:
            attrs, body = frontmatter(skill_md.read_text())
        except Exception as exc:
            errors.append(f"{skill_md.relative_to(ROOT)}: {exc}")
            continue
        name = str(attrs.get("name", ""))
        description = str(attrs.get("description", ""))
        capabilities = attrs.get("requiredCapabilities")
        if not NAME_RE.fullmatch(name) or name.endswith("."):
            errors.append(f"{skill_md.relative_to(ROOT)}: unsafe name {name!r}")
        if skill_dir.name != name:
            errors.append(f"{skill_md.relative_to(ROOT)}: directory must match name")
        folded = name.casefold()
        if folded in names:
            errors.append(f"duplicate name: {name} and {names[folded].parent.name}")
        names[folded] = skill_md
        if not description.strip():
            errors.append(f"{skill_md.relative_to(ROOT)}: empty description")
        if not isinstance(capabilities, list):
            errors.append(f"{skill_md.relative_to(ROOT)}: requiredCapabilities must be a list")
        if not body.strip():
            errors.append(f"{skill_md.relative_to(ROOT)}: empty body")
        files = []
        for path in sorted(skill_dir.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(skill_dir).as_posix()
            if rel != "SKILL.md" and path.name == "SKILL.md":
                errors.append(f"{path.relative_to(ROOT)}: nested SKILL.md")
            raw = path.read_bytes()
            if b"\0" in raw:
                errors.append(f"{path.relative_to(ROOT)}: binary/NUL content")
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                errors.append(f"{path.relative_to(ROOT)}: non-UTF-8 content")
                continue
            if path.suffix.lower() and path.suffix.lower() not in TEXT_SUFFIXES:
                errors.append(f"{path.relative_to(ROOT)}: unapproved asset suffix")
            scan_runtime_dependencies = not rel.startswith("tests/")
            if scan_runtime_dependencies:
                for label, pattern in FORBIDDEN.items():
                    if pattern.search(text):
                        errors.append(f"{path.relative_to(ROOT)}: forbidden {label}")
            for label, pattern in SECRET_PATTERNS.items():
                if pattern.search(text):
                    errors.append(f"{path.relative_to(ROOT)}: possible secret {label}")
            files.append({"path": rel, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        for target in re.findall(r"`((?:references|scripts|tests)/[^`\s]+)`", body):
            if not (skill_dir / target).is_file():
                errors.append(f"{skill_md.relative_to(ROOT)}: missing referenced asset {target}")
        manifest.append({"name": name, "description": description, "files": files})
    if not manifest:
        errors.append("no skills found")
    if not errors:
        (ROOT / "audit" / "bundle-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for error in errors:
        print(error, file=sys.stderr)
    print(f"validated {len(manifest)} skills and {sum(len(x['files']) for x in manifest)} files")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
