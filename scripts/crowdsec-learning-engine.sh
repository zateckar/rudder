#!/usr/bin/env bash
# Build the pilot engine in a private working directory next to the patch file.
set -euo pipefail
umask 077
source_dir=$(mktemp -d "$PWD/crowdsec-build.XXXXXXXX")
curl -fsSL https://codeload.github.com/crowdsecurity/crowdsec/tar.gz/refs/tags/v1.8.2 |
  tar -xz --strip-components=1 -C "$source_dir"
(
  cd "$source_dir"
  git apply --check ../crowdsec-learning-engine.patch
  git apply ../crowdsec-learning-engine.patch
)
podman run --rm --cpus 1.25 --memory 2g \
  -e GOMAXPROCS=2 -e GOFLAGS=-p=2 -e BUILD_VERSION=v1.8.2 -v "$source_dir:/src" -w /src \
  docker.io/library/golang:1.27.3-alpine3.23 sh -ec '
    apk add --no-cache git g++ gcc libc-dev make bash gettext binutils-gold coreutils pkgconfig curl
    mkdir /tmp/re2
    curl -fsSL https://codeload.github.com/google/re2/tar.gz/refs/tags/2023-03-01 |
      tar -xz --strip-components=1 -C /tmp/re2
    make -C /tmp/re2 -j2 install
    git config --global --add safe.directory /src
    make crowdsec DOCKER_BUILD=1 BUILD_STATIC=1 CGO_CFLAGS=-D_LARGEFILE64_SOURCE
  '
install -m 0755 "$source_dir/cmd/crowdsec/crowdsec" ./crowdsec
