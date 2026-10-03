I'd like to use OpenSandbox as QM's sandbox backend. QM already has a `Sandbox` interface, but adding another implementation currently means changing `src/wiring.ts`.

Could a deployment pass a custom factory that returns a `Sandbox`? That would let me keep the OpenSandbox integration in the deployment instead of modifying QM core.

The same registration or factory extension-point pattern could also let deployments provide:

- a new `Sandbox` implementation
- a new `Harness` implementation
- a new `MemoryService` implementation
