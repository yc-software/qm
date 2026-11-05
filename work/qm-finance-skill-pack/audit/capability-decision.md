# Capability decision

The four skill manifests intentionally declare `requiredCapabilities: []` for the preparation pack because no portable QM capability names have been approved for these deployment-specific finance tools.

This does not grant source access. The bodies refer to stage-scoped or brokered tools such as `netsuite_execute`, workflow transitions, finance artifact publication, and deployment-owned calculation/report tools. Availability and authorization remain controlled by the deployment tool catalog, workflow stage, principal grants, credential broker, and accepted evidence—not by the skill manifest.

Before staging publication, the isolated deployment must prove:

1. The tools are absent or denied outside their authorized workflow stage.
2. The tools become available only with the intended principal, stage, and source-plan approval.
3. Credential material is never returned to the agent.
4. A missing or denied tool produces a block rather than a fallback direct source read.
5. If deployment policy defines real capability names for these tools, the manifests are updated to those exact names and reviewed before import.

No capability names are invented in this pack.
