# QM target contract

## Preferred channel

Use a curated private Git skill pack for domain instructions, references, scripts, and tests. Use the deployment layer separately only when a QM brokered tool or runtime integration is required.

## Target layout

```text
skills/
  <unique-skill-name>/
    SKILL.md
    references/
    scripts/
    tests/
shared/
```

Do not place a root `SKILL.md` in the pack.

Recommended pack configuration:

```json
{
  "skillGlobs": ["skills/*"],
  "exclude": ["archive/**", "source-hermes/**", "**/*.bak", "**/__pycache__/**", "**/.DS_Store"]
}
```

## Persisted skill contract

QM persists only:

- `name`
- `description`
- `requiredCapabilities`
- instruction body
- text asset paths and contents

Hermes `triggers`, `version`, author, and metadata are not persisted. Trigger intent must be incorporated into the description.

## Asset constraints

- Git skill packs are text-only.
- Any binary beneath a skill directory excludes the entire candidate.
- Pack ingestion does not preserve executable bits.
- Runtime materialization currently does not apply executable metadata with `chmod`.
- Scripts must therefore be invoked with explicit interpreters.
- Shared pack text files may live outside skill directories and materialize under the pack bundle.

## Provenance

Git-pack import records:

- pack id
- pinned commit
- upstream skill name
- `createdBy: pack:<id>`

This is preferred over deployment-layer provenance for ordinary migrated skills.

## Collision rules

- One authoritative target per name.
- Existing non-archived native or foreign skill names collide in the target scope.
- Asset paths must be safe, relative, normalized, and collision-free.
- Current live skills must not be overwritten during preparation.

## Staging

The safest staging environment is a separate QM development instance, organization, and database using a pinned internal private pack. Same-organization personal/team staging can shadow names and distort visibility.

## Required validation

- No duplicate or case-variant target names
- No malformed/private/personal/binary exclusions in QM `planIngest`
- No nested `SKILL.md`
- No secrets, private keys, credential values, or environment-file sourcing
- No Hermes identifiers, paths, CLI calls, or tool syntax
- Every local reference resolves
- Every tool or credential operation maps to a real QM boundary
- Capabilities reflect actual behavior and deployment policy
- Scripts pass lint and tests using explicit interpreters
- Representative descriptions trigger correctly
- Deterministic hashes and pinned commit recorded
- Staging verifies browse, import, materialization, use, update, archive, and rollback behavior
