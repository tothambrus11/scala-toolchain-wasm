/**
 * Client-side quoted-macro support.
 *
 * Expanding a macro means *running* the macro implementation, and in a browser nothing can run
 * until it is linked. So the compiler, on reaching a macro it cannot call, interrupts itself
 * and asks its host to link one: the compiler's own IR plus the macro's, into an ES module it
 * then imports and re-enters. Everything hard about that lives in the compiler bundle. This
 * file is the part the host owes it - deciding when a compile needs the machinery at all, and
 * paying for it only then.
 *
 * The cost is real: the compiler's IR is 22 MB, and linking a second compiler takes seconds.
 * A program with no macros in it must not pay any of that, which is what `macroPackages` is
 * for - it looks at the sources, not at what happens later.
 */

/**
 * Might this source define a quoted macro?
 *
 * Deliberately a text heuristic, matching the compiler's own: a splice `${` or a mention of
 * `scala.quoted`. It only decides whether to arm the machinery, so a false positive costs a
 * lazy fetch that then goes unused, and a false negative degrades to the error a compiler
 * without macro support would give. Parsing the file to be sure would mean compiling it,
 * which is the thing we are trying to set up.
 */
export function mayDefineQuotedMacro(source) {
  return /\$\s*\{/.test(source) || source.includes("scala.quoted");
}

/**
 * The package a source declares, as a dotted string ("" for the root package).
 *
 * Mirrors the compiler's own inference so that the packages we register as macro-bearing are
 * the packages it looks for. It reads leading `package` clauses and stops at the first
 * definition or import, which is what makes `package p` and `package p:` both work.
 */
export function inferPackageName(source) {
  const parts = [];
  for (const line of source.split(/\r?\n/)) {
    const declaration = /^\s*package\s+([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*:?/.exec(line);
    if (declaration) {
      parts.push(declaration[1].replace(/\s+/g, ""));
    } else if (/^\s*(import|object|class|trait|enum|def|val|var|@main)\b/.test(line)) {
      break;
    }
  }
  return parts.join(".");
}

/** The distinct packages among these sources that may define a macro; empty if none do. */
export function macroPackages(sources) {
  const packages = new Set();
  for (const source of sources) {
    if (mayDefineQuotedMacro(source)) packages.add(inferPackageName(source));
  }
  return [...packages].sort();
}
