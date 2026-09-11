/**
 * Serve pre-compressed toolchain assets from a static host.
 *
 * The compiler module is 31 MB, and static hosts cap individual files: Cloudflare Pages and
 * Workers both refuse anything over 25 MiB, and their `_headers` support strips
 * `Content-Encoding`, so the usual "upload it gzipped and label it" trick is unavailable.
 *
 * So the deploy build stores `main.wasm.gz` (6.1 MB) and records the substitution in the
 * manifest:
 *
 *     "compressed": { "./compiler/main.wasm": { "url": "./compiler/main.wasm.gz",
 *                                               "encoding": "gzip" } }
 *
 * The compiler bundle's own loader asks for `main.wasm` and cannot be told otherwise, so we
 * install a narrow `fetch` shim that answers exactly those URLs by decompressing the stored
 * file. `DecompressionStream` keeps it streaming, so `WebAssembly.instantiateStreaming` still
 * compiles as the bytes arrive.
 */

import { fetchResponse } from "./net.js";

const CONTENT_TYPES = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".json": "application/json",
};

function contentTypeFor(url) {
  const path = url.split("?")[0];
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES[path.slice(dot)] ?? "application/octet-stream";
}

/**
 * @param {Record<string, {url: string, encoding?: string}|string>} compressed
 *   manifest entries, keyed by the URL the bundle will request
 * @param {(url: string) => string} resolve resolves manifest-relative URLs against the manifest
 * @returns {() => void} a function that removes the shim
 */
export function installCompressedAssetFetch(compressed, resolve) {
  const entries = new Map();
  for (const [requested, replacement] of Object.entries(compressed ?? {})) {
    const { url, encoding = "gzip" } = typeof replacement === "string" ? { url: replacement } : replacement;
    entries.set(resolve(requested), { url: resolve(url), encoding });
  }
  if (entries.size === 0) return () => {};

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    const requested = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    const entry = requested ? entries.get(new URL(requested, self.location.href).href) : undefined;
    if (!entry) return originalFetch(input, init);

    // Through the resilient path, not `originalFetch`. This is the compiler module - the
    // largest single download, and in a private window one that is re-fetched cold on every
    // visit - and it is requested by the compiler bundle's own loader rather than by us, so
    // nothing else here can name it or retry it. Left bare, a dropped connection arrives as
    // "Failed to fetch" with no indication of which of a dozen assets gave up.
    const response = await fetchResponse(entry.url, init);
    if (!response.ok) return response;

    // A host that decompressed it for us (Content-Encoding) leaves nothing to do.
    const alreadyDecoded = (response.headers.get("content-encoding") ?? "").includes(entry.encoding);
    const body = alreadyDecoded
      ? response.body
      : response.body.pipeThrough(new DecompressionStream(entry.encoding));

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": contentTypeFor(requested) },
    });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}
