# Execution isolation rollout

Execution mode belongs to a sandbox resource. Existing resources and records without a mode remain legacy. Their credential injection, file-login persistence, and native provider recovery remain available. Deploying the isolation code does not migrate workspaces, change defaults, or enroll existing machines.

The `command_scoped_credentials` feature flag permits explicit creation of new isolated resources in an enabled owner scope. Creating a resource without requesting isolated mode retains legacy behavior. An isolated resource keeps its mode when the flag is disabled. Every operation on that resource, including file access, background processes, and recovery, must use its saved mode rather than a caller-supplied handle flag.

Start with a fresh isolated resource in a personal scope and select it explicitly by sandbox ID. Leave the existing default and its scheduled work untouched. Verify requested credentials, executions without credentials, and provider recovery before expanding to a shared scope. Reverting a canary means selecting the preserved legacy resource; it does not downgrade the isolated resource or automatically copy new files back.

Isolated execution requires a newly allocated physical machine or a physical generation with an established durable supervisor trust record. A matching scope name, guest file, or recovered machine identifier does not establish trust. Never mark an existing unmanaged guest trusted by writing a marker or inserting its identity into the trust store. Dependency and namespace checks must succeed before execution.

Legacy resources retain full-home portable restore and existing provider-native recovery. Isolated portable recovery restores regular workspace files and directories; home startup files, credentials, symlinks, hardlinks, and device nodes are excluded. This filtered restore is not a general workspace migration tool: linked Git metadata and other excluded filesystem entries need explicit handling before a copied project can be considered usable.

Isolated Modal native recovery requires supervisor provenance in the durable provider record. Isolated E2B resources use portable workspace recovery and kill-on-expiry rather than native memory pause or snapshots. Legacy E2B pause and legacy Modal native restoration retain their existing behavior. Provider recovery deadlines still apply. Independent backup and cross-provider migration are separate work; the opt-in rollout does not require migrating the fleet.

Provider images require Python 3, bubblewrap, util-linux, and libseccomp for isolated execution. Custom images and provider-owned templates must supply these dependencies or pass the trusted bootstrap installer. Local Docker additionally needs the namespace capabilities configured by the local adapter. Execution fails closed if the guest kernel or provider blocks the required boundary.

Porter isolated execution currently fails closed. Its sandbox execution API does not expose stdin or a private binary file upload API; its volume upload API alone cannot cover scratch sandboxes. Credential request bodies are never substituted into command arguments as a fallback. Other adapters stage request bytes through native file uploads or process stdin, inside root-only directories.

An isolated execution can combine standing grants but accepts at most one single-use grant. The single-use grant is claimed after authorization, provisioning, and credential conflict checks, immediately before sandbox dispatch. A subsequent staging or transport failure does not refund the grant.
