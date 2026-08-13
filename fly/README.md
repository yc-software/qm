# Fly sandbox image assets

The Fly deployment target uses the stock runtime provided by the installed
`@fly/sprites` SDK. That SDK version can create and delete Sprites but has no
supported path for supplying an OCI image or persistent environment.

Consequently these image assets are not part of the deployment-directory
contract. `qm` rejects Fly sandbox image fields, resident environment,
Dockerfiles, and tool binaries instead of accepting configuration it cannot
materialize. Deployments may still deliver text skills through the durable
deployment layer.

The Dockerfile and Fly configuration in this directory remain inputs to the
local contributor sandbox build. They do not publish or select a Fly
deployment's Sprites runtime.
