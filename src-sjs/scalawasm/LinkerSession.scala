package scalawasm

import scala.collection.mutable
import scala.concurrent.{ExecutionContext, Future}
import scala.scalajs.concurrent.JSExecutionContext
import scala.scalajs.js
import scala.scalajs.js.JSConverters.*
import scala.scalajs.js.annotation.JSExportTopLevel
import scala.scalajs.js.typedarray.{Int8Array, Uint8Array}
import scala.util.control.NonFatal

import org.scalajs.ir.Version
import org.scalajs.linker.interface.unstable.IRContainerImpl
import org.scalajs.linker.interface.{ESVersion, IRFile, ModuleInitializer, ModuleKind, Report, StandardConfig}
import org.scalajs.linker.standard.MemIRFileImpl
import org.scalajs.linker.{MemOutputDirectory, StandardImpl}
import org.scalajs.logging.NullLogger

import dotty.tools.browseride.BrowserLinkerBridge.IRInput

/** A linker that keeps its parsed IR between links, for the user's program.
 *
 *  Upstream's `BrowserLinkerBridge` does this for the *compiler* module; this is the same
 *  design for user programs, where the difference is that they may be linked to WebAssembly
 *  as well as to JavaScript, so there is a session per target.
 *
 *  Building a linker per call with `batchMode(true)` would re-parse the whole runtime IR -
 *  about 15 MB across 5,000 files - on every run of the user's program. Instead the linker
 *  and its IR cache live as long as the page, and IR files carry a version derived from their
 *  content, so unchanged inputs cost nothing on the next link.
 *
 *  Three details are load-bearing, and two of them were originally wrong here:
 *
 *   - **The output directory is fresh per link.** Reusing it looks like the right partner to
 *     an incremental linker, and is not: the linker writes only what changed, so a reused
 *     directory accumulates files from previous programs, and `fileNames()` then reports a
 *     module made of two different programs. In a session warmed on one program and then
 *     asked to link a larger one twice, that corrupted the linker's state badly enough to
 *     trap the whole Wasm instance on the second link.
 *   - **The linker is clearable.** After a failed link a `Linker` is in an undefined state and
 *     must not be reused; `clearableLinker` plus resetting the IR cache on failure means one
 *     bad link cannot poison every link after it.
 *   - `checkIR` is off. It re-verifies IR this toolchain produced itself, which is a compiler
 *     development aid, not something a user's edit-run loop should pay for.
 */
