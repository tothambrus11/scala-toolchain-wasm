package scalawasm

import scala.scalajs.js
import scala.scalajs.js.annotation.JSExportTopLevel

import dotty.tools.dotc.JSDriver
import dotty.tools.dotc.config.{Platform, SJSPlatform}
import dotty.tools.dotc.core.Contexts.{Context, ContextBase, ctx}
import dotty.tools.dotc.core.Phases.Phase
import dotty.tools.dotc.reporting.ConsoleReporter
import dotty.tools.io.ClassPath

/** A compiler entry point that keeps the scanned classpath between compiles.
 *
 *  The upstream entry point goes through `Driver.process`, which builds a fresh `ContextBase`
 *  every call, and with it a fresh classpath scan. Measured in a browser, compiling an *empty*
 *  source costs ~3 s for that reason alone, and stopping the compiler after typer saves under
 *  a second - the time is not in the phases, it is in getting ready to run them. `rt.jar` is
 *  15 MB and `scala-lib.jar` 8.8 MB, and both are re-indexed from the in-memory file system on
 *  every compile.
 *
 *  What is cached here is only the `ClassPath`: an index of entries, holding no symbols.
 *
 *  What is deliberately *not* cached is the symbol table. Reusing the whole `ContextBase`
 *  looks tempting - it makes a repeat compile of an unchanged program almost instant - but it
 *  is wrong: the second compile of the same file fails with
 *  `E161: hello is already defined as class hello`, because the previous run's top-level
 *  symbols are still in the package scope. Each compile therefore gets a fresh base, a fresh
 *  symbol table and a fresh reporter, and only the expensive, immutable index is shared.
 *
 *  `SJSPlatform` cannot be shared for the same reason: it holds `jsDefinitions`, which are
 *  symbols belonging to one base.
 */
object CompilerSession extends JSDriver:
  /** The classpath this index was built from; a different one must not reuse it. */
  private var cachedFor: String | Null = null
  private var cachedClassPath: ClassPath | Null = null

  private final class CachingSJSPlatform(using Context) extends SJSPlatform:
    override def classPath(using Context): ClassPath =
      val key = ctx.settings.classpath.value
      cachedClassPath match
        case cp: ClassPath if cachedFor == key => cp
        case _ =>
          val cp = super.classPath
          cachedClassPath = cp
          cachedFor = key
          cp

  /* Mirrors JSContextBase, which is final and so cannot be extended: no plugins, and a
   * Scala.js platform - here the one that reuses the classpath index. */
  private final class SessionContextBase extends ContextBase:
    override protected def newPlatform(using Context): Platform = new CachingSJSPlatform

    override def addPluginPhases(plan: List[List[Phase]])(using Context): List[List[Phase]] = plan

    override def pluginDescriptions(using Context): String = ""

    override def pluginOptionsHelp(using Context): String = ""

  override protected def initCtx: Context = (new SessionContextBase).initialCtx

  @JSExportTopLevel("runScala3CompilerSessionAsync")
  def runAsync(args: js.Array[String]): js.Promise[Int] =
    js.async {
      if process(args.toArray, new ConsoleReporter(), null).hasErrors then 1 else 0
    }

  /** Forget the cached classpath index; the next compile re-scans it. */
  @JSExportTopLevel("resetScala3CompilerSession")
  def resetSession(): Unit =
    cachedClassPath = null
    cachedFor = null
