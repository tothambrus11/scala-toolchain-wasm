# The compiler fork

The compiler in this distribution is not stock dotty. It is built from
[`univalence-xyz/scala3-on-wasm`](https://github.com/univalence-xyz/scala3-on-wasm), a fork of
dotty that cross-compiles the Scala 3 compiler with Scala.js so it can run in a browser. This
is the single largest thing this project depends on and does not control, so it is worth
knowing what it actually is.

## Who maintains it, and is it going anywhere

The work started as [`pgilliar/scala3-compiler-sjs`](https://github.com/pgilliar/scala3-compiler-sjs)
by Patrick Gilliard (EPFL). Sébastien Doeraene - who leads Scala.js - called its `macro` branch
"a prototype of that... hopefully we will be able to merge it in the coming month or two" in
[the one public thread on browser-hosted dotty](https://contributors.scala-lang.org/t/scala-3-compiler-plugins-embedded-in-browser-with-wasm/7472).
So this is the official effort rather than a side project. It is **not upstream yet**: as of
this writing `scala/scala3` has no `compiler/src-sjs/`, and no PR proposes one. (One piece was
upstreamed on its own - [#25869](https://github.com/scala/scala3/pull/25869), the
type-directed `Constant` construction, in 3.9.0.)

`univalence-xyz/scala3-on-wasm` continues it. Its `main`, `base-sjs-compiler`, `constants`,
`browser` and `macro` branches are **byte-identical SHAs** to Gilliard's - it is a strict
continuation, by Yichen Xu (EPFL LAMP), not a divergence.

## Which branch we pin, and why

| Branch | Owner | What it adds |
| --- | --- | --- |
| `browser` | Gilliard | the browser IDE demo and a JS-only linker bridge |
| `macro` | Gilliard | **quoted macros**, an in-Scala worker, a linker cache |
| `dist` | Xu | structured diagnostics, npm packaging, readable worker errors |
| **`js-3.8.3`** | Xu | **what we pin**: all of the above, ported onto *released* Scala 3.8.3 |

The other branches track dotty's `main`, so they build a nightly (3.8.4-RC1). `js-3.8.3` is
the same stack rebased onto a released compiler, which is what a toolchain other people use
should be built from. Xu maintains `js-3.8.0` through `js-3.8.3` this way, which is a rebase
story the original fork does not have.

## What we get from it that we used to maintain ourselves

Three of our patches went away when we moved to this fork. They are worth listing, because the
lesson is that most of what we invented had already been solved better upstream:

| We had | They have | Why theirs is better |
| --- | --- | --- |
| `CompilerSession.scala` - a `Platform` subclass smuggling a `ClassPath` between `ContextBase` instances | `retainPlatformBetweenRuns` on `ContextBase` | Done from inside the compiler, where it can be correct. Ours risked leaking symbols between runs; theirs does not. |
| A rebuilt `scala-lib.jar`, because upstream staged a `.sjsir`-only one | a jar with `.class` + `.tasty` | It was a plain bug and they fixed it. We now take their jar and assert `scala/Predef.tasty` is in it. |
| `diagnostics.js` - parsing `-- [E007] Type Mismatch Error: file:line:col` back out of terminal output | `compileScala3SjsAsync`, returning diagnostics as data | Severity, code, name, message and a full *range* - ANSI-stripped, never `undefined`. A rendering format nobody agreed to was our most fragile dependency. |

Our remaining compiler-side code is one bridge file. Upstream drives its warm sessions and its
macro relink loop from an in-Scala worker of its own; we drive them from our host, so the
bridge exports what upstream implements and adds nothing.

## How a macro expands in a browser

Worth understanding, because it explains the cost. Expanding a quoted macro means *running*
the macro implementation, and in a browser nothing runs until it is linked. So:

1. The compiler compiles the sources and emits the macro's `.sjsir` like any other class.
2. Reaching the splice, it finds no linked entry point for it, and interrupts itself.
3. The **host** is asked to relink: the compiler's own IR (22 MB, shipped as
   `compiler-sjsir.zip`) plus the macro's, into an ES module.
4. That module - a second, complete compiler with the macro in it - is imported from a blob
   URL, and the compile restarts inside it. Up to eight rounds.

This is why the host arms macro support only for sources that mention `${` or `scala.quoted`:
a program without macros must not pay for a 22 MB fetch and a second linked compiler. It is
also why editing a macro drops the linked module - expanding a *stale* macro would be a wrong
answer that looks like a right one.

Upstream's Node batch harness skips same-run macro tests because it has no linker to relink
with. The browser path, which is ours, does have one; that is the whole point of
`BrowserMacroLinkerRuntime`.

## What macros cost, and one limit worth knowing

Linking a second compiler is not cheap, and the numbers are worth stating plainly:

| | |
| --- | --- |
| first compile of a program that defines a macro | **~70-80 s** |
| the same compile again, macro unchanged | ~0.2 s (the linked compiler is cached by content) |
| any compile of a program with no macros | ~40-300 ms, unaffected |
| extra download, first macro use only | 22 MB (`compiler-sjsir.zip`) |

The host emits a `macros` progress stage before that minute begins, so a UI can say what is
happening instead of appearing to hang. Editing the macro invalidates the linked compiler and
costs the minute again; editing anything else does not.

**A known limit.** In a page that has already run roughly ten compiles, the compile *after* a
macro compile traps with `dereferencing a null pointer` and takes the renderer down with it.
The same sequence from a fresh page - macro compile, then a plain compile, then another -
passes every time, so this needs an accumulation of prior work to appear. The conformance
suite runs its macro cases last for this reason, which keeps the suite green without pretending
the problem is solved; a long editing session that then meets a macro can presumably still hit
it. Unresolved, and worth reporting upstream with a minimal reproduction.
