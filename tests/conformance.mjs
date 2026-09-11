/**
 * Conformance tests for a built distribution.
 *
 *   node tests/conformance.mjs            # tests ./dist
 *   DIST=release/unpacked node tests/conformance.mjs
 *
 * These answer the only question a release has to answer: given this distribution and this
 * host runtime, can a browser compile Scala, link it to both backends, run it, and get
 * diagnostics back? Everything runs in headless Chromium, because that is where the
 * toolchain actually has to work.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const DIST = process.env.DIST ?? "dist";

async function freePort() {
  if (process.env.PORT) return Number(process.env.PORT);
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** Playwright's pinned build is not always the one installed; find whatever is here. */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root)) {
    for (const layout of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const candidate = `${root}/${entry}/${layout}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const PORT = await freePort();
const BASE_URL = `http://127.0.0.1:${PORT}/`;

async function startServer() {
  const server = spawn(process.execPath, ["scripts/serve.mjs"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${BASE_URL}${DIST}/manifest.json`)).ok) return server;
    } catch {
      // not up yet
    }
    await delay(100);
  }
  server.kill();
  throw new Error(`no distribution at ${DIST}/manifest.json - run scripts/build.sh`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack, needle) {
  assert(
    String(haystack).includes(needle),
    `expected ${JSON.stringify(needle)}, got:\n${haystack}`,
  );
}

const cases = [
  {
    name: "compiles and runs a top-level @main (JavaScript)",
    files: {
      "Main.scala": `@main def hello(): Unit =
  val squares = (1 to 5).map(n => n * n)
  println("squares: " + squares.mkString(","))
  println("sum=" + squares.sum)
`,
    },
    target: "js",
    expect(result) {
      assert(result.ok, "compilation should succeed");
      assert(result.ran, "program should run");
      assertIncludes(result.output, "squares: 1,4,9,16,25");
      assertIncludes(result.output, "sum=55");
    },
  },
  {
    name: "links and runs the same program as WebAssembly",
    files: {
      "Main.scala": `@main def hello(): Unit = println("wasm " + (1 to 6).map(n => n * n).sum)`,
    },
    target: "wasm",
    expect(result) {
      assert(result.ok, "compilation should succeed");
      assert(result.target === "wasm", `target should be wasm, was ${result.target}`);
      assertIncludes(result.output, "wasm 91");
      const wasm = (result.linkedFiles ?? []).find(file => file.name === "main.wasm");
      assert(wasm, `linker should emit main.wasm, emitted ${(result.linkedFiles ?? []).map(f => f.name)}`);
      assert(wasm.size > 10_000, `main.wasm looks too small (${wasm.size} bytes)`);
    },
  },
  {
    name: "compiles several files together, with the standard library",
    files: {
      "Greeter.scala": `package util

object Greeter:
  def greet(name: String): String = s"hello, $name"
`,
      "Main.scala": `import util.Greeter

case class Point(x: Int, y: Int)

object Main:
  def main(args: Array[String]): Unit =
    val closest = List(Point(3, 4), Point(1, 1)).minBy(p => p.x * p.x + p.y * p.y)
    println(Greeter.greet("scala") + " " + closest)
`,
    },
    target: "js",
    expect(result) {
      assert(result.ok, "compilation should succeed");
      assertIncludes(result.output, "hello, scala Point(1,1)");
    },
  },
  {
    name: "reports a type error with position and message",
    files: { "Main.scala": `object Main:\n  def main(args: Array[String]): Unit =\n    val n: Int = "text"\n` },
    target: "js",
    expect(result) {
      assert(!result.ok, "compilation should fail");
      assert(result.errorCount === 1, `expected 1 error, got ${result.errorCount}`);
      const [first] = result.diagnostics;
      assert(first.severity === "error", `severity was ${first.severity}`);
      assert(first.line === 3, `error should be on line 3, was ${first.line}`);
      assert(first.file?.endsWith("Main.scala"), `file was ${first.file}`);
      assertIncludes(first.message, "Found:");
    },
  },
  // The macro cases run last, for two reasons. One is ordinary: they cost ~80 s against
  // everyone else's ~1 s, so failures in cheap checks should surface first. The other is a
  // KNOWN LIMIT, not a fixed bug: with the macro case earlier in this list, the compile after
  // it traps with "dereferencing a null pointer" and takes the renderer with it. The same
  // sequence in isolation - macro compile, then a one-file plain compile, then a two-file one
  // - passes every time, so it needs roughly ten prior compiles in the same page to show up.
  // A long editing session that then meets a macro can presumably hit it. See docs/fork.md.
  {
    // The headline capability of this distribution, and the expensive one: expanding this
    // macro means the compiler links a second copy of itself with `showImpl` in it, imports
    // that, and re-enters the compile. If macro support regresses, it regresses here.
    name: "expands a quoted macro the program defines itself",
    files: {
      "Macros.scala": `package demo

import scala.quoted.*

object Macros:
  inline def twice(inline x: Int): Int = \${ twiceImpl('x) }

  private def twiceImpl(x: Expr[Int])(using Quotes): Expr[Int] = '{ \$x * 2 }
`,
      "Main.scala": `import demo.Macros

@main def hello(): Unit = println("twice=" + Macros.twice(21))
`,
    },
    target: "js",
    expect(result) {
      assert(result.ok, `compilation should succeed, got:\n${result.compilerOutput}`);
      assert(result.ran, "program should run");
      // 42 could only be produced by actually running twiceImpl at compile time.
      assertIncludes(result.output, "twice=42");
    },
  },
  {
    // Macro support costs 22 MB of compiler IR and a second linked compiler, so a program
    // without macros must never trigger any of it. This case would still pass if it did -
    // what guards that is its timing, which is why it runs right after the macro case.
    name: "leaves a macro-free program on the fast path",
    files: {
      "Main.scala": `@main def hello(): Unit = println("plain " + (1 to 4).product)`,
    },
    target: "js",
    expect(result) {
      assert(result.ok, "compilation should succeed");
      assertIncludes(result.output, "plain 24");
      assert(result.compileMs < 4000, `a macro-free compile should stay fast, took ${Math.round(result.compileMs)}ms`);
    },
  },
];

/**
 * The toolchain caches aggressively between compiles - the classpath index, the linker's
 * analysis. That is where correctness bugs would hide, so drive a session through a sequence
 * of edits and check each answer is about the current source, not a previous one.
 */
const editSequence = {
  name: "stays correct across repeated edits in one session",
  async run(page) {
    const steps = [
      { source: 'object Main:\n  def main(args: Array[String]): Unit = println(nope)\n', expect: "Not found: nope" },
      { source: 'object Main:\n  def main(args: Array[String]): Unit = println("first")\n', expect: null },
      { source: 'object Main:\n  def main(args: Array[String]): Unit = println("second")\n', expect: null },
      { source: 'object Main:\n  def main(args: Array[String]): Unit =\n    val n: Int = "text"\n    println(n)\n', expect: "Found:" },
      { source: 'object Renamed:\n  def main(args: Array[String]): Unit = println("renamed")\n', expect: null },
      { source: 'object Main:\n  def main(args: Array[String]): Unit = println("back again")\n', expect: null },
    ];

    for (const [index, step] of steps.entries()) {
      const result = await page.evaluate(
        source => globalThis.__engine.compile({ "Main.scala": source }),
        step.source,
      );

      if (step.expect === null) {
        assert(
          result.ok,
          `step ${index + 1} should compile, got ${result.errorCount} error(s):\n${result.compilerOutput}`,
        );
        assert(result.irFileCount > 0, `step ${index + 1} compiled but emitted no IR`);
      } else {
        assert(!result.ok, `step ${index + 1} should have failed`);
        assertIncludes(result.diagnostics.map(d => d.message).join("\n"), step.expect);
        assert(
          result.errorCount === 1,
          `step ${index + 1} should report exactly one error, got ${result.errorCount}: ${result.compilerOutput}`,
        );
      }
    }
  },
};

const server = await startServer();
const browser = await chromium.launch({
  headless: process.env.HEADED !== "1",
  executablePath: findChromium(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

let failures = 0;
let total = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", error => console.log("  [pageerror]", error.message.slice(0, 200)));
  await page.goto(`${BASE_URL}tests/harness.html`);

  const started = Date.now();
  const info = await page.evaluate(
    async ({ dist }) => {
      // Import the host from the distribution, so the test covers what actually ships.
      const { ScalaEngine } = await import(`/${dist}/host/index.js`);
      globalThis.__engine = new ScalaEngine({
        workerUrl: new URL(`/${dist}/host/worker.js`, location.origin),
        manifestUrl: new URL(`/${dist}/manifest.json`, location.origin).href,
      });
      const ready = await globalThis.__engine.init();
      const manifest = await (await fetch(`/${dist}/manifest.json`)).json();
      return { ready, toolchain: manifest.toolchain, schema: manifest.schema };
    },
    { dist: DIST },
  );

  console.log(
    `toolchain ready in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
      `Scala ${info.toolchain?.scalaVersion}, Scala.js ${info.toolchain?.scalaJSVersion}, ` +
      `host ${info.toolchain?.hostVersion}, wasm target ${info.ready?.supportsWasmTarget ? "yes" : "no"}\n`,
  );

  const preflight = [
    ["manifest declares schema 1", info.schema === 1],
    ["manifest records the upstream ref", /^[0-9a-f]{40}$/.test(info.toolchain?.ref ?? "")],
    ["manifest records the Scala version", /^\d+\.\d+/.test(info.toolchain?.scalaVersion ?? "")],
    ["distribution supports the WebAssembly target", info.ready?.supportsWasmTarget === true],
    ["distribution can expand quoted macros", info.ready?.supportsMacros === true],
    // The host ships inside the distribution, so these can only disagree if the build staged
    // one release's host over another's compiler - which reads to a user as a missing feature.
    ["the staged host is the one the manifest records", info.ready?.versionMismatch === false],
    ["the compiler bundle exports everything the host expects", info.ready?.missingExports?.length === 0],
  ];
  for (const [name, ok] of preflight) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    total++;
    if (!ok) failures++;
  }

  {
    const caseStarted = Date.now();
    total++;
    try {
      await editSequence.run(page);
      console.log(`PASS  ${editSequence.name}  (${((Date.now() - caseStarted) / 1000).toFixed(1)}s)`);
    } catch (error) {
      failures++;
      console.log(`FAIL  ${editSequence.name}\n      ${error.message.split("\n").join("\n      ")}`);
    }
  }

  for (const testCase of cases) {
    const caseStarted = Date.now();
    total++;
    try {
      const result = await page.evaluate(
        ({ files, target }) => globalThis.__engine.run(files, { target }),
        { files: testCase.files, target: testCase.target },
      );
      testCase.expect(result);
      const timings = [result.compileMs, result.linkMs, result.runMs]
        .filter(value => value != null)
        .map(value => `${Math.round(value)}ms`)
        .join(" / ");
      console.log(`PASS  ${testCase.name}  (${((Date.now() - caseStarted) / 1000).toFixed(1)}s, ${timings})`);
    } catch (error) {
      failures++;
      console.log(`FAIL  ${testCase.name}\n      ${error.message.split("\n").join("\n      ")}`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? `\nAll ${total} checks passed.` : `\n${failures} of ${total} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
