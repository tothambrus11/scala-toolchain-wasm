package scalawasm

import java.nio.charset.StandardCharsets

import scala.collection.mutable
import scala.concurrent.ExecutionContext
import scala.scalajs.concurrent.JSExecutionContext
import scala.scalajs.js
import scala.scalajs.js.JSConverters.*
import scala.scalajs.js.annotation.JSExportTopLevel
import scala.scalajs.js.typedarray.{Int8Array, Uint8Array}

import org.scalajs.ir.Version
import org.scalajs.linker.interface.{ESVersion, Linker, ModuleInitializer, ModuleKind, StandardConfig}
import org.scalajs.linker.standard.MemIRFileImpl
import org.scalajs.linker.{MemOutputDirectory, StandardImpl}
import org.scalajs.logging.NullLogger

import dotty.tools.browseride.BrowserLinkerBridge.IRInput

/** A linker that keeps its state between links.
 *
 *  The bridges this replaces build a new `Linker` per call with `batchMode(true)`, which
 *  throws away all incremental state - so every link re-parses the whole runtime IR, about
 *  15 MB across 5,000 files. Measured in a browser that is ~2 s on every link, on top of ~6 s
 *  the first time, and the user pays it on every run of their program.
 *
 *  Here the linker and its output directory are cached per target and `batchMode` is off, so
 *  the linker can reuse what it parsed and analysed. For that to work the IR files need
 *  versions that are stable when their content is: the runtime IR keeps a fixed version, and
 *  the program's IR is versioned by a digest of its bytes. Unchanged inputs then cost nothing.
 *
 *  The output directory is reused along with the linker on purpose. An incremental backend
 *  skips rewriting files it believes are already there; handing it a fresh, empty directory
 *  each time would silently produce an incomplete output.
 *
 *  `checkIR` is off. It re-verifies IR this toolchain produced itself, which is a compiler
 *  development aid, not something a user's edit-run loop should pay for.
 */
object LinkerSession:
  private given ExecutionContext = JSExecutionContext.queue

  private final class Session(val linker: Linker, val output: MemOutputDirectory)

  private val sessions = mutable.Map.empty[String, Session]

  /* The runtime IR is the same ~15 MB on every link. Converting it across the JS boundary and
   * hashing it each time costs more than the link itself, so it is handed over once and kept
   * as parsed-once IR files whose identity and version never change. */
  private var runtimeIR: Seq[MemIRFileImpl] = Nil

  private def config(wasm: Boolean): StandardConfig =
    StandardConfig()
      .withCheckIR(false)
      .withBatchMode(false)
      .withSourceMap(false)
      .withModuleKind(ModuleKind.ESModule)
      .withESFeatures(_.withESVersion(ESVersion.ES2018))
      .withExperimentalUseWebAssembly(wasm)

  private def session(target: String): Session =
    sessions.getOrElseUpdate(
      target,
      new Session(StandardImpl.linker(config(target == "wasm")), MemOutputDirectory()),
    )

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
    val current = session(target)
    val moduleInitializers =
      if mainClassName == null || mainClassName.isEmpty then Nil
      else Seq(ModuleInitializer.mainMethodWithArgs(mainClassName, "main", Nil))

    val inputs = runtimeIR ++ irFiles.toSeq.map(toIRFile)

    current.linker
      .link(inputs, moduleInitializers, current.output, NullLogger)
      .map { report =>
        val publicModule = report.publicModules.headOption.getOrElse {
          throw new IllegalStateException("Scala.js linker produced no public module.")
        }

        val files = current.output.fileNames().sorted.map { name =>
          val content = current.output.content(name).getOrElse {
            throw new IllegalStateException(s"Linked output `$name` was not captured.")
          }
          js.Dynamic.literal(name = name, bytes = toUint8Array(content))
        }

        js.Dynamic.literal(
          jsFileName = publicModule.jsFileName,
          files = files.toJSArray,
        )
      }
      .toJSPromise

  /** Drop the cached linkers; the next link starts from scratch. */
  @JSExportTopLevel("resetScalaJSLinkerSession")
  def resetSession(): Unit =
    sessions.clear()

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
