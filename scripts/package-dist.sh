#!/usr/bin/env bash
#
# Package `dist/` into release tarballs.
#
# Two variants, because static hosts disagree about large files:
#
#   scala-toolchain-wasm-<version>.tar.gz             the distribution as built
#   scala-toolchain-wasm-<version>-compressed.tar.gz  `main.wasm` stored gzipped
#
# The compressed variant exists for hosts that cap individual files - Cloudflare Pages and
# Workers both refuse anything over 25 MiB, and `main.wasm` is 31 MB. Its manifest records
# the substitution under `compressed`, and the host runtime decompresses in the browser
# while keeping instantiation streaming. See docs/patches.md.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"
RELEASE_DIR="${RELEASE_DIR:-$REPO_ROOT/release}"
VERSION="${VERSION:-$(node -p "require('$REPO_ROOT/host/package.json').version")}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$DIST_DIR/manifest.json" ]] || die "no distribution at $DIST_DIR - run scripts/build.sh"

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

name="scala-toolchain-wasm-$VERSION"

log "Packing $name.tar.gz"
tar -czf "$RELEASE_DIR/$name.tar.gz" -C "$(dirname "$DIST_DIR")" "$(basename "$DIST_DIR")"

log "Packing $name-compressed.tar.gz"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -R "$DIST_DIR" "$staging/dist"
gzip -9 "$staging/dist/compiler/main.wasm"

node - "$staging/dist/manifest.json" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const path = process.argv[2];
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.compressed = {
  "./compiler/main.wasm": { url: "./compiler/main.wasm.gz", encoding: "gzip" },
};
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

tar -czf "$RELEASE_DIR/$name-compressed.tar.gz" -C "$staging" dist

(cd "$RELEASE_DIR" && sha256sum ./*.tar.gz > SHA256SUMS)

log "Release artifacts in $RELEASE_DIR"
ls -la "$RELEASE_DIR" | awk 'NR>3 { printf "  %8.1f MiB  %s\n", $5/1048576, $9 }'
cat "$RELEASE_DIR/SHA256SUMS"
