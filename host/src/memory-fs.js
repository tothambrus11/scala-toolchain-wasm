/**
 * An in-memory POSIX-ish file system exposed to the WebAssembly Scala compiler.
 *
 * The compiler bundle reaches the outside world through exactly one global,
 * `globalThis.__scala3CompilerSJSHostFS`, and expects a synchronous, Node `fs`-shaped
 * object. `hostFS` below is that view; the rest of the class is the convenience API the
 * engine uses to stage sources, jars and outputs.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function normalizePath(input) {
  const raw = String(input ?? "").replace(/\\/g, "/");
  const absolute = raw.startsWith("/") ? raw : `/${raw}`;
  const parts = [];

  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function dirname(path) {
  if (path === "/") return null;
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function basename(path) {
  if (path === "/") return "/";
  return path.slice(path.lastIndexOf("/") + 1);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (typeof value === "string") return encoder.encode(value);
  return Uint8Array.from(value ?? []);
}

class ENOENT extends Error {
  constructor(path) {
    super(`ENOENT: no such file or directory, '${path}'`);
    this.code = "ENOENT";
    this.errno = -2;
    this.path = path;
  }
}

export class VirtualFileSystem {
  #entries = new Map();

  constructor() {
    this.#entries.set("/", { type: "dir", children: new Set(), mtimeMs: Date.now() });
    this.hostFS = this.#createHostFS();
  }

  #get(path) {
    return this.#entries.get(normalizePath(path));
  }

  #require(path) {
    const entry = this.#get(path);
    if (!entry) throw new ENOENT(normalizePath(path));
    return entry;
  }

  #ensureDir(path) {
    const normalized = normalizePath(path);
    const existing = this.#entries.get(normalized);
    if (existing) {
      if (existing.type !== "dir") throw new Error(`Not a directory: ${normalized}`);
      return existing;
    }

    const parentPath = dirname(normalized);
    const entry = { type: "dir", children: new Set(), mtimeMs: Date.now() };
    this.#entries.set(normalized, entry);
    if (parentPath !== null) {
      this.#ensureDir(parentPath).children.add(basename(normalized));
    }
    return entry;
  }

  #writeFile(path, value) {
    const normalized = normalizePath(path);
    if (normalized === "/") throw new Error("Cannot write to /");

    const existing = this.#entries.get(normalized);
    if (existing && existing.type === "dir") throw new Error(`Is a directory: ${normalized}`);

    this.#ensureDir(dirname(normalized)).children.add(basename(normalized));
    this.#entries.set(normalized, { type: "file", bytes: toBytes(value), mtimeMs: Date.now() });
  }

  #delete(path, recursive, force) {
    const normalized = normalizePath(path);
    const entry = this.#entries.get(normalized);
    if (!entry) {
      if (force) return;
      throw new ENOENT(normalized);
    }

    if (entry.type === "dir") {
      if (entry.children.size > 0 && !recursive) {
        throw new Error(`Directory not empty: ${normalized}`);
      }
      for (const child of [...entry.children]) {
        this.#delete(normalized === "/" ? `/${child}` : `${normalized}/${child}`, true, true);
      }
    }

    this.#entries.delete(normalized);
    const parentPath = dirname(normalized);
    if (parentPath !== null) {
      this.#entries.get(parentPath)?.children.delete(basename(normalized));
    }
  }

  #createHostFS() {
    const fs = this;
    return {
      cwd: () => "/",
      existsSync: (path) => fs.#entries.has(normalizePath(path)),
      statSync(path) {
        const entry = fs.#require(path);
        return {
          size: entry.type === "file" ? entry.bytes.length : 0,
          mtimeMs: entry.mtimeMs,
          isFile: () => entry.type === "file",
          isDirectory: () => entry.type === "dir",
        };
      },
      readdirSync(path) {
        const entry = fs.#require(path);
        if (entry.type !== "dir") throw new Error(`Not a directory: ${normalizePath(path)}`);
        return [...entry.children].sort();
      },
      readFileSync(path) {
        const entry = fs.#require(path);
        if (entry.type !== "file") throw new Error(`Is a directory: ${normalizePath(path)}`);
        return new Uint8Array(entry.bytes);
      },
      readBinary(path) {
        return this.readFileSync(path);
      },
      mkdirSync(path, options = {}) {
        const normalized = normalizePath(path);
        if (!options.recursive) {
          const parent = fs.#require(dirname(normalized) ?? "/");
          if (parent.type !== "dir") throw new Error(`Not a directory: ${dirname(normalized)}`);
          if (fs.#entries.has(normalized)) throw new Error(`File exists: ${normalized}`);
        }
        fs.#ensureDir(normalized);
      },
      writeFileSync: (path, value) => fs.#writeFile(path, value),
      appendFileSync(path, value) {
        const normalized = normalizePath(path);
        const existing = fs.#entries.get(normalized);
        if (!existing) return fs.#writeFile(normalized, value);
        if (existing.type !== "file") throw new Error(`Is a directory: ${normalized}`);

        const addition = toBytes(value);
        const merged = new Uint8Array(existing.bytes.length + addition.length);
        merged.set(existing.bytes, 0);
        merged.set(addition, existing.bytes.length);
        fs.#writeFile(normalized, merged);
      },
      rmSync: (path, options = {}) => fs.#delete(path, !!options.recursive, !!options.force),
      rmdirSync: (path, options = {}) => fs.#delete(path, !!options.recursive, false),
      unlinkSync(path) {
        const entry = fs.#require(path);
        if (entry.type !== "file") throw new Error(`Not a file: ${normalizePath(path)}`);
        fs.#delete(path, false, false);
      },
      truncateSync: (path) => fs.#writeFile(path, new Uint8Array(0)),
    };
  }

  mkdirp(path) {
    this.#ensureDir(path);
  }

  writeText(path, text) {
    this.#writeFile(path, encoder.encode(text));
  }

  writeBytes(path, bytes) {
    this.#writeFile(path, bytes);
  }

  readText(path) {
    return decoder.decode(this.readBytes(path));
  }

  readBytes(path) {
    const entry = this.#require(path);
    if (entry.type !== "file") throw new Error(`Not a file: ${normalizePath(path)}`);
    return new Uint8Array(entry.bytes);
  }

  removeTree(path) {
    this.#delete(path, true, true);
  }

  /** All file paths under `path`, recursively, sorted. */
  listFiles(path = "/") {
    const root = normalizePath(path);
    const entry = this.#entries.get(root);
    if (!entry) return [];
    if (entry.type === "file") return [root];

    const files = [];
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      const currentEntry = this.#entries.get(current);
      if (!currentEntry || currentEntry.type !== "dir") continue;
      for (const child of currentEntry.children) {
        const childPath = current === "/" ? `/${child}` : `${current}/${child}`;
        const childEntry = this.#entries.get(childPath);
        if (childEntry?.type === "dir") stack.push(childPath);
        else if (childEntry) files.push(childPath);
      }
    }
    return files.sort();
  }
}
