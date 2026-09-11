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
 * Remove comments and string literals, so that what is left is code.
 *
 * This exists because `${` means two entirely different things in Scala: a splice inside a
 * quote, and interpolation inside a string. `s"sum = ${xs.sum}"` is the single most ordinary
 * line in a Scala program and has nothing to do with macros.
 */
function codeOnly(source) {
  return source
    .replace(/"""[\s\S]*?"""/g, '""')       // triple-quoted, including interpolated ones
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')   // single-quoted, honouring \" escapes
    .replace(/\/\*[\s\S]*?\*\//g, " ")      // block comments
    .replace(/\/\/[^\n]*/g, " ");           // line comments
}

/**
 * Might this source define a quoted macro?
 *
 * Deliberately a text heuristic - deciding properly would mean compiling the file, which is
 * the thing we are trying to set up. It only decides whether to arm the macro machinery, so
 * the two directions of error cost different things: a false positive fetches 22 MB and takes
 * the slow compile path for a program that never needed it, and a false negative degrades to
 * the error a compiler without macro support would give.
 *
 * Both signals are looked for in code, not in strings:
 *   - a splice `${`, which outside a string literal can only be a quote splice;
 *   - `scala.quoted`, which any macro *implementation* must import to name `Expr` or `Quotes`.
 */
export function mayDefineQuotedMacro(source) {
  const code = codeOnly(source);
  return /\$\s*\{/.test(code) || code.includes("scala.quoted");
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

/**
 * A key identifying the macro-defining sources of a compile, exactly.
 *
 * Lengths are interleaved with the content so that no two different sets of sources can
 * produce the same key by concatenation - the cheap trick that makes this safe to compare
 * without hashing.
 */
export function macroSourceKey(files) {
  return Object.entries(files)
    .filter(([, source]) => mayDefineQuotedMacro(source))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, source]) => `${name.length}:${name}${source.length}:${source}`)
    .join("");
}
