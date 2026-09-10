#!/usr/bin/env bash
#
# Build the Scala WebAssembly toolchain distribution.
#
# Cross-compiles the Scala 3 compiler with Scala.js, links it to WasmGC together with the
# Scala.js linker, and stages everything a browser needs to compile and run Scala:
#
#   dist/
#     manifest.json                describes this distribution
#     compiler/main.wasm           the compiler AND the linker, one WasmGC module
#     compiler/main.js             Scala.js glue
#     compiler/__loader.js         instantiates the module
#     classpath/rt.jar             java.base from the build JDK
#     classpath/scala-lib.jar      Scala 3 library (.class + .tasty)
#     classpath/scalajs-lib.jar    Scala.js library
#     runtime/runtime-sjsir.zip    runtime IR, linked with the user's program
#     vendor/jszip-wrapper.js      the zip reader the compiler bundle imports
#     host/*.js                    the browser runtime that drives all of the above
#
# Usage:
#   scripts/build.sh                       # build (reuses the cached checkout)
#   UPSTREAM_REF=<sha> scripts/build.sh
#   CHECKOUT_DIR=... SKIP_BUILD=1 scripts/build.sh    # restage from an existing build
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/pgilliar/scala3-compiler-sjs}"
UPSTREAM_REF="${UPSTREAM_REF:-357051c857d4ffd5d1e1bfc9a56f0cbf5943a325}"
CACHE_DIR="${CACHE_DIR:-$REPO_ROOT/.cache}"
CHECKOUT_DIR="${CHECKOUT_DIR:-$CACHE_DIR/scala3-compiler-sjs}"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"
SBT_OPTS="${SBT_OPTS:--Xmx10G -Xss8m -XX:MaxMetaspaceSize=1G}"
export SBT_OPTS

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

for tool in git java npm node jar; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  command -v sbt >/dev/null 2>&1 || die "missing sbt (https://www.scala-sbt.org/download)"

  log "Upstream: $UPSTREAM_URL @ ${UPSTREAM_REF:0:12}"
  if [[ ! -d "$CHECKOUT_DIR/.git" ]]; then
    mkdir -p "$(dirname "$CHECKOUT_DIR")"
    log "Cloning (blobless; the full dotty history is large)"
    git clone --filter=blob:none "$UPSTREAM_URL" "$CHECKOUT_DIR"
  fi

  git -C "$CHECKOUT_DIR" fetch --filter=blob:none origin "$UPSTREAM_REF" 2>/dev/null ||
    git -C "$CHECKOUT_DIR" fetch --filter=blob:none origin
  git -C "$CHECKOUT_DIR" checkout --detach "$UPSTREAM_REF"

  # Our compiler-side sources are copied in, never patched: `src-sjs` is already on the
  # upstream source path, so they compile into the same Wasm module and nothing conflicts
  # when the fork moves forward. Track what we injected so a renamed or deleted source does
  # not linger in a reused checkout and collide with its replacement.
  log "Adding our compiler-side sources"
  injected="$CHECKOUT_DIR/.injected-sources"
  [[ -f "$injected" ]] && xargs -r -a "$injected" rm -rf
  (cd "$REPO_ROOT/src-sjs" && find . -mindepth 1 -maxdepth 1 -printf '%P\n') |
    sed "s|^|$CHECKOUT_DIR/compiler/src-sjs/|" > "$injected"
  cp -R "$REPO_ROOT/src-sjs/." "$CHECKOUT_DIR/compiler/src-sjs/"

  log "Installing the upstream build's Node dependency"
  (cd "$CHECKOUT_DIR/compiler" && npm install --silent)

  log "Building - 8 to 16 minutes depending on cache warmth"
  (cd "$CHECKOUT_DIR" && sbt -batch "scala3-compiler-sjs/prepareBrowserIDE")
fi

UPSTREAM_ASSETS="$CHECKOUT_DIR/compiler/browser-ide/assets"
TARGET_DIR="$CHECKOUT_DIR/compiler/target/scala3-compiler-sjs"
[[ -f "$UPSTREAM_ASSETS/compiler/main.wasm" ]] || die "no main.wasm - the build did not complete"

log "Staging $DIST_DIR"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"/{compiler,classpath,runtime,vendor,host}

