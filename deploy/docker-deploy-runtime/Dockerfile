# The optional default deploy-runtime image for DEPLOY_PROVIDER=docker when
# SANDBOX_BACKEND=do-managed-agents (src/config.ts's MANAGED_AGENTS_DEPLOY_IMAGE,
# tag qm-deploy-runtime:ubuntu24-node20) — not published to any registry.
# Build it with:
#   docker build -t qm-deploy-runtime:ubuntu24-node20 -f deploy/docker-deploy-runtime/Dockerfile .
# then make sure the image is present in whatever Docker daemon
# DEPLOY_PROVIDER=docker actually drives (DOCKER_HOST) before a publish is
# attempted — e.g. docker save/load it in at provisioning time if that
# daemon is otherwise isolated and can't pull from the build host directly.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Node.js 20.20.2 via NodeSource, pinned explicitly — matches the
# DigitalOcean Managed Agents sandbox's own Node ABI (NODE_MODULE_VERSION
# 115) and glibc base (Ubuntu 24.04, glibc 2.39), so a native npm addon
# compiled during an agent turn loads correctly when the published app runs
# here. gcc/g++/make/python3 come from Ubuntu 24.04's own repos (13.3.0,
# 4.3, 3.12.3 respectively, as of this writing) — node-gyp's actual build
# toolchain for packages with no prebuilt binary (e.g. better-sqlite3, whose
# npm tarball ships no prebuild at all and always falls back to a from-
# source node-gyp rebuild).
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y -qq --no-install-recommends \
    nodejs=20.20.2-1nodesource1 \
    build-essential \
    python3 \
  && rm -rf /var/lib/apt/lists/* \
  && node --version && npm --version && g++ --version | head -1 && make --version | head -1 && python3 --version
