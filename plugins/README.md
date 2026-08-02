# Plugins

Plugins provide optional QM surfaces and services over the headless core. Each plugin
owns its setup, runtime behavior, and package checks:

- [`admin`](./admin/README.md) provides the administrative governance surface.
- [`auth`](./auth/README.md) provides the built-in email sign-in broker.
- [`onboarding`](./onboarding/README.md) provides first-run onboarding.
- [`portal`](./portal/README.md) provides the public SSO front door.
- [`web-ui`](./web-ui/README.md) provides the browser application.

`chassis` is shared plugin-to-core plumbing and has no standalone user surface. Follow
the repository boundaries in [`AGENTS.md`](../AGENTS.md) before changing shared plugin
behavior.
