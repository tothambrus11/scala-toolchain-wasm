# What we maintain, and why

Everything this project keeps that upstream does not, with a disposition for each: **upstream**
it, **adopt** something that already exists, or **maintain** it deliberately. Revisit this
document whenever the pinned fork moves.

## The one that matters most

The real dependency is not any file here — it is
[`pgilliar/scala3-compiler-sjs`](https://github.com/pgilliar/scala3-compiler-sjs), a **research
fork of dotty** that cross-compiles the compiler with Scala.js. Everything else in this
repository is small; that is not. If the fork stops tracking dotty, this project is pinned to
an ageing Scala.

Three ways out, in order of preference:

1. **Upstream the Scala.js-hosted compiler into dotty.** The right long-term answer, and not
   ours alone to make — but the fork's changes are the kind Scala 3 could absorb (a JS driver,
   a platform-independent classpath layer).
2. **Take over maintenance of the fork** — rebasing dotty ourselves. Feasible, not cheap: the
   fork touches the classpath, the backend and the reporter.
3. **Stay pinned** and upgrade deliberately. What we do today. The conformance suite is what
   makes an upgrade a decision rather than a gamble.

Meanwhile, everything below is written so the fork can move without conflicts: our compiler-side
code is *added* to its source path, never patched.

## Compiler-side (Scala)

| What | Disposition | Notes |
| --- | --- | --- |
| `src-sjs/scalawasm/CompilerSession.scala` | **Upstream** | Caches the classpath index between compiles: ~6.5 s → ~0.6 s per compile. Nothing about it is specific to us; any browser host of this compiler wants it. |
| `src-sjs/scalawasm/LinkerSession.scala` | **Upstream** | Persistent, incremental linker plus a one-time runtime-IR handoff: ~2 s → ~0.15 s per link. Supersedes the fork's `BrowserLinkerBridge`, and adds the WebAssembly target it lacks. |
| ~~`WasmLinkerBridge.scala`~~ | **Deleted** | `LinkerSession` covers both targets; keeping a second linking path was pure overhead. |
| The `scala-lib.jar` staging fix in `scripts/build.sh` | **Upstream (bug)** | `prepareBrowserIDE` stages a `.sjsir`-only jar as the compile-time classpath, so a clean build cannot resolve `scala.Predef`. This is a plain bug and the highest-value thing to send back. |

If all four landed upstream, `src-sjs/` would be empty and `build.sh` would be a download and a
staging step.

## Host-side (JavaScript)

| What | Disposition | Notes |
| --- | --- | --- |
| `host/src/diagnostics.js` | **Upstream, then delete** | Parses the compiler's console output because there is no structured reporter across the Wasm boundary. The format is a de-facto API nobody agreed to; a reporter that returns `{severity, file, line, column, message}` would delete this file. Highest-fragility item we own. |
| `host/src/memory-fs.js` | **Maintain** | Implements the compiler's host-FS contract (12 sync methods). [`memfs`](https://github.com/streamich/memfs) solves this generally, but we would still wrap it for `cwd()` and byte semantics, and it is ~200 KB against 240 lines. Revisit if the file-system surface grows into a real project model. |
| `host/src/zip.js`, `jszip-compat.js` | **Maintain** | The compiler bundle imports a JSZip-shaped object *by hard-coded path*. Upstream should accept an injected reader instead — worth proposing. Until then ours is ~190 lines over `DecompressionStream`, versus 370 KB of vendored JSZip, and it inflates entries lazily (`rt.jar` is 15 MB). |
| `host/src/module-loader.js` | **Maintain** | Rewrites the linker's relative references to blob URLs so output can run from memory. Scala.js could offer "instantiate from memory" upstream, but this is genuinely host-specific. |
| `host/src/compressed-assets.js` | **Maintain (hosting)** | Exists only because static hosts cap files at 25 MiB and Cloudflare strips `Content-Encoding`. Delete it the day the toolchain is served from object storage without that cap. |
| `host/src/worker.js`, `client.js` | **Maintain** | Ordinary application plumbing. |

## Consumer-side (yukibana-scala)

| What | Disposition | Notes |
| --- | --- | --- |
| Monarch grammar for Scala | **Adopt, eventually** | [`scala-lang/vscode-scala-syntax`](https://github.com/scala-lang/vscode-scala-syntax) is the real grammar. Browser-only Theia has no plugin host, so using it means wiring TextMate + oniguruma into Monaco. Ours is ~140 lines and good enough until someone complains about highlighting. |
| `scripts/fetch-toolchain.sh` | **Simplify later** | Once the host runtime is on npm, this shrinks to fetching the distribution only. |
| `scripts/dev-server.mjs` | **Maintain** | `sirv`/`http-server` exist, but neither gzips on the fly *and* serves `application/wasm` without configuration. ~110 lines, no dependency. |
| Run/compile commands, diagnostics wiring, workspace seeding | **Maintain** | This is the product. |

## Already solved, deliberately not adopted

- **Incremental compilation via Zinc/Bloop.** Both assume a JVM and a real file system. Our
  equivalent — a warm classpath and an incremental linker — is a fraction of the machinery and
  fits the browser.
- **Scastie / ScalaFiddle** solve "Scala in a browser" by compiling on a server. That is the
  approach this project exists to avoid.
- **A language server (Metals).** The right answer for completion and hover, and it needs the
  presentation compiler running in the browser. That is the next big piece of work, and it
  belongs upstream in the fork rather than here.

## Sending work upstream

The three Scala files are self-contained and depend only on public dotty and Scala.js APIs, so
they port to the fork as-is. The build fix is a one-line change to `prepareBrowserIDE`. See
[patches.md](patches.md) for the reasoning behind each, which is what a maintainer will ask for.
