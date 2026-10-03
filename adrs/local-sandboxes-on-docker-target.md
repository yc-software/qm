# Local sandboxes on the docker target

Hi — we're PipesHub. We ship a CLI that a QM agent runs with `execute`, so a working sandbox on the operator's machine is the only way someone can try the integration on a laptop without Fly Sprites.

`target: docker` today runs core locally but still has no supported sandbox backend that actually executes. That's already written up in #278 and #271, and #411 looks like the implementation. We're not proposing a new design.

What we're asking is a product decision: is `sandbox.backend: "local"` on `target: docker` something you want to support and document? If yes, we'd happily test a branch against a real tool. We know mounting the Docker socket into core is a security decision — that's yours.

We didn't open a new issue so this wouldn't sit twice.
