# Inwise OSS meeting layer for QM

We are providing Inwise OSS as a local meeting-memory layer for QM. It lets a personal QM agent search meetings, transcripts, people, upcoming meetings, and action items without requiring Inwise Cloud.

This PR includes the adapter under [`integrations/inwise`](../integrations/inwise/README.md):

- a read-only `inwise` CLI and QM [`tool.json`](../integrations/inwise/qm/tool.json)
- a QM meeting-memory [`SKILL.md`](../integrations/inwise/skill/SKILL.md)
- an outbound laptop connector and encrypted self-hosted relay
- a reproducible QM deployment fixture and [passing bridge test](../integrations/inwise/e2e/TEST_REPORT.md)

Meeting data remains in the user's local Inwise installation. Inwise provides conversational memory and action-ready context management.
