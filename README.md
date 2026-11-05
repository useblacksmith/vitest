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

With the plugin, vitest only runs tests impacted by changes since the last successful run. `--shard=i/n` works as usual; the plugin assigns files to shards itself so each shard's cache stays stable.

Requires Vitest 5.1 or newer.

## How it works

The plugin uses Vitest's dependency tracking: each run records which modules and files every test depends on, and the next run compares the checkout against that record to calculate the impacted test set. The record is stored in the Actions cache when run on Blacksmith, so runs on different runners pick up where the last successful run left off.

## Options

| option | default | effect |
|---|---|---|
| `allTests` | `false` | Run every test instead of the affected selection (`allTests: !process.env.CI`, say). |
| `shadow` | `false` | Run every test, but log what the affected selection would have run and which failed files it would have skipped. Use it to evaluate the plugin on a repo before relying on the selection. |
| `disableCache` | `false` | Do not store the dependency record in the Actions cache. |
| `cachePrefix` | `'blacksmith-vitest'` | First segment of the cache key; change it to discard every existing entry. |
| `allowCustomShards` | `false` | Keep the affected selection when your config or another plugin sets `test.sequence.sequencer`. By default such a run runs every test and logs why. Only enable it for a sequencer that extends or delegates to the plugin's `HashShardSequencer`. |

## Tradeoffs

- **Only reads made by the test process are tracked.** Imports and `fs` reads from the tests themselves are; reads from a child process, `globalSetup`, or browser-mode projects are not. List such inputs in Vitest's `forceRerunTriggers` so a change to them runs everything.

## Development

```sh
npm ci
npm run check:types
npm run build          # dist/ (not committed; the release tarball ships it)
npm test               # runs the fixtures under test/ with a fake backend
```
