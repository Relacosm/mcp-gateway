#!/usr/bin/env bash
# Build our images and load them into the local k3d cluster.
#   scripts/build-images.sh            # all
#   scripts/build-images.sh gateway    # just one
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${TAG:-0.1.0}"
CLUSTER="${CLUSTER:-urumi}"
if [ "$#" -eq 0 ]; then set -- store-wordpress woo-mcp utils-mcp gateway dashboard provisioner; fi
for svc in "$@"; do
  if [ "$svc" = provisioner ]; then
    # Built from the repo root: the image bundles charts/platform.
    docker build -t "urumi/$svc:$TAG" -f services/provisioner/Dockerfile .
  else
    docker build -t "urumi/$svc:$TAG" "services/$svc"
  fi
done
k3d image import -c "$CLUSTER" $(printf "urumi/%s:$TAG " "$@")
