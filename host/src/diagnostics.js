/**
 * Parser for the Scala 3 console diagnostic format.
 *
 * The in-browser compiler reports through `console.log`, so what we get back is exactly what
 * scalac prints:
 *
 *     -- [E006] Not Found Error: /workspace/Main.scala:2:10 ------------------------
 *     2 |  println(foo)
 *       |          ^^^
 *       |          Not found: foo
 *     1 error found
 */

const HEADER = /^--\s*(?:\[(E\d+)\]\s*)?(.*?)\s*:\s*(\/[^\s:]*):(\d+):(\d+)\s*-*\s*$/;
const SEVERITYLESS_HEADER = /^--\s*(?:\[(E\d+)\]\s*)?(Error|Warning|Info)\s*:?\s*-*\s*$/i;
const SUMMARY = /^\d+\s+(errors?|warnings?)\s+found$/;

function severityOf(label) {
  const text = String(label ?? "").toLowerCase();
  if (text.includes("error")) return "error";
  if (text.includes("warn")) return "warning";
  return "info";
}

function shortMessage(bodyLines) {
  const contents = bodyLines
    .map((line) => {
      const match = /^\s*(?:\d+\s*)?\|(.*)$/.exec(line);
      return match ? match[1].trim() : null;
    })
    .filter((text) => text !== null && text.length > 0);

  // Everything up to the caret marker is the echoed source; the message follows it.
  const caretIndex = contents.findIndex((text) => /^[\^~]+$/.test(text));
  const message = caretIndex >= 0 ? contents[caretIndex + 1] : contents[contents.length - 1];
  return message ?? "";
}

/**
 * @param {string[]} lines raw compiler output lines
 * @returns {{diagnostics: Array<{severity: string, code: string|null, file: string|null,
 *   line: number|null, column: number|null, message: string, text: string}>,
 *   errorCount: number, warningCount: number}}
 */
export function parseDiagnostics(lines) {
  const flat = lines.flatMap((line) => String(line ?? "").split("\n"));
  const diagnostics = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const body = current.body;
    diagnostics.push({
      severity: current.severity,
      code: current.code,
      file: current.file,
      line: current.line,
      column: current.column,
      message: shortMessage(body) || current.label,
      text: [current.header, ...body].join("\n").trimEnd(),
    });
    current = null;
  };

  for (const line of flat) {
    const header = HEADER.exec(line);
    if (header) {
      flush();
      const [, code, label, file, lineNumber, column] = header;
      current = {
        header: line,
        body: [],
        code: code ?? null,
        label: label || "Error",
        severity: severityOf(label),
        file,
        line: Number(lineNumber),
        column: Number(column),
      };
      continue;
    }

    const bare = SEVERITYLESS_HEADER.exec(line);
    if (bare) {
      flush();
      current = {
        header: line,
        body: [],
        code: bare[1] ?? null,
        label: bare[2],
        severity: severityOf(bare[2]),
        file: null,
        line: null,
        column: null,
      };
      continue;
    }

    if (current) {
      if (SUMMARY.test(line.trim())) flush();
      else current.body.push(line);
    }
  }
  flush();

  return {
    diagnostics,
    errorCount: diagnostics.filter((d) => d.severity === "error").length,
    warningCount: diagnostics.filter((d) => d.severity === "warning").length,
  };
}
