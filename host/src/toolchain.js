import { VirtualFileSystem } from "./memory-fs.js";
import { installCompressedAssetFetch } from "./compressed-assets.js";
import { readZipEntries } from "./zip.js";
import { parseDiagnostics } from "./diagnostics.js";

const WORKSPACE_DIR = "/workspace";
const OUTPUT_DIR = "/workspace/out";
const RUNTIME_IR_DIR = "/runtime";

/**
 * The in-browser Scala toolchain: a WebAssembly build of the Scala 3 compiler that also
 * embeds the Scala.js linker.
 *
 * Two things form the contract with the compiler bundle:
 *   - `globalThis.__scala3CompilerSJSHostFS` - the file system it reads and writes
 *   - the module exports `runScala3CompilerSJSAsync` / `linkScalaJSAsync`
 *
 * The compiler reports diagnostics through `console`, so calls are wrapped in a capture.
 */
export class ScalaToolchain {
  #compilerModule;
  #manifest;
  #runtimeIR = null;
  #runtimeIRShared = false;
  #stateless = false;
  // The compiler owns one virtual workspace, so compiles must not overlap - a background
  // warm-up would otherwise clear the directory a user's compile is reading.
  #queue = Promise.resolve();

  constructor({ compilerModule, manifest, fs, stateless = false }) {
    this.#compilerModule = compilerModule;
    this.#manifest = manifest;
    this.fs = fs;
    // Escape hatch: force the stateless entry point, for A/B measurement or if a warm
    // session is ever suspected of returning stale results.
    this.#stateless = stateless;
  }

  /**
   * @param {object} options
   * @param {string} [options.manifestUrl] location of the toolchain manifest
   * @param {(stage: string, detail?: object) => void} [options.onProgress]
   */
  static async load({ manifestUrl = "./assets/manifest.json", onProgress = () => {}, stateless = false } = {}) {
    const missing = missingWasmFeatures();
    if (missing.length > 0) throw new UnsupportedRuntimeError(missing);

    onProgress("manifest");
    const manifest = await fetchJSON(manifestUrl);
    const resolve = (url) => new URL(url, new URL(manifestUrl, self.location.href)).href;

    const fs = new VirtualFileSystem();
    globalThis.__scala3CompilerSJSHostFS = fs.hostFS;

    onProgress("classpath", { entries: manifest.classpath.length });
    await Promise.all(
      manifest.classpath.map(async (entry) => {
        fs.writeBytes(entry.path, await fetchBytes(resolve(entry.url)));
      }),
    );

    // A deploy build may store large assets compressed; the compiler bundle asks for the
    // uncompressed names, so redirect those fetches before importing it.
    if (manifest.compressed) {
      installCompressedAssetFetch(manifest.compressed, resolve);
    }

    onProgress("compiler");
    const compilerModule = await import(resolve(manifest.compilerModule));

    const toolchain = new ScalaToolchain({ compilerModule, manifest, fs, stateless });
    toolchain.runtimeIRUrl = resolve(manifest.runtimeIR);
    onProgress("ready");
    return toolchain;
  }

  get classpath() {
    return this.#manifest.classpath.map((entry) => entry.path).join(":");
  }

  /**
   * Compile a set of sources to Scala.js IR.
   *
   * @param {Record<string, string>} files path (relative to the workspace) -> source text
   * @param {{options?: string[]}} [config] extra scalac options
   */
  compile(files, config = {}) {
    return this.#serialize(() => this.#compile(files, config));
  }

  async #compile(files, { options = [] } = {}) {
    const fs = this.fs;
    fs.removeTree(WORKSPACE_DIR);
    fs.mkdirp(OUTPUT_DIR);

    const sourcePaths = Object.entries(files).map(([name, source]) => {
      const path = name.startsWith("/") ? name : `${WORKSPACE_DIR}/${name}`;
      fs.writeText(path, source);
      return path;
    });
    if (sourcePaths.length === 0) throw new Error("No sources to compile");

    const args = ["-classpath", this.classpath, "-d", OUTPUT_DIR, ...options, ...sourcePaths];
    const started = now();
    const { result: exitCode, lines } = await captureConsole(() => this.#runCompiler(args));

    const { diagnostics, errorCount, warningCount } = parseDiagnostics(lines);
    const irFiles = exitCode === 0
      ? fs.listFiles(OUTPUT_DIR)
          .filter((path) => path.endsWith(".sjsir"))
          .map((path) => ({ path, bytes: fs.readBytes(path) }))
      : [];

    return {
      ok: exitCode === 0,
      exitCode,
      diagnostics,
      errorCount,
      warningCount,
      output: lines.join("\n"),
      irFiles,
      entryPoints: findEntryPoints(irFiles.map((file) => file.path)),
      durationMs: now() - started,
    };
  }

