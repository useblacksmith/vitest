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

## Running locally

The same selection applies locally: a run reruns what changed on disk since the last successful run, committed or not. To run every test locally and select only in CI:

```ts
plugins: [blacksmith({ runAllTests: !process.env.CI })],
```

## How it works

The plugin uses Vitest's dependency tracking: each run records which modules and files every test depends on, and the next run compares the checkout against that record to calculate the impacted test set. The record is stored in the Actions cache when run on Blacksmith, so runs on different runners pick up where the last successful run left off.

## Options

| option | default | effect |
|---|---|---|
| `runAllTests` | `false` | Run every test instead of the affected selection. |
| `shadow` | `false` | Run every test, but log what the affected selection would have run and which failed files it would have skipped. Use it to evaluate the plugin on a repo before relying on the selection. |
| `disableCache` | `false` | Do not store the dependency record in the Actions cache. |
| `cachePrefix` | `'blacksmith-vitest'` | First segment of the cache key; change it to discard every existing entry. |
| `dependencies` | `{}` | Dependencies the tracking cannot see, as globs of test files mapped to the glob(s) of the files they depend on, relative to the config root: `{ 'tests/**/*.spec.ts': 'fixtures/**' }`. A change to a matching file reruns the mapped tests. |
| `allowCustomShards` | `false` | Shards must be stable for maximal efficacy, which the plugin handles by default. Set this to `true` to use a custom sharding strategy (`test.sequence.sequencer`). |

## Caveats

- **Only dependencies in the test process are tracked.** `import`, `require`, and `fs` are automatically tracked. Files read from a child process, `globalSetup`, or outside of node are not; declare them with the `dependencies` option.

## Development

```sh
npm ci
npm run check:types
npm run build          # dist/ (not committed; the release tarball ships it)
npm test               # runs the fixtures under test/ with a fake backend
```
