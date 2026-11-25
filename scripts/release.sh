#!/usr/bin/env bash
# Cross-compiles the installable (panel included) for Linux and writes tarballs plus checksums to release/.
# Uses the panel already embedded in the repo; run scripts/build-agent.sh --panel-only first if src/ changed.
# Usage: scripts/release.sh [version]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="${1:-$(git -C "$root" describe --tags --always 2>/dev/null || echo dev)}"
out="$root/release"
rm -rf "$out" && mkdir -p "$out"

for arch in amd64 arm64; do
  name="nodo-agent_${version}_linux_${arch}"
  stage="$out/$name"
  mkdir -p "$stage"
  (cd "$root/agent" && CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X main.version=$version" -o "$stage/nodo-agent" ./cmd/nodo-agent)
  cp "$root/scripts/install.sh" "$stage/install.sh"
  tar -C "$out" -czf "$out/$name.tar.gz" "$name"
  rm -rf "$stage"
done
(cd "$out" && sha256sum ./*.tar.gz > SHA256SUMS)
ls -l "$out"