object LinkerSession:
  private given ExecutionContext = JSExecutionContext.queue

  private final class Session(config: StandardConfig):
    private val irFileCache = StandardImpl.irFileCache()
    private var cache = irFileCache.newCache
    private val linker = StandardImpl.clearableLinker(config)

    def link(
        irFiles: Seq[MemIRFileImpl],
        moduleInitializers: Seq[ModuleInitializer],
    ): Future[js.Object] =
      // Fresh every link: see the note above about what reusing it does.
      val outputDir = MemOutputDirectory()
      cache
        .cached(irFiles.map(new SingleFileContainer(_)))
        .flatMap(linker.link(_, moduleInitializers, outputDir, NullLogger))
        .map(report => result(report, outputDir))
        .recoverWith { case NonFatal(t) =>
          reset()
          Future.failed(t)
        }

    /** Start over: a failed link leaves the linker undefined, and the cache suspect. */
    def reset(): Unit =
      linker.clear()
      cache.free()
      cache = irFileCache.newCache

  private val sessions = mutable.Map.empty[String, Session]

  /* The runtime IR is the same ~15 MB on every link. Converting it across the JS boundary and
   * hashing it each time costs more than the link itself, so it is handed over once and kept
   * as parsed-once IR files whose identity and version never change. */
  private var runtimeIR: Seq[MemIRFileImpl] = Nil

  private def config(wasm: Boolean): StandardConfig =
    StandardConfig()
      .withCheckIR(false)
      // Incremental linking is unsound here, and the failure is not survivable: link a small
      // program, then a larger one, then link again, and the *third* link traps the whole Wasm
      // instance with "dereferencing a null pointer". The JSPI continuation is lost with it, so
      // the promise never settles and the page simply stops responding. Reproduced from a cold
      // session with hello-world followed by a program using `(1 to n).map`, which is an
      // entirely ordinary thing for someone to do in the first minute.
      //
      // The IR cache still holds the parsed runtime IR across links, so what batch mode costs
      // is re-analysis, not re-parsing 15 MB.
      .withBatchMode(true)
      .withSourceMap(false)
      .withModuleKind(ModuleKind.ESModule)
      .withESFeatures(_.withESVersion(ESVersion.ES2018))
      .withExperimentalUseWebAssembly(wasm)

  private def session(target: String): Session =
    sessions.getOrElseUpdate(target, new Session(config(target == "wasm")))

  /** Hand over the runtime IR once per session. */
  @JSExportTopLevel("setScalaJSRuntimeIR")
  def setRuntimeIR(irFiles: js.Array[IRInput]): Unit =
    runtimeIR = irFiles.toSeq.map(toIRFile)
    // The cached linkers analysed the previous runtime; start them over.
    sessions.clear()

  /** @param target "wasm" or anything else for JavaScript
   *  @param mainClassName the class whose `main` runs on import, or `""` for a plain module
   */
  @JSExportTopLevel("linkScalaJSSessionAsync")
  def linkAsync(
      irFiles: js.Array[IRInput],
      mainClassName: String,
      target: String,
  ): js.Promise[js.Object] =
    val moduleInitializers =
      if mainClassName == null || mainClassName.isEmpty then Nil
      else Seq(ModuleInitializer.mainMethodWithArgs(mainClassName, "main", Nil))

    session(target).link(runtimeIR ++ irFiles.toSeq.map(toIRFile), moduleInitializers).toJSPromise

  /** Drop the cached linkers; the next link starts from scratch. */
  @JSExportTopLevel("resetScalaJSLinkerSession")
  def resetSession(): Unit =
    sessions.clear()

  private def result(report: Report, outputDir: MemOutputDirectory): js.Object =
    val publicModule = report.publicModules.headOption.getOrElse {
      throw new IllegalStateException("Scala.js linker produced no public module.")
    }

    val files = outputDir.fileNames().sorted.map { name =>
      val content = outputDir.content(name).getOrElse {
        throw new IllegalStateException(s"Linked output `$name` was not captured.")
      }
      js.Dynamic.literal(name = name, bytes = toUint8Array(content))
    }

    js.Dynamic.literal(jsFileName = publicModule.jsFileName, files = files.toJSArray)

  /** The IR cache works in containers; ours each hold exactly one already-parsed file. */
  private final class SingleFileContainer(file: MemIRFileImpl)
      extends IRContainerImpl(file.path, file.version):
    def sjsirFiles(implicit ec: ExecutionContext): Future[List[IRFile]] =
      Future.successful(List(file))

  private def toIRFile(irFile: IRInput): MemIRFileImpl =
    val bytes = toByteArray(irFile.bytes)
    new MemIRFileImpl(irFile.path, Version.fromLong(digest(bytes)), bytes)

  /** FNV-1a: the linker only needs "did these bytes change", cheaply. */
  private def digest(bytes: Array[Byte]): Long =
    var hash = 0xcbf29ce484222325L
    var i = 0
    while i < bytes.length do
      hash = (hash ^ (bytes(i) & 0xffL)) * 0x100000001b3L
      i += 1
    hash

  private def toByteArray(bytes: Uint8Array): Array[Byte] =
    new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).toArray

  private def toUint8Array(bytes: Array[Byte]): Uint8Array =
    val signed = new Int8Array(bytes.length)
    var i = 0
    while i < bytes.length do
      signed(i) = bytes(i)
      i += 1
    new Uint8Array(signed.buffer, signed.byteOffset, signed.length)
