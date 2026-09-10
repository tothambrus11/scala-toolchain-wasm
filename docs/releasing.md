# Releasing

## Cutting a release

```bash
# 1. Decide the version (semver over the distribution - see docs/contract.md)
npm version --workspaces=false --no-git-tag-version 0.2.0   # or edit host/package.json
git commit -am "Release 0.2.0"

# 2. Tag and push
git tag v0.2.0
git push origin main --tags
```

The `Release` workflow then:

1. builds the toolchain from the pinned upstream commit (JDK 21, sbt, ~15-20 min cold),
2. runs the conformance tests in headless Chromium — a build that cannot compile and run
   Scala never becomes a release,
3. packages both tarballs plus `SHA256SUMS`,
4. publishes a GitHub Release whose notes embed `manifest.toolchain`, so the Scala/Scala.js/JDK
   triple is visible without downloading anything,
5. publishes the `host/` runtime to npm **only** if an `NPM_TOKEN` secret exists.

Running the workflow manually (`workflow_dispatch`) does everything except publish: the
artifacts are attached to the workflow run instead. That is the way to test a release, and the
way to build an arbitrary upstream commit via the `upstream_ref` input.

## Bumping the upstream compiler

The upstream commit is pinned in `scripts/build.sh`:

```bash
UPSTREAM_REF="357051c857d4ffd5d1e1bfc9a56f0cbf5943a325"
```

To move it:

1. Build it without committing anything: `UPSTREAM_REF=<sha> scripts/build.sh && npm test`.
2. If the conformance tests pass, edit `UPSTREAM_REF`, commit, and let CI confirm.
3. Release as a **minor** bump — a new compiler can change behaviour even when the API does not.

If the fork adds or renames something our `src-sjs/` collides with, the build fails at
compile time rather than producing a subtly wrong module. That is the point of adding sources
rather than patching.

## Verifying a release before announcing it

```bash
curl -fsSLO https://github.com/tothambrus11/scala-toolchain-wasm/releases/download/v0.2.0/scala-toolchain-wasm-0.2.0.tar.gz
tar -xzf scala-toolchain-wasm-0.2.0.tar.gz
npm test                      # tests ./dist
```

For the compressed variant:

```bash
mkdir -p release/unpacked && tar -xzf scala-toolchain-wasm-0.2.0-compressed.tar.gz -C release/unpacked --strip-components=1
DIST=release/unpacked npm test
```

CI runs both paths on every push, so a broken compressed variant is caught before a tag.

## What consumers do with it

A consumer pins a release and points a manifest URL at the unpacked distribution — same origin,
a CDN, or an R2 bucket; URLs inside the manifest resolve relative to it. Nothing else about the
distribution is API. See [contract.md](contract.md).
