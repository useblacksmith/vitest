# @blacksmith/vitest

Speed up vitest execution by only running tests impacted by a change, with automatic caching when run on Blacksmith.

## Usage

The plugin ships as a tarball (`blacksmith-vitest-<version>.tgz`), not on the npm registry:

```sh
npm install --save-dev ./blacksmith-vitest-0.2.0.tgz
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import blacksmith from '@blacksmith/vitest'

export default defineConfig({
	plugins: [blacksmith()],
})
```

In CI the plugin runs only the test files affected since the last green run. `--shard=i/n` works as usual; the plugin assigns files to shards itself so each shard's cache stays stable.

Requires Vitest 5.1 or newer. On an older Vitest the plugin logs once and every test runs.

## Options

| option | default | effect |
|---|---|---|
| `allTests` | `true` | Run every test. Set to `false` where you want the affected selection (CI). |
| `shadow` | `false` | Run every test, but log what the affected selection would have run and which failed files it would have skipped. Use it to evaluate the plugin on a repo before switching `allTests` off. |
| `disableCache` | `false` | Do not store the dependency record in the Actions cache. |
| `cachePrefix` | `'blacksmith-vitest'` | First segment of the cache key; change it to discard every existing entry. |
| `allowCustomShards` | `false` | Keep the affected selection when your config or another plugin sets `test.sequence.sequencer`. By default such a run runs every test and logs why. Only enable it for a sequencer that extends or delegates to the plugin's `HashShardSequencer`. |

## Tradeoffs

- **The first run is a full run.** Selection needs a cached record from an earlier green run of the same shard; the first run after enabling the plugin, after changing the shard count, or after a lockfile change runs everything.
- **A failing shard keeps rerunning its tests until it passes.** The record is only saved after a green run, so a failure is never hidden by a later unrelated commit.
- **Inputs read outside the test process are not tracked.** Imports and `fs` reads made by the tests themselves (fixtures, `.env`, directory listings) are tracked. Reads from a child process, from `globalSetup`, or in browser-mode projects are not; list such inputs in Vitest's `forceRerunTriggers` so a change to them runs everything.
- **Caching needs Blacksmith.** The record is stored in the Actions cache from Blacksmith runners. Anywhere else (GitHub-hosted runners, local runs) nothing is cached and every test runs.
- **Shard membership changes.** Files are assigned to shards by a hash of their path rather than Vitest's default contiguous split, so per-shard durations can differ from before; totals do not.
- **Custom sequencers are refused by default.** See `allowCustomShards`.

## Development

```sh
npm ci
npm run check:types
npm run build          # dist/ (not committed; the release tarball ships it)
npm test               # runs the fixtures under test/ with a fake backend
```
