# Private schedule publication

Native cron share can publish a selected private task or exact-text schedule into an authorized managed Team or workbook scope. It requires once-only approval of the source ID, configuration revision and canonical destination. Approval states that the original pauses, its private history remains private, and the copy posts future results into a fresh shared conversation. A disabled, archived or completed one-shot source produces a disabled copy. An active source preserves its next eligible execution time.

The original cron remains private. Publication creates a different cron and a new shared result conversation. It does not copy old fires, private conversation references or shift-change notes. The source and copy retain the original owner, creator, task-author restriction and owner-consent metadata; publication cannot convert automation-authored work into owner-authored work. Script and loop publication remain unsupported, as do personal, organization, persona, bare team, channel and unmanaged-group targets. These are explicit checkpoint exclusions: scripts need a trial in the new execution home; loops need their bound state copied consistently; other audiences need a corresponding shared execution/delivery context. No full-category completion is claimed.

## Authorization and transactions

The authenticated live owner must open their personal context. Source ownership and target membership are rechecked under cron-access. Retained foreign sources use the common artifact disclosure policy. The fresh shared conversation has current participants and retained source provenance before publication. Workbook result conversations recheck live managed-group membership when read, including after revocation.

A stable copy ID binds source ID, selected configuration revision and target. Existing DurableMap.mutateMany atomically inserts the copy and pauses the original. The source row is locked and its approved revision rechecked. The revision includes identity, authority, privacy, source restrictions, enabled/archive state, task/message, title, schedule, runtime, script, loop binding, source session and destination. It excludes fire history, notes, scheduling cursors and attempt telemetry. Copy scheduling uses the row-locked current cursor, preserving concurrent execution progress. Existing publication lookup makes retries return the same copy after the source has paused. The App path repeats queue notifications after a committed retry; it does not recreate or re-enable either schedule.

Both IDs notify the existing scheduler after commit. Future exact-text and task results post to the new web conversation. Before enqueueing, runTrigger merges configured provenance and the actual task execution session's provenance into the destination session. No new transport payload is needed. Private mode still cannot edit the shared copy. Ordinary cron edits and grant/replacement writes share the cron-access lock and validate retained restrictions against current readers/destinations.

## Data and API disclosure

No SQL tables, keys, indexes, constraints, enums, migrations, backfills, environment variables, providers or user settings change. Cron and DeliveryProvenance JSON shapes remain unchanged. Upgrade readers/writers together before using publication. Existing ordinary schedules retain their sharing behavior, subject to retained-source validation. Historical private schedules require present source provenance; unknown sources are not silently cleared.

The complete Cron type remains the one disclosed in private-trigger-context.md. Every field is accounted for:

| Fields                                                   | Original after publication | New shared copy                                                                                 |
| -------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| id                                                       | unchanged                  | stable publication ID                                                                           |
| ownerScopeId                                             | unchanged personal home    | approved Team/workbook home                                                                     |
| owner, createdBy, ownerConsentedAt, botActor, taskAuthor | unchanged                  | preserved, including optional absence                                                           |
| title, action or message, runtime, schedule              | unchanged                  | preserved, including optional absence                                                           |
| personalOnly                                             | true                       | omitted                                                                                         |
| sourceProvenance                                         | unchanged                  | remove only consenting personal source; retain sensitivity, sourceUnknown and all other sources |
| enabled                                                  | false                      | selected active state, except archived/completed one-shots stay disabled                        |
| createdAt                                                | unchanged                  | publication time                                                                                |
| nextFireAt                                               | unchanged                  | next eligible cursor from current locked source; omitted for completed one-shot                 |
| destination                                              | unchanged                  | web destination for fresh shared conversation, with approved audienceScopeId                    |
| sessionRef, lastFireNote                                 | unchanged                  | omitted                                                                                         |
| lastFiredAt, lastAttemptAt, deferUntil, archived         | unchanged                  | omitted                                                                                         |
| loopId, script                                           | unchanged                  | publication refused when present                                                                |
| fire-store rows and run sessions                         | unchanged/private          | none copied; new fires use new IDs/sessions                                                     |

Invented representative before:

