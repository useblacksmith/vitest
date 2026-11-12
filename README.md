# @useblacksmith/vitest

Speed up vitest execution by only running tests impacted by a change, with automatic caching when run on Blacksmith.

> **Alpha.** The plugin is under active development; options and the cache format may change between releases.

## Usage

```sh
npm install --save-dev @useblacksmith/vitest
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import blacksmith from '@useblacksmith/vitest'

export default defineConfig({
	plugins: [blacksmith()],
})
```

With the plugin, vitest only runs tests impacted by changes since the last successful run. `--shard=i/n` works as usual; the plugin assigns files to shards itself so each shard's cache stays stable.

Requires Vitest 5.1 or newer.

### Vite+

Vite+ runs Vitest under `vp test`, so the plugin is loaded from the shared `vite.config.ts`:

```ts
// vite.config.ts
import 'vite-plus/test/config'
import { defineConfig } from 'vite-plus'
import blacksmith from '@useblacksmith/vitest'

export default defineConfig({
	plugins: [blacksmith()],
})
```

`vp test run` then runs the affected selection, including with `--shard`, test file filters, and `--config <path> --dir .` from a workspace package. Requires `vite-plus` 1.5.0 or newer, the first release that ships Vitest 5.1.

## Running locally

The same selection applies locally: a run reruns what changed on disk since the last successful run, committed or not. To run every test locally and select only in CI:

```ts
plugins: [blacksmith({ runAllTests: !process.env.CI })],
```

## How it works

The plugin uses Vitest's dependency tracking: each run records which modules and files every test depends on, and the next run compares the checkout against that record to calculate the impacted test set; a test the last successful run did not cover always runs. The record is stored in the Actions cache when run on Blacksmith, so runs on different runners pick up where the last successful run left off.

## Options

| option | default | effect |
|---|---|---|
| `runAllTests` | `false` | Run every test instead of the affected selection. |
| `shadow` | `false` | Run every test, but log what the affected selection would have run and which failing test files it would have skipped, i.e. failures the selection would have missed. Use it to evaluate the plugin on a repo before relying on the selection. |
| `dependencies` | `{}` | Dependencies the tracking cannot see, as globs of test files mapped to the glob(s) of the files they depend on, relative to the config root (`../shared/**` reaches outside a package): `{ 'tests/**/*.spec.ts': 'fixtures/**' }`. A change to a matching file reruns the mapped tests; a glob that matches no file in the repository warns. |

## Caveats

- **Only dependencies the test reaches through node are tracked.** `import`, `require`, and `fs` are tracked automatically, in the test process, in every node process it starts through `child_process` and in every `worker_threads` worker (each gets a preloaded recorder; their own children inherit it). A child or worker records what it has loaded as it goes, so one the test kills or terminates still counts, up to the end of its test file. For any child, the command and the arguments that name files are recorded too. A child started with `env: { ..., NODE_OPTIONS: undefined }`, or a worker with `env: SHARE_ENV`, gets no recorder, only its command line. Files read by `globalSetup`, by non-node programs, or build outputs a child runs in place of their sources are not; declare them with the `dependencies` option.
- **Shards must be stable for maximal efficacy.** The plugin assigns test files to shards by a hash of their path, so a file stays in its shard as others are added or removed. A custom `test.sequence.sequencer` is honoured, but every test that moves to another shard reruns there.

## Development

```sh
npm ci
npm run check:types
npm run build          # dist/ (not committed; built on publish)
npm test               # runs the fixtures under test/ with a fake backend
```