  /**
   * Run the compiler, preferring the entry point that keeps its classpath and symbol table
   * between compiles. Building a fresh compiler each time costs seconds - it re-scans a
   * 15 MB `rt.jar` and reloads the standard library - so the warm one is used whenever the
   * distribution provides it.
   */
  #runCompiler(args) {
    if (!this.#stateless && typeof this.#compilerModule.runScala3CompilerSessionAsync === "function") {
      return this.#compilerModule.runScala3CompilerSessionAsync(args);
    }
    return this.#compilerModule.runScala3CompilerSJSAsync(args);
  }

  /** Run work one at a time, in the order it arrived. */
  #serialize(work) {
    const result = this.#queue.then(work, work);
    // Keep the chain alive even when a caller's work rejects.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Compile and link a throwaway program so the user's first one does not pay for it.
   *
   * The first compile of a session scans a 15 MB classpath and the first link parses the
   * runtime IR: together several seconds, all of it one-off. Doing it in the background right
   * after loading turns a first edit-run from ~8 s into the steady-state ~0.7 s.
   */
  async warmUp({ target = "js" } = {}) {
    const started = now();
    const compilation = await this.compile({
      "__Warmup.scala": "object __Warmup:\n  def main(args: Array[String]): Unit = println(\"\")\n",
    });
    if (compilation.ok) {
      await this.link(compilation.irFiles, { mainClass: "__Warmup", target });
    }
    return { ok: compilation.ok, durationMs: now() - started };
  }

  /** Whether this toolchain links incrementally between runs. */
  get incrementalLinking() {
    return typeof this.#compilerModule.linkScalaJSSessionAsync === "function";
  }

  /** Whether this toolchain keeps compiler state between compiles. */
  get warmCompiles() {
    return !this.#stateless && typeof this.#compilerModule.runScala3CompilerSessionAsync === "function";
  }

  /**
   * Drop the cached classpath and symbols. The next compile starts cold, which is what you
   * want if the classpath changes - or to rule the cache out when diagnosing odd diagnostics.
   */
  resetSession() {
    this.#compilerModule.resetScala3CompilerSession?.();
  }

  /** Lazily fetch and inflate the runtime `.sjsir` needed at link time. */
  async #runtimeIRFiles() {
    if (!this.#runtimeIR) {
      this.#runtimeIR = (async () => {
        const bytes = await fetchBytes(this.runtimeIRUrl);
        const entries = await readZipEntries(bytes, (name) => name.endsWith(".sjsir"));
        return entries
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((entry) => ({ path: `${RUNTIME_IR_DIR}/${entry.name}`, bytes: entry.bytes }));
      })();
    }
    return this.#runtimeIR;
  }

  /** Whether this toolchain build can link user programs to WebAssembly. */
  get supportsWasmTarget() {
    return typeof this.#compilerModule.linkScalaJSSessionAsync === "function";
  }

  /**
   * Link IR to an executable ES module.
   *
   * @param {Array<{path: string, bytes: Uint8Array}>} irFiles program IR (runtime IR is added)
   * @param {{mainClass?: string|null, target?: "js"|"wasm"}} [config]
   *   `mainClass` makes the module run `mainClass.main` on import; `target` selects the
   *   linker backend, so the user's program can be WebAssembly like the compiler itself.
   */
  link(irFiles, config = {}) {
    return this.#serialize(() => this.#link(irFiles, config));
  }

  async #link(irFiles, { mainClass = null, target = "js" } = {}) {
    if (target === "wasm" && !this.supportsWasmTarget) {
      throw new Error(
        "This toolchain build cannot link to WebAssembly: it has no linkScalaJSSessionAsync export. Rebuild it from scala-toolchain-wasm.",
      );
    }

    const started = now();
    const incremental = typeof this.#compilerModule.linkScalaJSSessionAsync === "function";

    // With a session, the runtime IR crosses the boundary once per page, not once per link.
    let allIR = irFiles;
    if (incremental) {
      if (!this.#runtimeIRShared) {
        this.#compilerModule.setScalaJSRuntimeIR(await this.#runtimeIRFiles());
        this.#runtimeIRShared = true;
      }
    } else {
      allIR = (await this.#runtimeIRFiles()).concat(irFiles);
    }

    const { result, lines } = await captureConsole(() => {
      // The incremental linker keeps its state between links, so a re-run does not re-parse
      // 15 MB of runtime IR. It returns every emitted file for both targets.
      if (incremental) {
        return this.#compilerModule.linkScalaJSSessionAsync(allIR, mainClass ?? "", target);
      }
      // Fallback: a distribution built without this repository's sources only has the
      // upstream JavaScript bridges.
      if (target === "wasm") {
        throw new Error(
          "This toolchain cannot link to WebAssembly: it was built without scala-toolchain-wasm's compiler-side sources.",
        );
      }
      return mainClass
        ? this.#compilerModule.linkScalaJSAsync(allIR, mainClass)
        : this.#compilerModule.linkScalaJSModuleAsync(allIR);
    });

    const files = result.files
      ? [...result.files].map((file) => ({ name: file.name, bytes: file.bytes }))
      : null;
    const entry = files?.find((file) => file.name === result.jsFileName);

    return {
      target,
      incremental,
      jsFileName: result.jsFileName,
      // JavaScript output is consumed as source; WebAssembly as a set of files.
      code: target === "wasm" ? null : (result.code ?? (entry ? new TextDecoder().decode(entry.bytes) : null)),
      files: target === "wasm" ? files : null,
      output: lines.join("\n"),
      durationMs: now() - started,
    };
  }

  /** Compile and link in one step, picking an entry point when the caller did not. */
  async build(files, { mainClass = null, options = [], target = "js" } = {}) {
    const compilation = await this.compile(files, { options });
    if (!compilation.ok) return { ok: false, compilation, link: null, mainClass: null };

    let selected = mainClass;
    if (!selected) {
      const selection = selectEntryPoint(compilation.entryPoints);
      if (!selection.ok) {
        return { ok: false, compilation, link: null, mainClass: null, error: selection.error };
      }
      selected = selection.mainClass;
    }

    const link = await this.link(compilation.irFiles, { mainClass: selected, target });
    return { ok: true, compilation, link, mainClass: selected };
  }
}

