# AWS task architecture should match the published image

I was reading through QM because I wanted to understand how it might work alongside our Hermes setup. While following the default AWS deployment flow from the release build to the generated ECS task definitions, I noticed what looks like an architecture mismatch.

The release workflow builds QM’s published service images for `linux/amd64`. The AWS scaffold does not set an architecture for the built-in services, so QM defaults those workloads to ARM64. The generated Fargate task definitions therefore request ARM64, while the normal image-transfer path copies the existing published image into ECR without rebuilding it for ARM64.

I also checked the image references published with the `v0.1.4` release. The five images used by the generated ECS services, `core`, `web-ui`, `admin`, `portal`, and `auth`, are AMD64-only. The separately published `sandbox-base` image is also AMD64-only, although it is not one of these ECS services.

This appears to leave a fresh AWS deployment with ARM64 tasks pointing to AMD64-only images, so the affected containers may fail to start. I have not reproduced this through a live AWS deployment. This finding is based on tracing the deployment code and tests, and checking the platforms supported by the published release images.

I think the default AWS deployment path should guarantee that the architecture requested by an ECS task matches the exact pinned image used by that task.

A few possible ways to handle this would be:

- publish the first-party service images for both AMD64 and ARM64;
- default the generated AWS services to AMD64; or
- inspect the pinned image during deployment and use it to validate or determine the task architecture.

I do not have a strong preference about which solution fits QM best. The important outcome is that a default AWS deployment should not produce an ECS task and container image with incompatible architectures.

It would also be useful to add a CI check covering every first-party image used by a generated ECS service. The check could inspect the exact pinned image, determine which platform it supports, compare that with the generated task definition, and fail before deployment if they do not match.