```json
{
  "id": "private-example",
  "ownerScopeId": "personal:alice",
  "owner": "alice",
  "createdBy": "alice",
  "enabled": true,
  "createdAt": 1000,
  "schedule": { "everyMs": 3600000, "firstFireAt": 3601000 },
  "nextFireAt": 7201000,
  "title": "Synthetic report",
  "action": "Produce the selected report",
  "taskAuthor": "automation",
  "personalOnly": true,
  "sourceProvenance": {
    "sources": ["personal:alice", "group:allowed-source"],
    "sensitivity": "restricted",
    "sourceUnknown": false
  },
  "sessionRef": "web:alice:private",
  "lastFireNote": { "text": "Private old note", "at": 2000 },
  "lastFiredAt": 3601000,
  "destination": { "type": "principal", "target": "alice", "audienceScopeId": "personal:alice" }
}
```

After: the original row is exactly the row above with enabled=false. Its private fire rows are unchanged. The new row is:

```json
{
  "id": "computed-publication-id",
  "ownerScopeId": "group:team",
  "owner": "alice",
  "createdBy": "alice",
  "enabled": true,
  "createdAt": 4000000,
  "schedule": { "everyMs": 3600000, "firstFireAt": 3601000 },
  "nextFireAt": 7201000,
  "title": "Synthetic report",
  "action": "Produce the selected report",
  "taskAuthor": "automation",
  "sourceProvenance": { "sources": ["group:allowed-source"], "sensitivity": "restricted", "sourceUnknown": false },
  "destination": { "type": "web", "target": "web:alice:computed-publication-id", "audienceScopeId": "group:team" }
}
```

The new result conversation uses the existing Session shape, with shared scope, current participants, no private flag, and retained context_provenance before any output. The original private session is unchanged. A failed copy transaction can leave an empty shared conversation, containing no private content.

Existing share action fields action/id/toScope/permission remain. Cron share now accepts optional privateRevision:string, using existing ArtifactHome.privateRevision and refusal privateRelease:{id,revision,scope}. HTTP still cannot supply release authority. Approval record and resolution shapes are unchanged. For successful private cron publication, ShareArtifactResult.id is the new copy's ID; ordinary sharing still returns the original ID. The result remains {ok:true,verb:"share",type:"cron",id,target:{scope,label},permission}.

Internal old/new changes:

- CronStore retains every existing method and adds publishPrivate(id:string,revision:string,target:ScopeId,provenance:SourceProvenance):Promise<Cron>.
- App retains every existing method and adds publishPrivateCron(id:string,revision:string,target:ScopeId,by:CronEditor):Promise<Cron>.
- TriggerDeps.sessions remains optional. Its participantScopes(principalId):Promise<readonly {scopeId:ScopeId}[]> contract is retained; supplied stores now also implement SessionStore.get, getByThread and recordContextProvenance. No new settings or fallback mode.
- DurableMap and all persisted delivery/approval payloads are unchanged in this checkpoint.

## Verification and limits

Eight publication cases cover approval preflight, private history separation, stale revisions/atomic rollback, foreign-source refusal, preserved cadence, real automatic task/exact-text fires through PostgreSQL's queue, retained/configuration and execution provenance on the destination, workbook membership revocation, and replay through the control API after source pause. Native approval binding is covered by the tool suite. The final six-file affected batch passes; earlier seven-file session/document/ACL/store and three-file trigger/provenance batches pass. Typecheck and changed-file ESLint pass.

A broader trigger batch passes six of seven files. The script suite has two local failures because setsid is absent; running the unchanged previous checkpoint independently reproduces both failures. Test infrastructure was not changed for that environment limitation.

Live document-surface QA used a synthetic private schedule seeded through the production store, with an old private fire and private note. One native approval published a paused copy. The owner resumed it in shared context, ran it once with a real model, and paused it again. Another user read the exact scheduled result from the shared result conversation. The original private schedule was unchanged, and its private-history canary was absent from every nonpersonal session. Identities and private preferences were restored. Screenshots remain outside Git.

Independent available-model checkpoint reviews accepted authorization/provenance94 and durability/transaction/replay96, with Historylessness99. These are checkpoint reviews, not full-head model-specific Wall coverage. Unsupported publication categories and the separate managed-computer privacy audit remain open.
