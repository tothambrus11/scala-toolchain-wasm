> **Resolved.** This was not a macro bug. Our linker ran incrementally, and a link whose
> program closure had grown since the previous link corrupted its state; a macro compile
> grows the closure, which is what made it look macro-shaped. Plain hello-world followed by
> a program using `(1 to n).map` reproduces it identically. Fixed by linking in batch mode.
> Kept because the *linker* behaviour is still worth reporting upstream - see below.

# A compile after a macro compile traps, once a page has done enough work

Against `univalence-xyz/scala3-on-wasm` @ `8fdbb99d312de6935bb7482624245caafac27b66`
(`js-3.8.3`), Scala 3.8.3, Scala.js 1.20.2, Chromium 141 headless, JSPI on.

## Symptom

The compile *following* a successful quoted-macro compile fails with

```
dereferencing a null pointer
```

as an uncaught page error, and the renderer goes with it — a Playwright page in that state
reports `Target page, context or browser has been closed`, and a browser tab would need
reloading.

The macro compile itself is fine: it emits every `.sjsir`, exits 0, and the program runs
(`twice=42`, computed by the macro). The failure is in what comes after.

## What it takes to see it

It is **not** a plain macro-then-plain transition. This sequence, from a fresh page, passes
every time, ten runs out of ten:

1. macro compile (`demo.Macros.twice`, a `${ }` splice used from a sibling file) → `twice=42`
2. one-file plain compile → `plain 24`
3. two-file plain compile → `hello, scala`

The trap appears when roughly **ten compiles precede** the macro one in the same page. Our
conformance suite reproduces it reliably by running six edit-cycle compiles plus four other
cases first; moving the macro cases to the end of the suite makes it disappear.

That shape — order-dependent, needs accumulated work, kills the instance rather than
throwing — reads like exhaustion or a dangling reference into a dropped module rather than a
logic error in any one compile. We have not narrowed it further.

## Host side, for what it is worth

Between compiles the host:

- calls `setScala3MacroArtifacts([{ id, macroPackages, root: "/workspace/out" }])` when the
  sources may define a macro, and `setScala3MacroArtifacts([])` when they may not;
- calls `clearRetainedMacroModules()` whenever the set of macro-defining sources changes,
  including changing to none — the same rule `BrowserIDEWorker.retainMacroModulesForCurrentSources`
  applies;
- installs `BrowserMacroLinkerRuntime` once per page, supplying `compilerIRBytes` and
  `compilerIRFiles` as lazy suppliers so the inflated compiler IR is not held between relinks.

Removing that last optimization (holding the inflated IR instead) changes nothing, so it is
not simply the IR retention.

## Reproduction

`tests/conformance.mjs` in `tothambrus11/scala-toolchain-wasm` reproduces it by moving the two
macro cases back above `"compiles several files together, with the standard library"`. The
comment above those cases records why they sit last.
