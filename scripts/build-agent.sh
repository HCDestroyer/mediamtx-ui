#!/usr/bin/env bash
# Rebuilds the panel into agent/internal/web/dist (committed, so `go build` alone yields the full
# installable) and then builds the single nodo-agent binary.
# Usage: scripts/build-agent.sh [output] [version]      scripts/build-agent.sh --panel-only
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
embed="$root/agent/internal/web/dist"

(cd "$root" && npm run build)
rm -rf "${embed:?}"/*
cp -r "$root/dist/." "$embed/"
echo "panel embedded in $embed"
[ "${1:-}" = "--panel-only" ] && exit 0

out="${1:-$root/agent/nodo-agent}"
version="${2:-$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)}"
(cd "$root/agent" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$out" ./cmd/nodo-agent)
echo "built $out ($version): $(du -h "$out" | cut -f1)"
