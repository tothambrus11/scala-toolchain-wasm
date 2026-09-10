package scalawasm

import scala.concurrent.ExecutionContext
import scala.scalajs.concurrent.JSExecutionContext
import scala.scalajs.js
import scala.scalajs.js.JSConverters.*
import scala.scalajs.js.annotation.JSExportTopLevel
import scala.scalajs.js.typedarray.{Int8Array, Uint8Array}

import org.scalajs.ir.Version
import org.scalajs.linker.MemOutputDirectory
import org.scalajs.linker.StandardImpl
import org.scalajs.linker.interface.{ESVersion, ModuleInitializer, ModuleKind, StandardConfig}
import org.scalajs.linker.standard.MemIRFileImpl
import org.scalajs.logging.NullLogger

import dotty.tools.browseride.BrowserLinkerBridge.IRInput

/** Links Scala.js IR to WebAssembly, in the browser.
 *
 *  This file is copied into `compiler/src-sjs/` of the `scala3-compiler-sjs` checkout by
 *  `scripts/build-compiler-assets.sh`, so it is compiled into the same WebAssembly module as
 *  the compiler and the linker. It is an addition rather than a patch, so it does not
 *  conflict when the fork moves.
 *
 *  The fork's own `BrowserLinkerBridge` links to JavaScript. This one turns on the linker's
 *  WebAssembly backend, so the *user's* program is WebAssembly too, and returns every file
 *  the linker emitted (`main.js`, `main.wasm`, `__loader.js`) - the JS host has no directory
 *  to read them from, and the emitted loader resolves its `.wasm` relative to the module URL.
 */
object WasmLinkerBridge:
  private given ExecutionContext = JSExecutionContext.queue

  private val wasmConfig = StandardConfig()
    .withCheckIR(false)
    .withBatchMode(true)
    .withSourceMap(false)
    .withModuleKind(ModuleKind.ESModule)
    .withESFeatures(_.withESVersion(ESVersion.ES2018))
    .withExperimentalUseWebAssembly(true)

  /** @param mainClassName the class whose `main` runs on import, or `""` for a plain module */
  @JSExportTopLevel("linkScalaJSWasmAsync")
  def linkWasmAsync(irFiles: js.Array[IRInput], mainClassName: String): js.Promise[js.Object] =
    val moduleInitializers =
      if mainClassName == null || mainClassName.isEmpty then Nil
      else Seq(ModuleInitializer.mainMethodWithArgs(mainClassName, "main", Nil))

    val linker = StandardImpl.linker(wasmConfig)
    val outputDir = MemOutputDirectory()
    val inputIRFiles =
      irFiles.toSeq.zipWithIndex.map { case (irFile, index) =>
        new MemIRFileImpl(irFile.path, Version.fromInt(index), toByteArray(irFile.bytes))
      }

    linker
      .link(inputIRFiles, moduleInitializers, outputDir, NullLogger)
      .map { report =>
        val publicModule = report.publicModules.headOption.getOrElse {
          throw new IllegalStateException("Scala.js linker produced no public module.")
        }

        val files = outputDir.fileNames().sorted.map { name =>
          val content = outputDir.content(name).getOrElse {
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

  private def toByteArray(bytes: Uint8Array): Array[Byte] =
    new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).toArray

  private def toUint8Array(bytes: Array[Byte]): Uint8Array =
    val signed = new Int8Array(bytes.length)
    var i = 0
    while i < bytes.length do
      signed(i) = bytes(i)
      i += 1
    new Uint8Array(signed.buffer, signed.byteOffset, signed.length)
