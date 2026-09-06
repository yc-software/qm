# Skill registry (Phase A)

Import skills from a **git repo of `SKILL.md` files** into the governed skill store — no code change,
no image rebuild. An admin registers a _pack_, browses it, and imports skills **org-wide**; the
skills then show on the admin Skills page and materialize onto boxes through the normal path.

## How it works

```
git pack ──fetch(pinned ref)──▶ general normalizer ──▶ planIngest (classify) ──▶ importPack
                                                                                      │
                                                          create→review→publish (shared upsert)
                                                                                      ▼
                                                          org-scope SkillStore ──▶ materialize ──▶ box
```

- **One general normalizer** (`src/skills/normalize.ts`) maps any repo's frontmatter dialect onto the
  canonical manifest via an alias table + ignore-unknowns + safe defaults. **No per-repo code** — a
  repo's specifics are declarative `config` on the pack (`skillGlobs` / `exclude` / `fieldOverrides`).
- **Eligibility** (org import): a skill is imported only if its scope hint is org-shareable
  (`company` / `both` / `org` / `shared` / …). Excluded with a visible reason: `scope` (personal/missing),
  `private` (owner-only flags or a `THE-AGENT-ONLY` body), `collision` (name already owned by a
  different pack / native seed), `binary-asset`, `malformed`.
- **Pinned** in Phase A: an install is frozen at the pack's `ref`. "Update" = bump the ref + re-import
  (idempotent; unchanged skills are skipped, changed ones re-published, upstream-removed ones archived
  on `remove`). The sync engine (tracked mode) is Phase B.
- **Org scope only** in Phase A (team scope needs resolution work — Phase D). Authz: any `org_admin`.

## Admin API (`/v1/admin/skill-packs*`, org_admin, audited)

```
POST   /v1/admin/skill-packs              register { url, ref, config?, authCredentialSlug?, trustTier? }
GET    /v1/admin/skill-packs              list packs + last-import status
GET    /v1/admin/skill-packs/:id/catalog  browse (planIngest: candidates + eligibility + counts)
POST   /v1/admin/skill-packs/:id/import   { selected: "all" | string[] }
PATCH  /v1/admin/skill-packs/:id          edit ref / subset / trustTier / config
DELETE /v1/admin/skill-packs/:id          remove pack + archive its imported skills
```

Or use the **Admin UI → Skill packs** tab (register form, browse with select-all/pick, import, remove).

## Registering a private pack

First vend a read-only deploy token as an org service credential, then register the pack at a pinned
commit.

1. **Vend the deploy token** (Admin UI → Governance → Shared service credentials, or
   `PUT /v1/admin/scopes/org:<org>/service-credentials`): create a credential with a slug like
   `skills-repo-token` whose secret is a GitHub token with read access to the repository.

2. **Register the pack** (Admin UI → Skill packs → Register, or `POST /v1/admin/skill-packs`):

   ```json
   {
     "url": "https://github.com/example/acme-skills",
     "ref": "<pinned commit SHA>",
     "authCredentialSlug": "skills-repo-token",
     "trustTier": "third-party"
   }
   ```

   Personal/missing-scope/private skills and any name colliding with a native skill are excluded
   automatically and shown with their reason in the catalog.

3. **Browse + import**: open the pack, review the candidate list (≈ the company/both skills, minus
   the `publish` collision), and **Import all**. The imported skills appear on the **Skills** page as
   `published`, `createdBy: pack:<id>`, with `pack.commit` provenance.

4. **Updating**: bump the pack `ref` (PATCH) and re-import. Removing the pack archives its skills.

The skills are governed store records, visible and auditable on the admin Skills page, rather than
ungoverned files on each box.
