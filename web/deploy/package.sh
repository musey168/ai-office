#!/usr/bin/env bash
#
# Assembles the deployment package.
#
# The result is a directory with four things and nothing else:
#
#   app/server/server.mjs     the server, one file, no runtime dependencies
#   app/renderers/<app>/     the upstream renderer applications, as browser bundles
#   app/bridges/<app>.js      the IPC bridge, one per app
#   app/worker/               the format engine worker
#
# Nothing here needs a Node installation on the target machine: the server
# runs in a container, and everything the container needs is in this directory.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="${1:-$here/out}"

rm -rf "$out"
mkdir -p "$out/app/server" "$out/app/renderers" "$out/app/bridges" "$out/app/worker"

echo "→ the server"
cp "$repo/web/web-server/dist-server/server.mjs" "$out/app/server/server.mjs"

echo "→ the renderer applications"
for app in docs shell slides sheets pdf markdown html; do
  if [ ! -d "$repo/web/web-server/dist/$app" ]; then
    echo "   missing renderer: $app (build it first)" >&2
    exit 1
  fi
  cp -R "$repo/web/web-server/dist/$app" "$out/app/renderers/$app"
done

echo "→ the bridges"
# The bridge bundles are code-split: the shared chunks live in assets/ and
# the bundles import them by relative path.
cp -R "$repo/web/rpc-bridge/dist/." "$out/app/bridges/"

echo "→ the engine worker"
cp "$repo/web/engine-pool/dist/worker.mjs" "$out/app/worker/worker.mjs"
cp "$repo/web/engine-pool/dist/harfbuzz.wasm" "$out/app/worker/harfbuzz.wasm"

# The bundle is ESM; the marker keeps Node from treating it as CommonJS.
cat > "$out/app/package.json" <<'JSON'
{ "type": "module" }
JSON

echo
echo "package ready: $out"
du -sh "$out"
