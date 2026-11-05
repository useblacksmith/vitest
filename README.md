# @blacksmith/vitest

Speed up vitest execution by only running tests impacted by a change, with automatic caching when run on Blacksmith.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import blacksmith from '@blacksmith/vitest'

export default defineConfig({
	plugins: [blacksmith({ allTests: !process.env.CI })],
})
```

Requires Vitest 5.1 or newer.

## How it works

- Vitest records each test file's imports (`experimental.recordDependencies`); a setup file the plugin adds also records every `fs` read a test makes (fixtures, `.env`, directory listings), so a changed fixture reruns the tests that read it.
- After a green run that covered every test it owns, the plugin writes an anchor beside the record: mode and blob hash per recorded file, a listing hash per recorded directory, plus lockfiles and the shard spec.
- On the next run it diffs the anchor against the checkout and hands Vitest the changed paths; a test with no record, a changed lockfile, or a missing/foreign anchor runs everything. Only a green run that covered its whole shard writes a new anchor, so a failing test keeps rerunning until the tree that broke it changes.
- On a Blacksmith runner the record and anchor are kept in the Actions cache by the plugin itself (no `actions/cache` steps), keyed by plugin version, project set, shard and commit. Elsewhere nothing is fetched or sent and the run is unchanged.
- `--shard=i/n` is handled by the plugin's `HashShardSequencer`: a test file belongs to the shard `sha1(path) % n` picks, so each shard's cache always describes the same files.

Not seen by the recorder: reads from a child process, `globalSetup`, or browser-mode projects. Put such inputs in Vitest's own `forceRerunTriggers`.

## Options

| option | default | effect |
|---|---|---|
| `allTests` | `true` | Run everything. Set to `false` to turn `--changed` on from the config; on a Vitest that cannot honour it every test runs and the plugin says so once. |
| `disableCache` | `false` | Keep the record out of the Actions cache. |
| `cachePrefix` | `'blacksmith-vitest'` | First segment of the cache key; change it to start from empty entries. |
| `shadow` | `false` | Run every test, but fetch the cached record and log what the affected selection would have run and which failed files it would have skipped. A green run still saves the record. |
| `allowCustomShards` | `false` | Keep selecting when `test.sequence.sequencer` is not Blacksmith's. By default such a run treats every test as changed and logs `sharding is <Name>, not Blacksmith's`. Only enable it for a sequencer that extends or delegates to `HashShardSequencer`. |

`BlacksmithReporter` (opt in, `test.reporters: ['default', new BlacksmithReporter()]`) posts test outcomes to Blacksmith on a Blacksmith runner and does nothing elsewhere.

## Development

```sh
npm ci
npm run check:types
npm run build          # dist/ (not committed; the release tarball ships it)
npm test               # runs the fixtures under test/ with a fake backend
```
