# @blacksmith/vitest

Runs only the Vitest test files affected by a change, with the dependency
record and anchor cached between CI runs by the plugin itself.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import blacksmith from '@blacksmith/vitest'

export default defineConfig({
	plugins: [blacksmith()],
})
```

## Affected tests

The plugin also turns on `experimental.recordDependencies`, so Vitest writes
each test file's imports to `dependencies.json` in its cache directory
(`node_modules/.vite/vitest/<project>/`), and installs a VCS provider for
`--changed`. After a run that covered every test file, the plugin writes
`blacksmith.json` beside `dependencies.json` with an anchor for every path the
records name (mode and blob per file as `git ls-tree` prints them, a hash of
the listing per directory, lockfiles included) and the `--shard` spec. On the
next `vitest run --changed`, the provider re-anchors those paths and Vitest
runs the tests that import a changed file, plus any test file without a
record. A moved file is a change at its old path and in the listing of every
directory it left or entered; a renamed directory is a change to its listing. A changed `__snapshots__/*.snap`
reruns its test; a changed lockfile, or a missing or foreign snapshot, runs
everything. Only a passing run that covered every test it owns writes the
listing, so a failing or filtered run leaves the previous anchor in place.

Files a test reads without importing are recorded as well: a setup file the
plugin puts first in every worker notes the path of each `fs` read
(`readFileSync`, `fs.promises.readdir`, `existsSync`, `createReadStream` and
the rest) under the test file that made it, beside its imports. A changed
fixture reruns the tests that read it; a file added to, removed from or
renamed within a directory reruns the tests that listed that directory or one
above it, so a recursive listing is covered; a probe of a missing file reruns
the test once the file appears. Reads the setup file cannot see are those of
a child process the test spawns, of `globalSetup`, which runs outside the
workers, of code that took hold of an `fs` function before the setup file
ran (Vitest's own runtime, or another setup file under
`sequence.setupFiles: 'parallel'`), and of browser-mode projects, which have
no `fs`. Put such inputs (binaries a `globalSetup` builds,
say) in Vitest's own `forceRerunTriggers`, which runs everything when one of
them changes.

`--project` narrows what a run vouches for, so a narrowed run writes
`blacksmith.<hash of the project names>.json` and only a run over the same
project set reads it; `blacksmith.json` belongs to runs over every project.

`--shard=i/n` is handled by the plugin's sequencer: a test file belongs to the
shard `sha1(path) % n` picks, so it stays in the same shard as other files
come and go. Each shard's cache therefore only has to describe its own tests;
cache the directory per shard and include `n` in the key so a changed shard
count starts from scratch:

```yaml
- uses: actions/cache/restore@v5
  id: vitest-deps
  with:
    path: node_modules/.vite/vitest
    key: vitest-deps-${{ matrix.shard }}of${{ strategy.job-total }}-${{ github.sha }}
    restore-keys: vitest-deps-${{ matrix.shard }}of${{ strategy.job-total }}-
- run: npx vitest run --passWithNoTests --changed --shard=${{ matrix.shard }}/${{ strategy.job-total }}
- uses: actions/cache/save@v5
  if: success()
  with:
    path: node_modules/.vite/vitest
    key: ${{ steps.vitest-deps.outputs.cache-primary-key }}
```

Saving only on success keeps the listing anchored to a tree whose whole shard
passed, so a failing test keeps rerunning until the tree that broke it changes.

On a runner where a step can reach the Actions cache service (`ACTIONS_RESULTS_URL`
is set for plain steps on Blacksmith runners; the VM proxy supplies the token),
the plugin keeps the record and anchor in that cache itself: before selection
it restores the newest entry for the same shard and project set
(`blacksmith-vitest-v<version>-<projects>-<shard>-<sha>`, exact sha first), and
after a green run that covered its shard it saves one for the tree it tested.
The directory is Vitest's `cacheDir`, wherever the config puts it. No
restore/save steps are needed for it; when this run's anchor is already there
when Vitest starts (a job that still restores it, say) the plugin warns and
leaves it alone. The directory itself, and another project set's anchor, may
exist, since every `vitest run` on one config shares it. Under turbo's strict
env mode `ACTIONS_RESULTS_URL` (and `GITHUB_SHA`, `GITHUB_WORKSPACE`) must be
listed in `passThroughEnv`; the plugin warns when turbo hid them.
`blacksmith({ disableCache: true })` turns this off;
`blacksmith({ cachePrefix: 'vitest-2' })` replaces the `blacksmith-vitest` start
of the key, so a new prefix starts from empty entries when a cache has to be
discarded. Where the
variable is absent (GitHub-hosted runners, local runs) nothing is fetched or
sent and the run is unchanged. Any failure on that path is logged once and never
affects the run.

`blacksmith({ allTests: false })` turns `--changed` on from the config instead
of the command line (`allTests: !process.env.CI`, say). The plugin sets it (and `passWithNoTests`, since selecting nothing is the
expected outcome of an unrelated change) only when the
running Vitest routes `--changed` through its provider and records
dependencies; otherwise it says so once and every test runs, so an older
Vitest never skips tests on a record it did not keep.

Requires Vitest 5.1 or newer.

## Development

This package is built and tested on its own, outside the pnpm workspace:

```sh
cd extensions/vitest
npm ci
npm run check:types
npm run build          # dist/, committed so the dashboard can depend on this directory
npm test               # runs test/fixture with a fake backend
```

`dist/` is checked in because `dashboard/package.json` depends on
`file:../extensions/vitest`; rebuild and commit it with any `src/` change (CI
fails on a stale `dist/`).

## Custom sequencers

The plugin installs `HashShardSequencer`, which assigns a test file to a shard
by a hash of its path, so the dependency record of shard `i` always describes
the same files. If your config or another plugin sets `test.sequence.sequencer`
to something else, the plugin treats every test as changed and logs
`sharding is <Name>, not Blacksmith's`. Pass `allowCustomShards: true` when your
sequencer keeps that membership (extends or delegates to `HashShardSequencer`);
with any other membership the record never covers the shard and is not saved.

## Shadow mode

`blacksmith({ shadow: true })` runs every test and only reports what the
affected selection would have done. Vitest still records dependencies, but
gets no `--changed` and no VCS provider; the shard's cached record is fetched
into a temporary directory, Vitest's `cacheDir` is left alone, and when the
run ends the plugin logs

```
[blacksmith] shadow: would have run 12 of 535 test files (3 files changed since 6b2691f86aa1, from blacksmith-vitest-v3-all-1of2-…)
[blacksmith] shadow: 1 failed test files outside the selection: src/x.test.ts
```

The second line is the one to watch: a failed file the selection would have
skipped. A green shadow run saves the record like any full run, so switching
`shadow` off later starts from a warm cache.

## Reporting results (opt in)

`BlacksmithReporter` posts every test's outcome and duration to Blacksmith at
the end of a run. The plugin no longer adds it; list it as a reporter to use
it:

```ts
import blacksmith, { BlacksmithReporter } from '@blacksmith/vitest'

export default defineConfig({
	plugins: [blacksmith()],
	test: { reporters: ['default', new BlacksmithReporter()] },
})
```

On a Blacksmith runner the job environment carries the backend URL and a
job-scoped token; anywhere else the reporter does nothing. A failed upload is
a warning in the run output and never changes the exit code.
