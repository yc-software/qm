# Canonical transcript cutover

Existing PostgreSQL deployments must first run the compatibility release that adds migration `sessions/store/0017-transcript-entries`. That release atomically mirrors every entry and taint revision into the tape while preserving legacy reads and writes. Drain every older core and background writer before migrating histories.

Take a recoverable database backup and check free storage before the additive backfill. Large stores can prebuild the `session_tape_transcript_entries` partial index concurrently using the exact definition from migration 0017. Use the reviewed migration tools from the cutover source while application services remain on the compatibility release. First apply the additive payload-format migration; it accepts both older nested annotations and lossless serialized payloads without establishing transcript authority:

```sh
npm run prepare:transcript-tape
npm run migrate:transcript-tape -- --apply
npm run migrate:transcript-tape
```

Escaped NUL characters and lone surrogates remain byte-for-byte in a serialized payload string. Small derived attributes support SQL metadata queries without parsing unsupported Unicode. The operator verifies those attributes against the decoded authoritative payload, and preserves raw formatting for exact qualification. After cutover, run search-index repair for historical rows whose old search projection could not decode the payload.

The operator pages entries under each session's writer lock and verifies each applied page. It preserves existing sparse sequence IDs and parent references without filling holes or renumbering. It refuses invalid negative identities, unexpected canonical entries, and unrepresentable payload changes. It reports active sessions for reconciliation. An interrupted apply can resume with `--after <last-completed-session-id>`; a resumed or capped scan is explicitly partial and cannot qualify the whole corpus. Preserve the original histories when investigating any rejected data.

Only a complete, uncapped operator pass with no busy histories qualifies the payload and derived metadata; a SQL-only payload comparison is insufficient for encoded metadata. After the backfill, run the exact cutover candidate's gate before starting its production tasks:

```sh
npm run qualify:transcript-cutover
```

This applies the ordinary migration ledger, including migration 0018. The gate rejects orphaned histories, missing or changed entries, extra canonical entries, and invalid identities. Existing source gaps remain unchanged; every surviving source row must have an exact canonical counterpart. It compares original payloads, timestamps, scopes, and parent identities one session at a time, including sessions the backfill skipped as busy. Its safety depends on all remaining writers preserving the atomic compatibility invariant. Do not deploy another schema migration concurrently with this qualification.

Only a successful gate records transcript authority and moves search indexing to canonical annotations. Deploy that same immutable candidate and verify full, bounded, participant-scoped, and continuation reads. Backfill apply is rejected after authority is established.

Normal transcript writes now update only the tape. Deploy and retain the preceding tape-authoritative release as the rollback target before deploying this write-stop release. Before starting any write-stop process, drain every pre-authority core, standby, background, and maintenance writer. The earlier compatibility release still allocates from the legacy table and cannot coexist with tape-only writes; only tape-authoritative writers may remain. Stop all backfill processes before qualification as well, including older binaries without the startup guard.

Keep the frozen table and recovery backups until the deployment's retention policy permits deletion. Model replay imports and harness-specific reconstruction remain separate from transcript storage; exact transcript annotations never fabricate model replay coverage.
