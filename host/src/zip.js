/**
 * Minimal ZIP reader.
 *
 * Both the engine (runtime IR bundle) and the compiler bundle itself (classpath jars) need
 * to read zips. Rather than vendoring a zip library into the page we use the platform's
 * `DecompressionStream("deflate-raw")`. Only what a build tool actually emits is supported:
 * STORE (0) and DEFLATE (8), no zip64, no encryption.
 *
 * Entries are inflated lazily: `rt.jar` alone is 15 MB and the compiler only reads the
 * handful of classes a program actually touches.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;

function findEndOfCentralDirectory(view) {
  const maxCommentLength = 0xffff;
  const start = Math.max(0, view.byteLength - EOCD_MIN_SIZE - maxCommentLength);
  for (let offset = view.byteLength - EOCD_MIN_SIZE; offset >= start; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("Not a zip file: end of central directory record not found");
}

/** MS-DOS date/time, as stored in the central directory. */
function dosDate(time, date) {
  return new Date(
    1980 + (date >> 9),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    time >> 11,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parse a zip's central directory.
 *
 * @param {Uint8Array} bytes
 * @returns {Map<string, {name: string, dir: boolean, date: Date, size: number,
 *   bytes: () => Promise<Uint8Array>}>}
 */
export function openZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  const entries = new Map();

  for (let index = 0; index < entryCount; index++) {
    if (view.getUint32(offset, true) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error(`Corrupt zip: bad central directory header at ${offset}`);
    }

    const method = view.getUint16(offset + 10, true);
    const time = view.getUint16(offset + 12, true);
    const date = view.getUint16(offset + 14, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    const isDirectory = name.endsWith("/");
    let inflated = null;

    entries.set(name, {
      name,
      dir: isDirectory,
      date: dosDate(time, date),
      size: uncompressedSize,
      bytes() {
        inflated ??= (async () => {
          if (isDirectory) return new Uint8Array(0);
          if (view.getUint32(localOffset, true) !== LOCAL_FILE_SIGNATURE) {
            throw new Error(`Corrupt zip: bad local header for ${name}`);
          }
          const localNameLength = view.getUint16(localOffset + 26, true);
          const localExtraLength = view.getUint16(localOffset + 28, true);
          const dataStart = localOffset + 30 + localNameLength + localExtraLength;
          const raw = bytes.subarray(dataStart, dataStart + compressedSize);

          if (method === 0) return new Uint8Array(raw);
          if (method === 8) return inflateRaw(raw);
          throw new Error(`Unsupported zip compression method ${method} for ${name}`);
        })();
        return inflated;
      },
    });
  }

  return entries;
}

/**
 * Read and inflate every matching entry.
 *
 * @param {Uint8Array} bytes
 * @param {(name: string) => boolean} [filter]
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function readZipEntries(bytes, filter = () => true) {
  const selected = [...openZip(bytes).values()].filter((entry) => !entry.dir && filter(entry.name));
  return Promise.all(
    selected.map(async (entry) => ({ name: entry.name, bytes: await entry.bytes() })),
  );
}
