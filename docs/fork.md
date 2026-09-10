# The compiler fork

The compiler in this distribution is not stock dotty. It is built from
[`pgilliar/scala3-compiler-sjs`](https://github.com/pgilliar/scala3-compiler-sjs), a fork that
makes the Scala 3 compiler cross-compilable with Scala.js. This is the single largest thing
this project depends on and does not control, so it is worth knowing what it actually changes.

Handily, the fork's `main` branch is a mirror of `scala/scala3`, so its own delta is exactly
`git log origin/main..origin/<branch>`.

## Branches

| Branch | Tip | What it is |
| --- | --- | --- |
| `main` | tracks `scala/scala3` | upstream mirror, no fork changes |
| `base-sjs-compiler` | 2026-04-20 | the compiler cross-compiled, without the browser demo |
| `constants` | 2026-04-20 | a review branch for one piece of the above |
| **`browser`** | 2026-04-15 | **what we pin**: `base-sjs-compiler` plus a browser IDE demo and the linker bridge |
| `macro` | 2026-06-08 | the newest work: macro support, an in-Scala worker, a linker cache. See "Where it is going" |

## What `browser` changes, against dotty

**238 files, +20,976 / −612.** Almost all of it is additive: the fork is careful, and it shows.

### 1. Splitting the compiler by platform

The bulk of the diff is `compiler/src/…` files moving to `compiler/src-jvm/…` — 19 files of the
JVM bytecode backend, plus `dotty.tools.io`, the scripting driver and the sbt bridge. Those are
JVM-only; moving them out lets the Scala.js build compile everything that is left.

Where behaviour must differ rather than disappear, the fork uses a two-branch inline:

```scala
transparent inline def platformDependent[A](inline jvm: A)(inline js: A): A = js
```

`compiler/src-sjs/…/PlatformDependent.scala` returns the JS branch; the JVM build has the
mirror image. Call sites read `platformDependent(realThing)(fallback)`, and the unused branch
never reaches the output. It is the least invasive way to fork a compiler this size, and it is
why the diff is 612 deletions rather than thousands.

### 2. A file system and classpath that do not assume a JVM

`compiler/src-sjs/dotty/tools/io/` reimplements 14 files of dotty's IO layer for the browser:
`AbstractFile`, `Path`, `PlainFile`, `ZipArchive`, `JarArchive`, `ClassPath`, `FileWriters`,
plus `HostFS` and `JSPath`, which are new. `HostFS` is what reaches
`globalThis.__scala3CompilerSJSHostFS` — the contract our host implements. Alongside it,
`compiler/src-sjs/…/dotc/classpath/` reimplements classpath scanning over that file system.

This is the part that makes a browser-hosted compiler possible at all, and the part most
likely to drift from upstream.

### 3. A JS entry point

`compiler/src-sjs/dotty/tools/dotc/`: `MainJS` (exports `runScala3CompilerSJSAsync`),
`JSDriver`, `JSContextBase`, `JSScalacCommand`, and JS-friendly replacements for a handful of
utilities (`WeakHashSet`, `PlatformWeakMap`, a `PushbackReader`). The compiler runs
asynchronously because reading jars in a browser is async — hence the JSPI requirement.

### 4. `interfaces-sjs`

Dotty's `interfaces` module is plain Java. The fork adds a Scala.js twin, `interfaces-sjs`
(8 files), so the Scala.js build has the same API without Java sources.

### 5. Small changes to shared compiler code

About 40 files under `dotc/core`, `dotc/transform`, `dotc/typer`, `dotc/config` and
`dotc/reporting` are modified in place — mostly to route through `platformDependent`, to drop a
reflective call, or to avoid an API Scala.js lacks.

### 6. A browser IDE demo, and the build that feeds it

`compiler/browser-ide/` is a small demo page and worker, and `project/SjsCompilerHelloWorld.scala`
adds the `prepareBrowserIDE` sbt task that assembles the assets we consume. Our build calls
that task and then re-stages its output — see [patches.md](patches.md) for the one place its
output is wrong.

## What this means for us

- **The fork is additive and disciplined**, so our own compiler-side sources drop into
  `compiler/src-sjs/` and compile without patching anything. That is the whole reason this
  project can track it cheaply.
- **The risky surface is the IO and classpath layer.** A dotty change to `AbstractFile` or
  classpath scanning is what would break a rebase, not the backend split.
- **`browser` is not being developed further**; the work moved to `macro`.

## Where it is going: the `macro` branch

`macro` (2026-06-08, two months newer than our pin) is 28 commits on dotty and contains, by its
own commit messages: a macro scanner, `.sjsir` emission and relinking for macros, the browser
worker rewritten *in Scala*, a linker cache, and validation/compilation test suites.

Its exported JS API is different from ours:

| `browser` (pinned) | `macro` |
| --- | --- |
| `runScala3CompilerSJSAsync` | `runScala3CompilerSJSAsync` |
| `linkScalaJSAsync`, `linkScalaJSModuleAsync` | *(now internal to the worker)* |
| — | `startScala3BrowserIDEWorker`, `runScala3SjsMacroSessionAsync` |

It also independently implements much of what this repository adds: its `BrowserLinkerBridge`
now has its own `LinkerSession` built on Scala.js's `IRFileCache`, with `checkIR(false)` and
content-hashed IR versions — the same conclusions our `LinkerSession` reached, via the more
official API — and it enables `withExperimentalUseWebAssembly` for compiler modules.

Moving to it would plausibly buy **macro support**, which is our largest language-level gap,
and let us delete code. It would also mean adopting their worker or reworking our host around
the changed exports. That is a migration, not a version bump — tracked in
[divergence.md](divergence.md).
