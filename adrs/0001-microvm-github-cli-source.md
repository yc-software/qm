# ADR-0001: Source GitHub CLI from immutable release artifacts for MicroVM images

**Status:** Proposed
**Date:** 2026-08-02
**Deciders:** QM maintainers

## Context

The AWS MicroVM guest image installs GitHub CLI from GitHub's rolling RPM repository while requesting an exact RPM version. The repository no longer retains every historical version: `gh-2.96.0-1` was removed, causing builds to fail even though the QM release and base image were unchanged. Lambda MicroVM reports this only as a generic container-build failure.

## Decision

Fetch GitHub CLI from a versioned GitHub release artifact for each supported architecture and verify its SHA-256 checksum in the MicroVM Dockerfile. Keep the CLI version and hashes explicit so an image can be rebuilt later from the same inputs.

## Options Considered

### Option A: Keep the exact RPM version from the rolling repository

| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Reproducibility | Low |
| Maintenance | Reactive |

**Pros:** Smallest Dockerfile change.

**Cons:** Historical RPMs can disappear, breaking an unchanged QM release.

### Option B: Install the latest RPM from the rolling repository

| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Reproducibility | Low |
| Maintenance | Low |

**Pros:** Avoids an immediately unavailable version.

**Cons:** The same QM version can produce materially different images over time.

### Option C: Download a versioned release artifact and verify its checksum

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium |
| Reproducibility | High |
| Maintenance | Deliberate version updates |

**Pros:** Matches the existing pinned base image, AWS CLI, and Litestream inputs; failures are limited to a deliberate version or checksum update.

**Cons:** Requires maintaining one checksum per architecture when GitHub CLI is upgraded.

## Trade-off Analysis

Option C adds a small amount of version-maintenance work, but removes a dependency on retention behavior that QM does not control. That is the better trade for deployment infrastructure intended to be rebuilt from a fixed CLI release.

## Consequences

- AWS MicroVM builds remain rebuildable after RPM repository cleanup.
- GitHub CLI upgrades become explicit, reviewable changes.
- The Dockerfile carries architecture-specific release checksums.

## Action Items

1. [ ] Replace the RPM-repository install step with checksum-verified GitHub release artifacts for AMD64 and ARM64.
2. [ ] Add a build test that exercises the MicroVM Dockerfile dependency layer.
