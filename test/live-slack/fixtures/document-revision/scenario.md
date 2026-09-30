# Branded document revision and visual inspection

This is a synthetic reconstruction of a document-editing failure pattern. All names, business content, contacts, and artwork are fictional. It preserves the order of the important interactions without copying a private conversation or its artifacts.

## Prepare the fixture

From the repository root, generate the PDF once into a private directory outside the
checkout. The builder pins its timestamp; the dependency version below keeps the
output repeatable. It checks and prints the PDF's SHA-256. Reuse that single
generated file for both revisions and both uploads in each run.

```sh
QA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qm-document-revision.XXXXXX")"
uv run --with reportlab==4.4.9 python test/live-slack/fixtures/document-revision/build_fixture.py "$QA_DIR/beacon-original.pdf"
pdfinfo "$QA_DIR/beacon-original.pdf"
pdftotext -layout "$QA_DIR/beacon-original.pdf" "$QA_DIR/source.txt"
pdftoppm -singlefile -png -scale-to 1568 "$QA_DIR/beacon-original.pdf" "$QA_DIR/source"
```

Check that `pdfinfo` reports one page and inspect `source.png` before testing. Only
`beacon-original.pdf` goes to the agent. Keep `source.txt`, the renderer output, this
scenario, and the builder in the evaluator's private directory or checkout.

## Inputs

- `beacon-original.pdf`: a one-page source with a graphic logo, substantial product detail, twelve report examples, a comparison table, a three-week pilot, an original contact, and a 45-minute meeting offer.
- Reattach the identical original at turn 7. Record its SHA-256 once and verify both runs use the same bytes.
- Keep the fixture builder and the evaluation rubric out of the model's workspace. The agent receives only the PDF and the user messages below.

## Controlled runs

Run once against the unfixed revision and once against the revised PR, through the real Slack development instance. Use fresh conversations and clean artifact workspaces, the same model and settings, identical fixture bytes, and identical ordered prompts. Record code revisions, loaded skill versions, runtime identity, and timestamps. Execute every turn in both runs even if an earlier assertion fails. Do not coach one run based on the other run's output.

Boot each checkout with the [dev-instance skill](../../../../.codex/skills/dev-instance/SKILL.md)
and its own Slack app. Pin the harness, model, reasoning effort, fast mode, Codex
binary version when applicable, and sandbox image across instances. Record skill
versions separately because the revised skill may be part of the change under test.
Use a fresh channel for each document run and each isolated image probe: a new
thread in an old channel still shares that channel's artifact workspace.

Use Slack in Firefox to send the turns and attachments in one thread per document
run. Add only the bot mention needed to address it; do not append markers, rubric
requirements, or hints. Wait for each core run to finish and its Slack delivery to
settle before sending the next turn. A stable commentary message is not a completed
turn. Record failed or missing deliverables and continue the ordered prompts.

Before the full document flow, repeat the same isolated workspace-image read on both revisions using the existing synthetic visual probe. The agent must identify a visible feature from the returned image; it must not receive the answer, generator source, OCR output, or descriptive filename. Capture the actual provider-bound tool result privately, with image bytes redacted from normal logs. Expected unfixed behavior is binary decoded as text or a text-only bridge, with no image supplied. Expected fixed behavior is actual image content and a correct observation. Do not rely solely on the agent saying that it looked at the image.

For a probe using only repository fixtures, copy
[`taylor-selfie.png`](../taylor-selfie.png) to the neutral name `probe.png` outside the
checkout. Privately record the visible feature to check before either run. Seed
only those PNG bytes into each probe channel's sandbox workspace, and send the
same request to read `probe.png` with `files` and describe that feature. Do not
attach the probe to Slack: an inbound image would test a different path.

With local Docker sandboxes, the existing admin sandbox routes can create a local
sandbox and select it for `channel:<channel-id>` before any agent turn. Copy
`probe.png` to the returned `machineId` at `/root/workspace/probe.png` with
`docker cp`, then verify its SHA-256 inside the container. The subsequent channel
turn uses that selected workspace. Keep all instance and container IDs private.

## User turn sequence

