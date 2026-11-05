# Production cutover decision required

The four target names already exist as published deployment-layer skills in `org:acme`. A Git pack import will classify them as collisions; it will not replace them automatically.

Current snapshot:

| Name                      | Version | Status    | Owner                   |
| ------------------------- | ------: | --------- | ----------------------- |
| finance-reconciliation    |      46 | published | system:deployment-layer |
| finance-router            |      56 | published | system:deployment-layer |
| netsuite-readonly-finance |      46 | published | system:deployment-layer |
| sharechat-ar-collection   |      62 | published | system:deployment-layer |

After isolated staging succeeds, a human must approve one production strategy:

1. Keep deployment-layer ownership and update the existing skills through a reviewed deployment-layer revision, preserving the existing record lineage.
2. Migrate ownership to a Git pack by archiving/removing the deployment-layer versions in a coordinated maintenance window, importing the pinned pack, verifying runtime resolution, and retaining a tested rollback revision of the deployment layer.
3. Publish temporary candidate names for parallel user acceptance, then perform one of the two ownership transitions above after approval.

The replacement table must include the current skill IDs, full before/after manifests and file hashes, tool/capability behavior, rollback order, and expected version/history effects. This pack preparation does not choose or execute a production strategy.
