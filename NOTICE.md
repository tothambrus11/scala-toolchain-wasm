# Third-party components

The distribution this repository publishes is built from, and redistributes, other projects:

- **Scala 3 (dotty)** - Apache License 2.0, <https://github.com/scala/scala3>
- **`scala3-compiler-sjs`** - a research fork of dotty that cross-compiles the compiler with
  Scala.js, Apache License 2.0, <https://github.com/pgilliar/scala3-compiler-sjs>
- **Scala.js**, including the linker embedded in the compiler module - Apache License 2.0,
  <https://github.com/scala-js/scala-js>
- **OpenJDK** - `classpath/rt.jar` is `java.base` extracted from the build JDK, GPLv2 with
  Classpath Exception

The built artifacts carry the licenses of those projects. The build scripts, the host runtime
under `host/`, and the Scala sources under `src-sjs/` are this repository's own work.
