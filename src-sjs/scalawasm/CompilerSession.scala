package scalawasm

import scala.scalajs.js
import scala.scalajs.js.annotation.JSExportTopLevel
import scala.scalajs.js.typedarray.Uint8Array

import dotty.tools.browseride.{BrowserJS, BrowserLinkerBridge, BrowserMacroLinkerRuntime}
import dotty.tools.dotc.MainJS
import dotty.tools.dotc.sjsmacros.host.SjsMacroBrowserGlobals

/** The compiler entry points this distribution's host runtime calls.
 *
 *  Everything here is a bridge. The compiler keeps a warm session per classpath, and expands
 *  quoted macros by relinking itself - both upstream, in `MainJS`. Neither is exported to
 *  JavaScript there, because upstream drives them from its own in-Scala worker; we drive them
 *  from our host, so this file exports them and nothing more.
 *
 *  It used to be 70 lines of our own session caching, built on a `Platform` subclass that
 *  smuggled a `ClassPath` across `ContextBase` instances. Upstream's `retainPlatformBetweenRuns`
 *  does the same thing from inside, where it can be correct. That code is gone; this is what
 *  replaced it.
 */
object CompilerSession:
  /** Phase timings are upstream's profiling hook. We do not surface them, so they go nowhere. */
  private val ignoreTiming: js.Function2[String, Double, Unit] = (_, _) => ()

  /** Compile `sourcePaths` with `setupArgs` (classpath, output directory, options).
   *
   *  Splitting the two is upstream's session key: a session is reused for as long as the setup
   *  arguments are unchanged, which is what makes a second compile cheap. `macrosPresent` costs
   *  a relink loop when true, so the host only sets it for sources that may define a macro.
   */
  @JSExportTopLevel("runScala3CompilerSessionAsync")
  def runAsync(
      setupArgs: js.Array[String],
      sourcePaths: js.Array[String],
      macrosPresent: Boolean,
  ): js.Promise[Int] =
    if macrosPresent then
      MainJS.runBrowserSessionWithRetainedMacroCompilerAndPhaseTimingAsync(setupArgs, sourcePaths, ignoreTiming)
    else
      MainJS.runBrowserSessionWithPhaseTimingAsync(setupArgs, sourcePaths, ignoreTiming)

  /** Install the machinery a macro expansion needs, and hand it the compiler's own IR.
   *
   *  Expanding a quoted macro in a browser means *running* the macro implementation, which
   *  means linking it - together with a copy of the compiler - into a module and importing it
   *  back. `BrowserMacroLinkerRuntime` implements that; it needs the compiler's `.sjsir` and a
   *  linker to put it through. Both come from here, once per page.
   */
  @JSExportTopLevel("installScala3MacroRuntimeAsync")
  def installMacroRuntime(
      compilerIRZipBytes: Uint8Array,
      compilerIRFiles: js.Array[BrowserLinkerBridge.IRInput],
      jszipWrapperUrl: String,
  ): js.Promise[Unit] =
    val bytes: js.Function0[js.Promise[Uint8Array]] = () => js.Promise.resolve[Uint8Array](compilerIRZipBytes)
    val files: js.Function0[js.Promise[js.Array[BrowserLinkerBridge.IRInput]]] =
      () => js.Promise.resolve[js.Array[BrowserLinkerBridge.IRInput]](compilerIRFiles)
    val link: js.Function1[js.Array[BrowserLinkerBridge.IRInput], js.Promise[js.Dynamic]] =
      irFiles => BrowserLinkerBridge.linkCompilerModuleAsync(irFiles).asInstanceOf[js.Promise[js.Dynamic]]

    BrowserMacroLinkerRuntime.install(
      js.Dynamic
        .literal(
          compilerIRBytes = bytes,
          compilerIRFiles = files,
          linkCompilerModule = link,
          jszipWrapperUrl = jszipWrapperUrl,
          recordTiming = ignoreTiming,
        )
        .asInstanceOf[BrowserMacroLinkerRuntime.Config]
    )

  /** Declare where the macro implementations for these packages will be found.
   *
   *  For a user's own macro that is their compiler output directory: the macro is compiled by
   *  the same run that needs it, so its `.sjsir` is simply already there.
   */
  @JSExportTopLevel("setScala3MacroArtifacts")
  def setMacroArtifacts(artifacts: js.Array[js.Dynamic]): Unit =
    BrowserJS.global.updateDynamic(SjsMacroBrowserGlobals.MacroArtifacts)(artifacts)

  /** Convert raw IR to the linker's input shape, hashing it so the linker can trust versions. */
  @JSExportTopLevel("makeScala3IRInput")
  def makeIRInput(path: String, bytes: Uint8Array): BrowserLinkerBridge.IRInput =
    BrowserLinkerBridge.irInput(path, bytes)

  /** Drop the linked macro modules, so the next macro compile relinks from current sources. */
  @JSExportTopLevel("resetScala3CompilerSession")
  def resetSession(): Unit =
    MainJS.clearRetainedMacroModules()
