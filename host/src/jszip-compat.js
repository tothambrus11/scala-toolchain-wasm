/**
 * The JSZip surface the WebAssembly compiler bundle uses, implemented on our zip reader.
 *
 * The compiler reads classpath jars through a global `JSZip`, but only touches:
 *
 *   JSZip.loadAsync(bytes) -> zip
 *   zip.files              -> { [name]: entry }
 *   zip.file(name)         -> entry | null
 *   entry.name, entry.dir, entry.date
 *   entry.async("uint8array") -> Promise<Uint8Array>
 *
 * Implementing that directly keeps ~370 KB of vendored JSZip out of the page and makes
 * entry reads lazy, which matters for a 15 MB `rt.jar`.
 */
import { openZip } from "./zip.js";

class ZipEntry {
  constructor(entry) {
    this.name = entry.name;
    this.dir = entry.dir;
    this.date = entry.date;
    this.size = entry.size;
    this.#entry = entry;
  }

  #entry;

  async async(type = "uint8array") {
    const bytes = await this.#entry.bytes();
    switch (type) {
      case "uint8array":
        return bytes;
      case "arraybuffer":
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      case "string":
      case "text":
        return new TextDecoder().decode(bytes);
      default:
        throw new Error(`Unsupported output type: ${type}`);
    }
  }
}

class Zip {
  constructor(entries) {
    this.files = Object.create(null);
    for (const entry of entries.values()) this.files[entry.name] = new ZipEntry(entry);
  }

  file(name) {
    return this.files[name] ?? null;
  }
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("loadAsync expects binary data");
}

const JSZipCompat = {
  async loadAsync(data) {
    return new Zip(openZip(toBytes(data)));
  },
};

export default JSZipCompat;