export class UnsupportedRuntimeError extends Error {
  constructor(missing) {
    super(
      [
        "This browser cannot run the Scala toolchain.",
        "",
        `Missing WebAssembly features: ${missing.join(", ")}.`,
        "",
        "The compiler is built with the Scala.js WebAssembly backend and uses JSPI.",
        "Chrome/Edge 137+ support it; other engines may need a flag.",
      ].join("\n"),
    );
    this.name = "UnsupportedRuntimeError";
    this.missing = missing;
  }
}

export function missingWasmFeatures() {
  const wasm = globalThis.WebAssembly;
  if (!wasm || typeof wasm !== "object") return ["WebAssembly"];

  const missing = [];
  if (typeof wasm.JSTag === "undefined") missing.push("WebAssembly.JSTag");
  if (typeof wasm.Suspending !== "function") missing.push("WebAssembly.Suspending");
  if (typeof wasm.promising !== "function") missing.push("WebAssembly.promising");
  return missing;
}

/**
 * Derive runnable entry points from emitted IR file names.
 *
 * `object Main` emits `Main.sjsir` and `Main$.sjsir`; a top-level `@main def hello` emits
 * only `hello.sjsir`. Either way the name to hand the linker is the one without the `$`.
 */
export function findEntryPoints(irPaths) {
  const names = irPaths
    .map((path) => {
      const marker = path.lastIndexOf("/out/");
      const relative = marker >= 0 ? path.slice(marker + 5) : path.replace(/^\//, "");
      return relative.slice(0, -".sjsir".length);
    })
    .filter((name) => name.length > 0);
  const emitted = new Set(names);

  return [...new Set(names.filter((name) => !name.includes("$")))]
    .map((name) => ({
      mainClass: name.replace(/\//g, "."),
      kind: emitted.has(`${name}$`) ? "object" : "topLevelMain",
    }))
    .sort((left, right) => {
      const leftIsMain = left.mainClass === "Main" || left.mainClass.endsWith(".Main");
      const rightIsMain = right.mainClass === "Main" || right.mainClass.endsWith(".Main");
      if (leftIsMain !== rightIsMain) return leftIsMain ? -1 : 1;
      return left.mainClass.localeCompare(right.mainClass);
    });
}

export function selectEntryPoint(entryPoints) {
  if (entryPoints.length === 0) {
    return {
      ok: false,
      error:
        "No runnable entry point found. Define `object Main` with `def main(args: Array[String]): Unit`, or a top-level `@main` method.",
    };
  }

  const main = entryPoints.find(
    (entry) => entry.mainClass === "Main" || entry.mainClass.endsWith(".Main"),
  );
  const chosen = main ?? (entryPoints.length === 1 ? entryPoints[0] : null);
  if (!chosen) {
    return {
      ok: false,
      error: [
        "Multiple runnable entry points found; name one `Main` or pass one explicitly:",
        ...entryPoints.map((entry) => `- ${entry.mainClass}`),
      ].join("\n"),
    };
  }

  return { ok: true, mainClass: chosen.mainClass, kind: chosen.kind };
}

/** The compiler and the linker report through `console`; collect that into an array. */
export async function captureConsole(run) {
  const lines = [];
  const target = globalThis.console ?? {};
  const saved = new Map();

  for (const method of ["log", "info", "warn", "error"]) {
    saved.set(method, target[method]);
    target[method] = (...args) => lines.push(args.map(format).join(" "));
  }

  try {
    return { result: await run(), lines };
  } finally {
    for (const [method, original] of saved) target[method] = original;
  }
}

const ANSI = new RegExp("\\u001b\\[[0-9;]*m", "g");

function format(value) {
  if (typeof value === "string") return value.replace(ANSI, "");
  if (value instanceof Error) return String(value.stack ?? value.message).replace(ANSI, "");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
