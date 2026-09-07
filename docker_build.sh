#!/usr/bin/env bash
# Build the image and push it to the Gitea registry.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="gitea.gitpal.ru/alex/webmusicmo"
VERSION="$(node -p "require('./package.json').version")"
docker build -t "$IMAGE:$VERSION" -t "$IMAGE:latest" .
docker push "$IMAGE:$VERSION"
docker push "$IMAGE:latest"
