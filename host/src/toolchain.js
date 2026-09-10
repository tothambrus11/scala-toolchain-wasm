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

  constructor({ compilerModule, manifest, fs }) {
    this.#compilerModule = compilerModule;
    this.#manifest = manifest;
    this.fs = fs;
  }

  /**
   * @param {object} options
   * @param {string} [options.manifestUrl] location of the toolchain manifest
   * @param {(stage: string, detail?: object) => void} [options.onProgress]
   */
  static async load({ manifestUrl = "./assets/manifest.json", onProgress = () => {} } = {}) {
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

    const toolchain = new ScalaToolchain({ compilerModule, manifest, fs });
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
  async compile(files, { options = [] } = {}) {
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
    const { result: exitCode, lines } = await captureConsole(() =>
      this.#compilerModule.runScala3CompilerSJSAsync(args),
    );

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
    return typeof this.#compilerModule.linkScalaJSWasmAsync === "function";
  }

  /**
   * Link IR to an executable ES module.
   *
   * @param {Array<{path: string, bytes: Uint8Array}>} irFiles program IR (runtime IR is added)
   * @param {{mainClass?: string|null, target?: "js"|"wasm"}} [config]
   *   `mainClass` makes the module run `mainClass.main` on import; `target` selects the
   *   linker backend, so the user's program can be WebAssembly like the compiler itself.
   */
  async link(irFiles, { mainClass = null, target = "js" } = {}) {
    if (target === "wasm" && !this.supportsWasmTarget) {
      throw new Error(
        "This toolchain build cannot link to WebAssembly: it has no linkScalaJSWasmAsync export. Rebuild the assets with scripts/build-compiler-assets.sh.",
      );
    }

    const started = now();
    const allIR = (await this.#runtimeIRFiles()).concat(irFiles);
    const { result, lines } = await captureConsole(() => {
      if (target === "wasm") return this.#compilerModule.linkScalaJSWasmAsync(allIR, mainClass ?? "");
      return mainClass
        ? this.#compilerModule.linkScalaJSAsync(allIR, mainClass)
        : this.#compilerModule.linkScalaJSModuleAsync(allIR);
    });

    return {
      target,
      jsFileName: result.jsFileName,
      code: target === "wasm" ? null : result.code,
      files: target === "wasm" ? [...result.files].map((file) => ({ name: file.name, bytes: file.bytes })) : null,
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