1. Upload `beacon-original.pdf`: "Review this one-pager. I want conference contacts to forward it to their maintenance, operations, and compliance colleagues. Tell me what would make it more useful."
2. "Can we make our own version? The current version looks too generic. Create a one-page PDF and check it before sending it."
3. "Keep more of the original content. Retain the report examples, comparison table, and pilot details."
4. "Can you send me the latest version?"
5. "Make it look more professional and easier to scan. Use a clean sans-serif layout with restrained styling."
6. "Create two versions: one for maintenance managers and one for compliance reviewers. Keep the useful product detail and make the emphasis relevant to each audience. Send both PDFs."
7. Reattach the identical original: "Let's work from this original again. Make targeted edits: replace Alex Lane and alex@beacon.example with Jordan Reed and jordan@beacon.example, make the meeting 30 minutes, and remove anything that does not help. Keep the useful detail. Send the revised PDF."
8. "Keep the original graphic logo, not just the company name. Send the updated PDF."
9. "Now add restrained styling to make it easier to scan."
10. "Draft a short follow-up for the compliance reviewer and attach the version I should send now."

## Checkpoints

Capture every delivered PDF and its SHA-256. Inspect text, actual rendered pages, tool history, and the selected artifact identity.

Download the actual Slack attachment for each file message, including both files
at turn 6. Record its Slack file ID, message timestamp, local filename, SHA-256,
page count, and extracted text privately; render every delivered page. A file in
the core artifact store or a filename mentioned in a reply does not prove delivery.

| Checkpoint                       | Observable requirement                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First generated preview          | The preview read actually supplies image content to the model; the model can use it to inspect the artifact.                                                                                                            |
| Turn 3                           | The requested revision is produced in that turn, rather than only promised. All twelve report examples, the table's substantive comparisons, and the three-week pilot remain.                                           |
| Turn 6                           | Two distinct, accessible PDFs contain relevant maintenance/compliance emphasis and retain the core product information.                                                                                                 |
| Turn 7, before the logo reminder | The graphic logo survives the targeted edit. The new contact and 30-minute meeting appear; the old contact and 45-minute offer are absent.                                                                              |
| Turn 9                           | The delivered main PDF has the graphic logo, readable single-page layout, intact substance, new contact, and 30-minute meeting. No text is clipped or overlapping.                                                      |
| Turn 10                          | The actual attached compliance variant contains the latest contact and 30-minute offer, retains audience-specific emphasis, and preserves the graphic logo. Recommending an earlier 45-minute variant fails this check. |

For content retention, compare meaning and coverage rather than demanding identical prose or a fixed word count. Record word counts as evidence, not as the sole pass criterion. Treat visual preferences as observations, not deterministic failures.

## Capture tool evidence

Reuse the authenticated requests in [`core.ts`](../../core.ts):

- `/v1/admin/runs?scope=<scope>` identifies completed runs by their thread reference.
- `/v1/admin/sessions/<id>?scope=<scope>&limit=50000` returns the transcript and
  delivery events. Retain the `files` read call and its result, correlated by
  `callId`, for the isolated probe and the first generated preview.
- `/v1/admin/sessions/<id>/llm?scope=<scope>&turnSeq=<user-seq>` includes the captured
  request for that turn. Omitting `turnSeq` returns metadata without request bodies.

Codex's stored request includes its `threadStart` configuration, while its stored
tool tape replaces image content with `[image omitted]`. Neither is sufficient to
verify image transport. Capture the actual result at the Codex app-server bridge
using the existing `CODEX_BIN` executable seam, relaying traffic unchanged to the
same real binary on both revisions. Correlate the `files` call with its response
and record `contentItems` types, image MIME type, decoded byte count, and SHA-256;
redact image bytes from ordinary logs. State the capture boundary accurately:
QM-to-Codex bridge evidence is not a provider HTTP request capture. Keep the raw
capture private and pair it with the model's visible-feature observation.

[`slack.ts`](../../slack.ts) already provides real uploads, thread reads, and
permalinks when a QA user token is available. This manual workflow also works
without that token through Firefox. Do not use the catalog runner's retry or
reply-only judge to decide these checkpoints, and do not use its Chrome screenshot
sweep for this Firefox QA.

## Reporting

Keep three conclusions distinct: image transport reproduction, document quality/revision checks, and overall before/after comparison. The baseline may reproduce the image defect without reproducing every content or branding mistake. Report each observed result accurately; never manufacture a baseline failure or infer visual access solely from a correct PDF. If the fixed run fails a required checkpoint, investigate and rerun both sides when the scenario or shared setup changes.

Store raw transcripts, instance identifiers, screenshots, and artifacts privately outside Git. Public evidence may contain this fictional scenario, synthetic fixture generation, exact source revisions, generic results, and sanitized proof excerpts. Do not include customer information, private URLs, credentials, real workspace identities, or screenshots of unrelated Slack content.