cp "$UPSTREAM_ASSETS"/compiler/{main.wasm,main.js,__loader.js} "$DIST_DIR/compiler/"
cp "$UPSTREAM_ASSETS"/classpath/rt.jar "$UPSTREAM_ASSETS"/classpath/scalajs-lib.jar "$DIST_DIR/classpath/"
cp "$UPSTREAM_ASSETS"/runtime/runtime-sjsir.zip "$DIST_DIR/runtime/"

# The compile-time Scala library must be `.class` + `.tasty`. Upstream stages
# `scala-library-sjs/packageBin`, which on a clean build holds only Scala.js IR (`.sjsir`);
# a compiler given that jar cannot resolve `scala.Predef` and fails with
# "Not found: type Unit" on hello-world. Package the merged library class directory instead,
# the same one the upstream Node-hosted test uses. See docs/patches.md.
SCALA_LIB_CLASSES="$TARGET_DIR/node-libs/scala-lib"
[[ -d "$SCALA_LIB_CLASSES" ]] || die "missing $SCALA_LIB_CLASSES"
[[ -n "$(find "$SCALA_LIB_CLASSES" -name 'Predef.tasty' -print -quit)" ]] ||
  die "$SCALA_LIB_CLASSES has no Predef.tasty - it is not a Scala 3 compile-time library"
jar --create --file "$DIST_DIR/classpath/scala-lib.jar" -C "$SCALA_LIB_CLASSES" .

# The compiler bundle reads classpath jars through a hard-coded `../vendor/jszip-wrapper.js`
# import. Upstream satisfies it with a 370 KB copy of JSZip; we satisfy it with our own
# reader over the platform's DecompressionStream, which also makes entry reads lazy.
cp "$REPO_ROOT/host/src/jszip-compat.js" "$REPO_ROOT/host/src/zip.js" "$DIST_DIR/vendor/"
cat > "$DIST_DIR/vendor/jszip-wrapper.js" <<'WRAPPER'
// Generated by scripts/build.sh - see host/src/jszip-compat.js
export { default } from "./jszip-compat.js";
WRAPPER

# The host runtime ships inside the distribution so a consumer needs exactly one download,
# and so the runtime can never drift from the bundle whose contracts it implements. (It is
# also published to npm for consumers who prefer that.)
cp "$REPO_ROOT/host/src"/*.js "$DIST_DIR/host/"

# Version metadata: what a consumer needs to know about this distribution.
scala_version=$(basename "$(ls -d "$CHECKOUT_DIR"/compiler/target/scala3-compiler-nonbootstrapped/scala-* 2>/dev/null | head -1)" 2>/dev/null || echo "scala-unknown")
scala_version=${scala_version#scala-}
scalajs_version=$(grep -oE 'sbt-scalajs" % "[^"]+"' "$CHECKOUT_DIR/project/plugins.sbt" 2>/dev/null | grep -oE '[0-9][^"]*' | head -1 || true)
jdk_version=$(java -version 2>&1 | head -1 | grep -oE '"[^"]+"' | tr -d '"' || echo unknown)
host_version=$(node -p "require('$REPO_ROOT/host/package.json').version")

node - "$DIST_DIR/manifest.json" <<NODE
const { writeFileSync } = require("node:fs");
writeFileSync(process.argv[2], JSON.stringify({
  schema: 1,
  toolchain: {
    source: "$UPSTREAM_URL",
    ref: "$UPSTREAM_REF",
    scalaVersion: "$scala_version",
    scalaJSVersion: "${scalajs_version:-unknown}",
    buildJdk: "$jdk_version",
    hostVersion: "$host_version",
    builtAt: new Date().toISOString(),
  },
  compilerModule: "./compiler/main.js",
  runtimeIR: "./runtime/runtime-sjsir.zip",
  host: "./host/index.js",
  hostWorker: "./host/worker.js",
  classpath: [
    { path: "/lib/rt.jar", url: "./classpath/rt.jar" },
    { path: "/lib/scala-lib.jar", url: "./classpath/scala-lib.jar" },
    { path: "/lib/scalajs-lib.jar", url: "./classpath/scalajs-lib.jar" },
  ],
}, null, 2) + "\n");
NODE

log "Built $(node -p "require('$DIST_DIR/manifest.json').toolchain.scalaVersion") toolchain"
du -ch "$DIST_DIR"/compiler/* "$DIST_DIR"/classpath/* "$DIST_DIR"/runtime/* | sort -h | tail -8
