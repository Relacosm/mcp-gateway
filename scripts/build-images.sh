#!/usr/bin/env bash
# Build our service images and load them into the local k3d cluster.
#   scripts/build-images.sh            # all
#   scripts/build-images.sh gateway    # just one
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${TAG:-0.1.0}"
CLUSTER="${CLUSTER:-urumi}"
if [ "$#" -eq 0 ]; then set -- woo-mcp utils-mcp gateway dashboard; fi
for svc in "$@"; do
  docker build -t "urumi/$svc:$TAG" "services/$svc"
done
k3d image import -c "$CLUSTER" $(printf "urumi/%s:$TAG " "$@")
