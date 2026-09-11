/**
 * Unit tests for the macro-detection heuristic.
 *
 * These need no browser, so they run in milliseconds - which matters, because the cost of
 * getting this wrong is invisible in a browser test: arming macro support for a program that
 * does not need it still *works*, it just downloads 22 MB and takes the slow path. That is
 * exactly the bug this file exists to prevent, and it shipped once.
 */
import { mayDefineQuotedMacro, inferPackageName, macroPackages } from "../host/src/macros.js";

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// The playground's default sample. `${` here is string interpolation, not a splice - the most
// ordinary line in Scala, and once enough to make every compile of it pay for macro support.
const DEFAULT_SAMPLE = `@main def hello(): Unit =
  val squares = (1 to 5).map(n => n * n)
  println(s"squares: \${squares.mkString(", ")}")
  println(s"sum = \${squares.sum}")
`;

const MACRO_DEFINITION = `package demo

import scala.quoted.*

object Macros:
  inline def twice(inline x: Int): Int = \${ twiceImpl('x) }

  private def twiceImpl(x: Expr[Int])(using Quotes): Expr[Int] = '{ \$x * 2 }
`;

check("the default sample is not a macro", mayDefineQuotedMacro(DEFAULT_SAMPLE), false);
check("a real macro definition is", mayDefineQuotedMacro(MACRO_DEFINITION), true);
check(
  "a macro implementation alone is",
  mayDefineQuotedMacro(`package demo\nimport scala.quoted.*\ndef impl(x: Expr[Int])(using Quotes): Expr[Int] = ???\n`),
  true,
);
check("interpolation in a triple-quoted string is not", mayDefineQuotedMacro('val s = s"""a ${b} c"""'), false);
check("a splice in a comment is not", mayDefineQuotedMacro("// see ${foo}\nobject A"), false);
check("a splice after an escaped quote is not", mayDefineQuotedMacro('val x = s"he said \\"hi\\" ${name}"'), false);
check("scala.quoted named only inside a string is not", mayDefineQuotedMacro('val s = "scala.quoted"'), false);
check("a plain program is not", mayDefineQuotedMacro('@main def hello(): Unit = println("hi")'), false);

check("package is read from a leading clause", inferPackageName("package a.b\n\nobject C"), "a.b");
check("nested package clauses join", inferPackageName("package a\npackage b\nobject C"), "a.b"); 
check("a braceless package colon works", inferPackageName("package a.b:\n  object C"), "a.b");
check("no package clause is the root package", inferPackageName("object C"), "");
check("a package after a definition is not a declaration", inferPackageName("object C\npackage bad"), "");

check("only macro-defining sources contribute packages", macroPackages([MACRO_DEFINITION, DEFAULT_SAMPLE]), ["demo"]);
check("a macro-free workspace arms nothing", macroPackages([DEFAULT_SAMPLE]), []);

console.log(failures === 0 ? "\nAll macro-detection checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
