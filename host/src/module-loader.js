/**
 * Turn linker output into something the browser can `import()`.
 *
 * The JavaScript target is a single file. The WebAssembly target is three - `main.js`,
 * `__loader.js` and `main.wasm` - that reference each other by relative name, and the
 * emitted loader resolves the `.wasm` against `import.meta.url`. There is no directory to
 * serve them from, so each file becomes a blob URL and the entry module's relative
 * references are rewritten to those URLs before it is imported.
 */

const MIME = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

function mimeFor(name) {
  const dot = name.lastIndexOf(".");
  return MIME[name.slice(dot)] ?? "application/octet-stream";
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {{target: string, code?: string, jsFileName?: string,
 *   files?: Array<{name: string, bytes: Uint8Array}>}} link linker output
 * @returns {{url: string, revoke: () => void}}
 */
export function createLinkedModuleURL(link) {
  if (link.target !== "wasm") {
    const url = URL.createObjectURL(new Blob([link.code], { type: "text/javascript" }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }

  const entryName = link.jsFileName;
  const entry = link.files.find((file) => file.name === entryName);
  if (!entry) throw new Error(`Linker did not emit the entry module ${entryName}`);

  const urls = new Map();
  for (const file of link.files) {
    if (file.name === entryName) continue;
    urls.set(file.name, URL.createObjectURL(new Blob([file.bytes], { type: mimeFor(file.name) })));
  }

  let code = new TextDecoder().decode(entry.bytes);
  for (const [name, url] of urls) {
    // The emitter writes these as "./name" in imports and in the loader call.
    code = code.replace(new RegExp(`(["'])\\./${escapeForRegExp(name)}\\1`, "g"), JSON.stringify(url));
  }

  const entryURL = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  return {
    url: entryURL,
    revoke: () => {
      URL.revokeObjectURL(entryURL);
      for (const url of urls.values()) URL.revokeObjectURL(url);
    },
  };
}

/** Total size of a link result, for reporting. */
export function linkedSize(link) {
  if (link.target !== "wasm") return link.code.length;
  return link.files.reduce((total, file) => total + file.bytes.length, 0);
}
