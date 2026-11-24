#!/usr/bin/env bash
# Build and qualify the instrumented engine for the provisioned CrowdSec version.
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
provisioning="$script_dir/../src/lib/server/provisioning/index.ts"
if [[ -f $provisioning ]]; then
  pin=$(sed -nE "s|.*crowdsec: \\{ repo: 'docker.io/crowdsecurity/crowdsec', version: '(v[0-9]+\\.[0-9]+\\.[0-9]+)' \\}.*|\\1|p" "$provisioning")
  [[ ${CROWDSEC_VERSION:-$pin} = "$pin" ]]
else
  pin=${CROWDSEC_VERSION:?Set CROWDSEC_VERSION to the provisioning version for a standalone build}
fi
[[ $pin =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
runtime=${CONTAINER_RUNTIME:-podman}
source_dir=$(mktemp -d)
trap 'rm -rf -- "$source_dir"' EXIT
curl -fsSL "https://codeload.github.com/crowdsecurity/crowdsec/tar.gz/refs/tags/$pin" |
  tar -xz --strip-components=1 -C "$source_dir"
(
  cd "$source_dir"
  git apply --check "$script_dir/crowdsec-learning-engine.patch"
  git apply "$script_dir/crowdsec-learning-engine.patch"
)
install -m 0644 "$script_dir/crowdsec-learning-engine-test.go" \
  "$source_dir/pkg/acquisition/modules/appsec/rudder_learning_test.go"
"$runtime" run --rm --cpus 1.25 --memory 2g \
  -e GOMAXPROCS=2 -e GOFLAGS=-p=2 -e "BUILD_VERSION=$pin" -v "$source_dir:/src:z" -w /src \
  docker.io/library/golang:1.27.3-alpine3.23 sh -ec '
    apk add --no-cache git g++ gcc libc-dev make bash gettext binutils-gold coreutils pkgconfig curl
    mkdir /tmp/re2
    curl -fsSL https://codeload.github.com/google/re2/tar.gz/refs/tags/2023-03-01 |
      tar -xz --strip-components=1 -C /tmp/re2
    make -C /tmp/re2 -j2 install
    git config --global --add safe.directory /src
    go test -run "^TestRudderLearningAlert$" ./pkg/acquisition/modules/appsec
    make crowdsec DOCKER_BUILD=1 BUILD_STATIC=1 CGO_CFLAGS=-D_LARGEFILE64_SOURCE
  '
"$runtime" run --rm --entrypoint /usr/local/bin/crowdsec \
  -v "$source_dir/cmd/crowdsec/crowdsec:/usr/local/bin/crowdsec:ro,z" \
  "docker.io/crowdsecurity/crowdsec:$pin" -version | grep -Fx "version: $pin"
if [[ ${1:-} != --verify ]]; then
  install -m 0755 "$source_dir/cmd/crowdsec/crowdsec" ./crowdsec
fi
