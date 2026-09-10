# scala-toolchain-wasm

The Scala 3 compiler and the Scala.js linker, compiled to WebAssembly, packaged so a browser
can compile and run Scala with no server involved.

```
Scala source ──▶ scalac (WasmGC) ──▶ .sjsir ──▶ Scala.js linker (WasmGC) ──▶ JS or Wasm ──▶ run
                 ╰──────────────── one 31 MB module, in a Web Worker ────────────────╯
```

This repository builds and releases that toolchain. It knows nothing about editors or UI —
it produces a versioned distribution plus the small JavaScript runtime needed to drive it.
[yukibana-scala](https://github.com/tothambrus11/yukibana-scala) is one consumer.

## What a release contains

| Artifact | Use |
| --- | --- |
| `scala-toolchain-wasm-<version>.tar.gz` | the distribution as built (~62 MB unpacked) |
| `scala-toolchain-wasm-<version>-compressed.tar.gz` | `main.wasm` stored gzipped, for hosts that cap files at 25 MiB (Cloudflare Pages/Workers) |
| `SHA256SUMS` | checksums |
| npm `scala-toolchain-wasm` | the host runtime, if published |

Unpacked, a distribution is:

```
dist/
  manifest.json              what this build is: Scala version, Scala.js version, JDK, upstream ref
  compiler/main.wasm         the compiler AND the linker, one WasmGC module
  compiler/main.js           Scala.js glue
  compiler/__loader.js       instantiates the module
  classpath/rt.jar           java.base from the build JDK
  classpath/scala-lib.jar    Scala 3 library (.class + .tasty)
  classpath/scalajs-lib.jar  Scala.js library
  runtime/runtime-sjsir.zip  runtime IR, linked with the user's program
  vendor/*.js                the zip reader the compiler bundle imports
  host/*.js                  the browser runtime that drives all of the above
```

## Using it

```js
import { ScalaEngine } from "scala-toolchain-wasm";

const engine = new ScalaEngine({
  workerUrl: new URL("./scala-toolchain-wasm/worker.js", import.meta.url),
  manifestUrl: "/toolchain/manifest.json",
});
await engine.init();

const result = await engine.run(
  { "Main.scala": '@main def hello(): Unit = println("hi")' },
  { target: "wasm" },          // or "js"
);
console.log(result.output, result.diagnostics);
```

The engine loads nothing until you call `init()`, and the manifest may live on another origin
(a CDN or R2 bucket) — URLs inside it resolve relative to the manifest.

Call `engine.warmUp()` after `init()`. The first compile of a session scans the classpath and
the first link parses the runtime IR; doing that in the background turns a user's first
edit-run from several seconds into the steady-state figures below.

## Speed

Measured in headless Chromium on a 4-core container (`node tests/profile.mjs`):

| | first in a session | steady state |
| --- | --- | --- |
| compile | ~1.1 s (+~3 s classpath scan) | **~0.6 s** |
| link | ~5.7 s | **~0.15 s** |
| run | — | ~20 ms |

Before this repository's compiler-side sources, the same numbers were ~6.5 s per compile and
~2 s per link, on *every* edit — the classpath was re-scanned and the runtime IR re-marshalled
each time. See [docs/patches.md](docs/patches.md).

Browsers need WebAssembly JSPI: Chrome/Edge 137+. Unsupported engines get an error naming the
missing features rather than a broken page.

## Building it yourself

```bash
npm install
scripts/build.sh          # 8-16 minutes; needs JDK 21, sbt, Node 20+
npm test                  # conformance tests in headless Chromium
scripts/package-dist.sh   # release tarballs
```

The build clones a pinned commit of [`pgilliar/scala3-compiler-sjs`](https://github.com/pgilliar/scala3-compiler-sjs)
— a fork of dotty cross-compiled with Scala.js — copies this repository's `src-sjs/` into it,
runs the sbt build, and stages the result. Our Scala sources are *added*, never patched, so
the fork can move forward without merge conflicts.

## Layout

| Path | What |
| --- | --- |
| `src-sjs/` | Scala compiled **into** the toolchain (today: the WebAssembly linker bridge) |
| `host/` | the browser runtime: virtual FS, zip reader, worker protocol, diagnostics |
| `scripts/` | build, packaging, static server |
| `tests/` | conformance tests — does this distribution actually work in a browser |
| `docs/` | the consumer contract, the workarounds, how to release |

## Documentation

- [docs/contract.md](docs/contract.md) — manifest schema, module exports, host interfaces, versioning
- [docs/patches.md](docs/patches.md) — every workaround this build carries, and why
- [docs/divergence.md](docs/divergence.md) — what we maintain, what should go upstream, what to adopt
- [docs/releasing.md](docs/releasing.md) — cutting a release, bumping the upstream pin

## Known limitations

- **Macros are unsupported** by the underlying compiler build. This is the biggest gap.
- **No language server** yet; the presentation compiler exists upstream and is the next step.
- **JSPI-only**, so Chrome/Edge 137+ for now.
- The compiler is `fastLink`-ed, not `fullLink`-ed — the module is larger than it needs to be.
