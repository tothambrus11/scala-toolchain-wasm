# The consumer contract

What a consumer may depend on, and what it must implement. Everything here is stable within a
`schema` version; anything not listed is an implementation detail.

## 1. The manifest

`manifest.json` is the entry point. Every URL in it resolves **relative to the manifest**, so a
distribution can be served from any origin, including a CDN.

```json
{
  "schema": 1,
  "toolchain": {
    "source": "https://github.com/pgilliar/scala3-compiler-sjs",
    "ref": "357051c857d4ffd5d1e1bfc9a56f0cbf5943a325",
    "scalaVersion": "3.8.3-RC3",
    "scalaJSVersion": "1.20.2",
    "buildJdk": "21.0.10",
    "hostVersion": "0.1.0",
    "builtAt": "2026-09-10T15:27:18Z"
  },
  "compilerModule": "./compiler/main.js",
  "runtimeIR": "./runtime/runtime-sjsir.zip",
  "host": "./host/index.js",
  "hostWorker": "./host/worker.js",
  "classpath": [
    { "path": "/lib/rt.jar", "url": "./classpath/rt.jar" },
    { "path": "/lib/scala-lib.jar", "url": "./classpath/scala-lib.jar" },
    { "path": "/lib/scalajs-lib.jar", "url": "./classpath/scalajs-lib.jar" }
  ],
  "compressed": {
    "./compiler/main.wasm": { "url": "./compiler/main.wasm.gz", "encoding": "gzip" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `schema` | contract version; a consumer should refuse a schema it does not know |
| `toolchain` | provenance and versions — surface these, they explain behaviour |
| `compilerModule` | the ES module to `import()` |
| `runtimeIR` | zip of runtime `.sjsir`, fed to the linker alongside the program's IR |
| `host` / `hostWorker` | the runtime shipped with this distribution, so it can never drift from the bundle |
| `classpath[]` | `path` is where the file must appear in the virtual FS; `url` is where to fetch it |
| `compressed` | optional: assets stored compressed, keyed by the URL the bundle will request |

`buildJdk` matters more than it looks: `rt.jar` is extracted from that JDK, so it defines the
Java API surface user code compiles against.

## 2. The compiler module's exports

`import()`ing `compilerModule` yields:

| Export | Signature | Purpose |
| --- | --- | --- |
| `runScala3CompilerSJSAsync(args)` | `Promise<number>` | runs the compiler CLI; returns an exit code |
| `linkScalaJSAsync(irFiles, mainClass)` | `Promise<{jsFileName, code}>` | links to JavaScript; `mainClass.main` runs on import |
| `linkScalaJSModuleAsync(irFiles)` | `Promise<{jsFileName, code}>` | links to JavaScript with no entry point |
| `linkScalaJSWasmAsync(irFiles, mainClass)` | `Promise<{jsFileName, files}>` | links to WebAssembly; returns every emitted file |

`irFiles` are `{ path: string, bytes: Uint8Array }`. `linkScalaJSWasmAsync` comes from this
repository's `src-sjs/`; the others are upstream. A distribution built without our sources will
lack it, so feature-detect (`typeof module.linkScalaJSWasmAsync === "function"`) rather than
assuming.

Diagnostics are **not** returned: the compiler writes them to `console`. The host captures and
parses them (see `host/src/diagnostics.js`). This is the ugliest part of the contract and the
best candidate for an upstream fix.

## 3. The host file system

Before importing the compiler module, the host must set `globalThis.__scala3CompilerSJSHostFS`
to a synchronous, Node-`fs`-shaped object:

```
cwd(), existsSync(path), statSync(path) -> { size, mtimeMs, isFile(), isDirectory() },
readdirSync(path), readFileSync(path) -> Uint8Array, mkdirSync(path, { recursive }),
writeFileSync(path, data), appendFileSync(path, data), rmSync(path, { recursive, force }),
rmdirSync(path, options), unlinkSync(path), truncateSync(path)
```

`host/src/memory-fs.js` is a complete implementation. Note it is a **global**: one worker hosts
exactly one toolchain instance.

## 4. The zip reader

The compiler bundle imports `../vendor/jszip-wrapper.js` *by hard-coded path*, relative to
`compiler/main.js`, and uses a JSZip-shaped object:

```
JSZip.loadAsync(bytes) -> zip
zip.files              -> { [name]: entry }
zip.file(name)         -> entry | null
entry.name, entry.dir, entry.date
entry.async("uint8array") -> Promise<Uint8Array>
```

The distribution ships an implementation at that path, so consumers get this for free — but a
consumer that rearranges the distribution's directory layout will break it.

## 5. Executing linked output

A JavaScript link is one file: wrap it in a blob URL and `import()` it.

A WebAssembly link is three files (`main.js`, `__loader.js`, `main.wasm`) that reference each
other **by relative name**, and the emitted loader resolves the `.wasm` against
`import.meta.url` — meaningless inside a blob module. `host/src/module-loader.js` gives each
supporting file its own blob URL (the wasm typed `application/wasm` so
`WebAssembly.instantiateStreaming` accepts it) and rewrites the entry module's references.

## 6. Runtime requirements

WebAssembly JSPI: `WebAssembly.JSTag`, `WebAssembly.Suspending`, `WebAssembly.promising`.
Chrome/Edge 137+. `host/src/toolchain.js` feature-detects and throws a message naming what is
missing.

No `SharedArrayBuffer` is used, so **no COOP/COEP headers are needed**.

## 7. Versioning

A release is identified by the triple that actually determines behaviour:

```
Scala version  ×  Scala.js version  ×  host runtime version
```

all recorded in `manifest.toolchain`. Release tags are semver over the *distribution*:

- **patch** — rebuild of the same upstream ref (a build fix, a host fix)
- **minor** — new upstream ref, new compiler capability, additive manifest fields
- **major** — a change to anything in this document, including the `schema` bump

Consumers should pin an exact release and read `manifest.toolchain` at runtime rather than
inferring capabilities from a version string.
