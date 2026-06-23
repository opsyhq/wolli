# The default docker-sandbox image (STEWARD_SANDBOX=docker): the slim base plus ripgrep + fd, which
# grep/find run inside the container. Published as ghcr.io/opsyhq/steward-sandbox (see config.ts).
#
# Rebuild + publish (multi-arch) after editing this file, then bump the tag in config.ts:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/opsyhq/steward-sandbox:<tag> --push -f packages/steward/docker/sandbox.Dockerfile .
FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep fd-find \
 && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*
