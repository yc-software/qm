# App design systems

A design system is an ordinary published QM app selected as a reference. It can contain guidelines, components, brand assets, examples, or any other app content. `DESIGN.md` is useful but optional.

Administrators select the organization default in **Admin → Design system**. The chosen app must be readable by the organization. The starter is organization-owned and grants its creator editing access through ordinary app sharing.

People can select a separate app in **Settings → App design system**. Personal references apply in personal conversations; shared conversations use the organization reference. Access to each source is checked again when read.

For new apps, QM receives the latest successfully published organization version followed by the personal reference when applicable. Explicit app instructions take precedence. Existing apps retain their design until intentionally updated. Editing a reference does not automatically restyle apps already published.

The agent reads immutable source snapshots through `design://<app-id>/<version>/<path>`. These URIs are read-only and shared content is screened. The publish guidance asks the agent to save `design-sources.json` listing references actually used; this is agent-authored provenance, not enforced deployment metadata.

For local Docker development, `DOCKER_DEPLOY_BASE_PORT` selects the starting host port for published apps (default 9200). Use a distinct range for simultaneous dev instances.
