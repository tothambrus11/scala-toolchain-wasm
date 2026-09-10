/**
 * Main-thread client for the Scala engine worker.
 *
 * Usage:
 *   const engine = new ScalaEngine({ workerUrl, manifestUrl });
 *   engine.on("progress", ({ stage }) => ...);
 *   await engine.init();
 *   const result = await engine.run({ "Main.scala": source });
 */
export class ScalaEngine {
  #worker;
  #pending = new Map();
  #listeners = new Map();
  #nextId = 1;

  constructor({ workerUrl, manifestUrl = "./assets/manifest.json" } = {}) {
    this.manifestUrl = manifestUrl;
    this.#worker = new Worker(workerUrl, { type: "module" });
    this.#worker.addEventListener("message", (event) => this.#receive(event.data ?? {}));
    this.#worker.addEventListener("error", (event) => this.#emit("error", event));
  }

  #receive(message) {
    const { id, type } = message;
    const pending = id != null ? this.#pending.get(id) : null;

    switch (type) {
      case "result":
        this.#pending.delete(id);
        pending?.resolve(message.value);
        break;
      case "error": {
        this.#pending.delete(id);
        const error = Object.assign(new Error(message.error.message), message.error);
        if (pending) pending.reject(error);
        else this.#emit("error", error);
        break;
      }
      case "progress":
        this.#emit("progress", message);
        break;
      case "stdout":
        this.#emit("stdout", message);
        break;
      default:
        this.#emit("message", message);
    }
  }

  #request(type, payload = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...payload, id, type });
    });
  }

  #emit(event, payload) {
    for (const listener of this.#listeners.get(event) ?? []) listener(payload);
  }

  on(event, listener) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(listener);
    return () => this.#listeners.get(event)?.delete(listener);
  }

  /** Load the toolchain. Safe to call once; later calls resolve against the same load. */
  init() {
    this.ready ??= this.#request("init", { manifestUrl: this.manifestUrl });
    return this.ready;
  }

  /** Compile only. `files` maps workspace-relative names to source text. */
  compile(files, options) {
    return this.#request("compile", { files, options });
  }

  /**
   * Compile, link and execute.
   *
   * @param {Record<string, string>} files
   * @param {{mainClass?: string, options?: string[], target?: "js"|"wasm"}} [config]
   *   `target` selects the linker backend for the *user's* program.
   */
  run(files, { mainClass, options, target } = {}) {
    return this.#request("run", { files, mainClass, options, target });
  }

  terminate() {
    this.#worker.terminate();
    for (const { reject } of this.#pending.values()) reject(new Error("Engine terminated"));
    this.#pending.clear();
  }
}
