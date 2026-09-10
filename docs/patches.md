# Workarounds this build carries

Every deviation from "check out the fork and run its build", why it exists, and whether it
should stop existing. Read this before changing the build — most of these look removable and
are not.

## 1. The compile-time Scala library must be `.class` + `.tasty`

**Where:** `scripts/build.sh`
**Symptom:** hello-world fails with `Not found: type Unit`, `Not found: println`,
`package scala.compiletime does not have a member method summonFrom`.
**Cause:** the upstream `prepareBrowserIDE` task stages `scala-library-sjs/packageBin` as
`scala-lib.jar`. On a clean build that jar holds only `.sjsir` — Scala.js IR, which is link
input, not a compile-time classpath. The committed demo assets in the fork were produced from
a different build state and *do* contain classfiles, which is why the demo works and a fresh
build does not.
**Fix:** package `compiler/target/scala3-compiler-sjs/node-libs/scala-lib` instead — the merged
library class directory (3,658 `.class` + 941 `.tasty`), which is what the upstream
Node-hosted test already uses. The build hard-fails if `Predef.tasty` is not in it.
**Upstreamable:** yes, and it should be. This is a plain bug.

## 2. JSZip is replaced, not vendored

**Where:** `host/src/jszip-compat.js`, `host/src/zip.js`, staged into `dist/vendor/`
**Cause:** the compiler bundle reads classpath jars through a **hard-coded** import of
`../vendor/jszip-wrapper.js` — the path is baked into the emitted module, so something must
exist there. Upstream puts a 370 KB copy of JSZip in it.
**Fix:** implement the five members the bundle actually uses (`loadAsync`, `files`, `file`,
`entry.async("uint8array")`, `entry.name/dir/date`) over the platform's
`DecompressionStream("deflate-raw")`. Entries inflate lazily, which matters: `rt.jar` is 15 MB
and a program touches a few dozen classes.
**Upstreamable:** partly — better would be for the bundle to accept an injected zip reader
instead of importing one by path.

## 3. The WebAssembly linker bridge is an added source, not a patch

**Where:** `src-sjs/scalawasm/WasmLinkerBridge.scala`
**Cause:** upstream's bridge links user programs to JavaScript only (`ModuleKind.ESModule`,
no Wasm flag), so the compiler is WebAssembly but its output is not.
**Fix:** a second bridge with `withExperimentalUseWebAssembly(true)`, exported as
`linkScalaJSWasmAsync`. It returns **every** emitted file rather than one string, because a
Wasm link produces three files and there is no output directory in a browser.
**Why added, not patched:** `compiler/src-sjs` is already on the upstream source path, so a
copied-in file compiles into the same module and never conflicts when the fork moves. The build
tracks what it injected (`.injected-sources`) so a renamed file does not linger in a reused
checkout.
**Upstreamable:** yes — this is a feature the fork would plausibly want.

## 4. Linked Wasm output needs its references rewritten

**Where:** `host/src/module-loader.js`
**Cause:** the emitted `main.js`, `__loader.js` and `main.wasm` reference each other by
relative name, and the loader resolves the `.wasm` against `import.meta.url`. Inside a blob
module that resolves to nothing useful, so the program cannot be started from memory.
**Fix:** give each supporting file its own blob URL — the wasm typed `application/wasm` so
`WebAssembly.instantiateStreaming` accepts it — and rewrite the entry module's `"./name"`
references before importing it.
**Upstreamable:** no. This is inherent to running linker output without a file system.

## 5. Large assets may be stored compressed

**Where:** `host/src/compressed-assets.js`, `scripts/package-dist.sh`
**Cause:** static hosts cap file size — Cloudflare Pages and Workers both refuse anything over
25 MiB, and `main.wasm` is 31 MB. The usual workaround (upload pre-compressed, declare
`Content-Encoding: gzip`) fails there too: Cloudflare strips that header from `_headers`.
**Fix:** store `main.wasm.gz`, record the substitution in `manifest.compressed`, and install a
narrow `fetch` shim for exactly those URLs that pipes the response through
`DecompressionStream`. Streaming is preserved, so `instantiateStreaming` still compiles as
bytes arrive.
**Upstreamable:** no. It is a hosting constraint, not a compiler one.

## 6. Diagnostics are scraped from `console`

**Where:** `host/src/diagnostics.js`
**Cause:** the compiler has no structured reporter across the Wasm boundary; it prints
`-- [E007] Type Mismatch Error: /workspace/Main.scala:3:18 ...` to `console.log`.
**Fix:** capture `console` around the call and parse the standard Scala 3 diagnostic format
into `{severity, code, file, line, column, message, text}`.
**Upstreamable:** yes, and it is the highest-value one after #1 — a structured reporter would
delete this file and stop the format from being a silent API.

## 7. Errors crossing the Wasm boundary are not always `Error`s

**Where:** `host/src/worker.js`
**Cause:** a thrown value can be an object with a null prototype, where even `String(value)`
throws. When that happened the error reporter itself failed, turning a real compile failure
into a hang.
**Fix:** the error describer tries `message`, then `getMessage()`, then a guarded `String`,
then `JSON.stringify`, then `Object.prototype.toString`.

## 8. Build environment

`SBT_OPTS=-Xmx10G -Xss8m -XX:MaxMetaspaceSize=1G` — dotty needs both the heap and the deep
stack. The compiler is linked with `fastLink`, not `fullLink`: whole-program optimisation would
shrink the 31 MB module noticeably, at a cost in build time. That is a size lever nobody has
pulled yet.

## Not a workaround, but worth knowing

- `rt.jar` is `java.base` extracted from the **build JDK** (`jrt:/`). The JDK used at build time
  silently defines the Java API surface user code compiles against; it is recorded in the
  manifest as `buildJdk`.
- The host file system is a global (`__scala3CompilerSJSHostFS`), so one worker can host
  exactly one toolchain instance. Fine today; awkward once you want a warm compiler and a
  sandboxed re-link side by side.
