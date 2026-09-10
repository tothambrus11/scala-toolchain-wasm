/**
 * Where does compile latency go?
 *
 *   node tests/profile.mjs
 *
 * Measures the phases a user actually waits through - toolchain load, compile, link - and
 * separates one-off costs (warmup, classpath indexing) from per-edit costs, because only the
 * latter decides how the editor feels.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const DIST = process.env.DIST ?? "dist";
// STATELESS=1 forces the upstream entry point, which rebuilds the compiler on every call.
const STATELESS = process.env.STATELESS === "1";
// SCENARIO=warmup measures the journey a user takes, rather than each phase in isolation.
const SCENARIO = process.env.SCENARIO ?? "phases";

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

const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "inherit"],
});
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if ((await fetch(`${BASE_URL}${DIST}/manifest.json`)).ok) break;
  } catch {
    // not up yet
  }
  await delay(100);
}

const browser = await chromium.launch({
  headless: process.env.HEADED !== "1",
  executablePath: findChromium(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

const TINY = '@main def hello(): Unit = println("hi")\n';
const EDITED = '@main def hello(): Unit = println("hi there")\n';
const REALISTIC = `case class Point(x: Int, y: Int):
  def norm2: Int = x * x + y * y

object Geometry:
  def closest(points: List[Point]): Option[Point] = points.minByOption(_.norm2)
  def scale(points: List[Point], by: Int): List[Point] = points.map(p => Point(p.x * by, p.y * by))

@main def hello(): Unit =
  val points = (1 to 20).toList.map(n => Point(n, n * 2))
  println(Geometry.closest(Geometry.scale(points, 3)))
`;

try {
  const page = await browser.newPage();
  page.on("pageerror", error => console.log("  [pageerror]", error.message.slice(0, 200)));
  await page.goto(`${BASE_URL}tests/harness.html`);

  const report = await page.evaluate(
    async ({ dist, TINY, EDITED, REALISTIC, stateless, scenario }) => {
      const { ScalaToolchain } = await import(`/${dist}/host/toolchain.js`);
      const timings = [];
      // Record what each compile produced, not just how long it took: a "fast" compile that
      // emitted nothing is a bug, not a speedup.
      const time = async (label, run) => {
        const started = performance.now();
        const value = await run();
        const ms = performance.now() - started;
        const detail = value && typeof value === "object" && "exitCode" in value
          ? `exit ${value.exitCode}, ${value.errorCount} err, ${value.irFiles?.length ?? 0} IR`
          : "";
        timings.push({
          label,
          ms,
          detail,
          failure: value?.exitCode ? String(value.output ?? "").slice(0, 300) : null,
        });
        return value;
      };

      const stages = [];
      // Only one toolchain per page: the compiler reaches its file system through a global.
      const tools = await time("toolchain load (fetch + instantiate)", () =>
        ScalaToolchain.load({
          manifestUrl: `/${dist}/manifest.json`,
          stateless,
          onProgress: stage => stages.push({ stage, at: performance.now() }),
        }),
      );

      // The journey a user actually takes: page loads, the app warms the toolchain in the
      // background, then the user hits Run.
      if (scenario === "warmup") {
        await time("warm-up (background, after load)", () => tools.warmUp());
        const compilation = await time("first user compile", () => tools.compile({ "Main.scala": REALISTIC }));
        await time("first user link", () => tools.link(compilation.irFiles, { mainClass: "hello" }));
        const second = await time("second user compile (one edit)", () =>
          tools.compile({ "Main.scala": REALISTIC.replace("3))", "4))") }),
        );
        await time("second user link", () => tools.link(second.irFiles, { mainClass: "hello" }));
        return { timings, stages, probes: {}, irFileCount: compilation.irFiles.length, warm: tools.warmCompiles, incrementalLinking: tools.incrementalLinking };
      }

      // An empty source still pays whatever a compile invocation costs before it looks at
      // any code - classpath indexing, context setup. That is the floor.
      await time("compile (empty source)", () => tools.compile({ "Main.scala": "" }));
      await time("compile (empty source, again)", () => tools.compile({ "Main.scala": "" }));

      // Compile the same input repeatedly: anything the first run pays and later runs do not
      // is warmup or caching, not the cost of a compile.
      const first = await time("compile #1 (cold)", () => tools.compile({ "Main.scala": TINY }));
      await time("compile #2 (identical input)", () => tools.compile({ "Main.scala": TINY }));
      await time("compile #3 (one word changed)", () => tools.compile({ "Main.scala": EDITED }));
      await time("compile #4 (realistic file)", () => tools.compile({ "Main.scala": REALISTIC }));
      await time("compile #5 (realistic x4 files)", () =>
        tools.compile({
          "Main.scala": REALISTIC,
          "A.scala": REALISTIC.replace(/Point/g, "PointA").replace(/Geometry/g, "GeometryA").replace("@main def hello", "def unusedA"),
          "B.scala": REALISTIC.replace(/Point/g, "PointB").replace(/Geometry/g, "GeometryB").replace("@main def hello", "def unusedB"),
          "C.scala": REALISTIC.replace(/Point/g, "PointC").replace(/Geometry/g, "GeometryC").replace("@main def hello", "def unusedC"),
        }),
      );

      // Does stopping before code generation buy anything? Diagnostics do not need a backend.
      const probes = {};
      for (const flag of ["-Ystop-after:typer", "-Ystop-after:frontend", "-Vprofile", "-Vphases"]) {
        try {
          const result = await tools.compile({ "Main.scala": TINY }, { options: [flag] });
          probes[flag] = { accepted: result.exitCode === 0, output: result.output.slice(0, 400) };
        } catch (error) {
          probes[flag] = { accepted: false, error: String(error).slice(0, 200) };
        }
      }

      if (probes["-Ystop-after:typer"]?.accepted) {
        await time("compile (typer only) #1", () =>
          tools.compile({ "Main.scala": REALISTIC }, { options: ["-Ystop-after:typer"] }),
        );
        await time("compile (typer only) #2", () =>
          tools.compile({ "Main.scala": REALISTIC }, { options: ["-Ystop-after:typer"] }),
        );
      }

      // Link the same IR both ways, twice each: the two bridges differ in linker config.
      const ir = first.irFiles;
      await time("link to JavaScript #1", () => tools.link(ir, { mainClass: "hello" }));
      await time("link to JavaScript #2", () => tools.link(ir, { mainClass: "hello" }));
      await time("link to JavaScript #3", () => tools.link(ir, { mainClass: "hello" }));
      if (tools.supportsWasmTarget) {
        await time("link to WebAssembly #1", () => tools.link(ir, { mainClass: "hello", target: "wasm" }));
        await time("link to WebAssembly #2", () => tools.link(ir, { mainClass: "hello", target: "wasm" }));
        await time("link to WebAssembly #3", () => tools.link(ir, { mainClass: "hello", target: "wasm" }));
      }

      return {
        timings, stages, probes,
        irFileCount: ir.length,
        warm: tools.warmCompiles,
        incrementalLinking: tools.incrementalLinking,
      };
    },
    { dist: DIST, TINY, EDITED, REALISTIC, stateless: STATELESS, scenario: SCENARIO },
  );

  console.log("\nToolchain load, stage by stage:");
  let previous = 0;
  for (const { stage, at } of report.stages) {
    console.log(`  ${stage.padEnd(12)} +${((at - previous) / 1000).toFixed(2)}s`);
    previous = at;
  }

  console.log(`\nProgram IR: ${report.irFileCount} .sjsir files; warm compiles: ${report.warm}, incremental linking: ${report.incrementalLinking}\n`);
  console.log("Phase                                    time");
  console.log("-".repeat(56));
  for (const { label, ms, detail, failure } of report.timings) {
    console.log(`${label.padEnd(40)} ${(ms / 1000).toFixed(2).padStart(7)}s   ${detail ?? ""}`);
    if (failure) console.log(`      ${failure.split("\n").slice(0, 5).join("\n      ")}`);
  }

  console.log("\nCompiler flag probes:");
  for (const [flag, result] of Object.entries(report.probes)) {
    console.log(`  ${flag.padEnd(24)} ${result.accepted ? "accepted" : "rejected"}`);
    if (result.output?.trim()) {
      console.log(`      ${result.output.trim().split("\n").slice(0, 4).join("\n      ")}`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}
