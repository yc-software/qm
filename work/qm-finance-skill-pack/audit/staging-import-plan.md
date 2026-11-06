# Staging import plan

## Safety boundary

Do not register or import this pack into the current `org:acme` database during preparation. The target names collide with existing published organization skills, and same-organization staging would distort resolution and provenance.

## Repository preparation

1. Place this workspace in a dedicated private Git repository outside the public QM checkout.
2. Commit only `skills/`, `pack.config.json`, public-safe audit summaries, and validation tooling.
3. Run `python3 validate.py` from the repository root.
4. Run all bundled tests with cache generation disabled or remove generated caches before commit.
5. Record the commit SHA and the generated `audit/bundle-manifest.json` hashes.
6. Give the staging deployment a read-only repository credential through QM's service-credential UI. Do not embed the token in the pack URL or repository.

## Isolated staging environment

Use a separate QM development instance with:

- a separate organization identifier;
- a separate Postgres database;
- a separate object-storage namespace;
- test or sandbox credentials only;
- the same QM commit intended for production;
- required brokered tools available, including the governed NetSuite execution and finance artifact/workflow tools where applicable.

## Registration

Register the private repository at its pinned commit with configuration equivalent to:

```json
{
  "skillGlobs": ["skills/*"],
  "exclude": ["archive/**", "source-hermes/**", "**/*.bak", "**/__pycache__/**", "**/.DS_Store"]
}
```

Browse the catalog before import. Expected result for the first slice:

- four candidates;
- four eligible;
- zero malformed;
- zero private/scope exclusions;
- zero binary exclusions;
- zero collisions in the isolated staging organization.

## Staging verification

For every skill:

1. Confirm stored provenance contains the pack ID, pinned commit, and upstream name.
2. Confirm status is published only after review.
3. Read the skill through the normal agent skills tool.
4. Confirm all expected references, scripts, and tests materialize under the conversation-specific skill directory.
5. Confirm no legacy runtime paths or direct credentials appear in the materialized copy.
6. Exercise representative discovery prompts and verify the correct skill is selected without ambiguous overlap.
7. Exercise denied, incomplete, and unavailable-source paths; verify the skill blocks rather than bypassing the broker or inventing data.
8. Run permitted happy-path tests with sandbox/test evidence only.
9. Bump the pinned commit, re-import, and verify an update occurs in place with new provenance.
10. Remove the pack and verify its skills archive rather than remaining active.
11. Restore/re-register only if rollback behavior was observed and recorded.

## Production proposal

After staging passes, produce a human-reviewed replacement table for every existing `org:acme` skill:

- current skill ID and version;
- candidate pack name and commit;
- manifest and file hashes before and after;
- behavior or capability changes;
- migration, rollback, and compatibility impact.

Production publication requires separate approval. Do not archive or overwrite existing organization skills automatically.
