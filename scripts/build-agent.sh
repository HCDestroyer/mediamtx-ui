#!/usr/bin/env bash
# Builds the panel and embeds it into a single nodo-agent binary (like Astra: one file, its own web server).
# Usage: scripts/build-agent.sh [output] [version]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/agent/nodo-agent}"
version="${2:-$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)}"
embed="$root/agent/internal/web/dist"

(cd "$root" && npm run build)

# Keep the committed placeholder out of the way, then restore it so the working tree stays clean.
cp "$embed/index.html" "$root/agent/internal/web/.placeholder.html"
trap 'rm -rf "$embed"/* && mkdir -p "$embed" && mv "$root/agent/internal/web/.placeholder.html" "$embed/index.html"' EXIT
rm -rf "${embed:?}"/*
cp -r "$root/dist/." "$embed/"

(cd "$root/agent" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$out" ./cmd/nodo-agent)
echo "built $out ($version): $(du -h "$out" | cut -f1)"
