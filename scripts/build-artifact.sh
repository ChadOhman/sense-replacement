#!/bin/sh
# Build the self-update artifact. Assumes `pnpm build` already ran (dist/ present,
# including packages/server/dist/version.json). Produces in ./out:
#   sense-<sha7>.tar.gz          repo tree + dist, no node_modules
#   sense-<sha7>.tar.gz.sha256   checksum
#   manifest.json                fixed-name pointer the server polls
# Used by the CI release job and by local end-to-end testing.
set -eu
cd "$(dirname "$0")/.."

VERSION_JSON=packages/server/dist/version.json
[ -f "$VERSION_JSON" ] || { echo "missing $VERSION_JSON — run pnpm build first" >&2; exit 1; }

SHA=$(node -p "JSON.parse(require('fs').readFileSync('$VERSION_JSON','utf8')).sha")
SHORT=$(node -p "JSON.parse(require('fs').readFileSync('$VERSION_JSON','utf8')).shortSha")
BUILT=$(node -p "JSON.parse(require('fs').readFileSync('$VERSION_JSON','utf8')).builtAt")
[ "$SHA" != "dev" ] || { echo "refusing to build an artifact from a dev-sha build" >&2; exit 1; }

rm -rf out && mkdir out
TARBALL="sense-$SHORT.tar.gz"

# Mirror deploy.sh's rsync excludes: ship source + dist, never node_modules,
# data, or env files. COPYFILE_DISABLE stops macOS tar from adding ._* files.
COPYFILE_DISABLE=1 tar -czf "out/$TARBALL" \
  --exclude node_modules --exclude .git --exclude .claude \
  --exclude data --exclude data-solar --exclude coverage \
  --exclude '.env*' --exclude out \
  .

if command -v sha256sum >/dev/null 2>&1; then
  SUM=$(sha256sum "out/$TARBALL" | cut -d' ' -f1)
else
  SUM=$(shasum -a 256 "out/$TARBALL" | cut -d' ' -f1)
fi
echo "$SUM  $TARBALL" > "out/$TARBALL.sha256"

SIZE=$(wc -c < "out/$TARBALL" | tr -d ' ')
cat > out/manifest.json <<EOF
{
  "sha": "$SHA",
  "shortSha": "$SHORT",
  "builtAt": "$BUILT",
  "tarball": "$TARBALL",
  "sha256": "$SUM",
  "sizeBytes": $SIZE
}
EOF
echo "artifact: out/$TARBALL ($SIZE bytes, $SUM)"
