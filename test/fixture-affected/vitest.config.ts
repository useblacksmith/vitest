import { defineConfig } from 'vitest/config'
import { BaseSequencer } from 'vitest/node'

import blacksmith from '../../src/index.ts'

/** Vitest's own contiguous slicing, standing in for a third-party sequencer. */
class ContiguousSequencer extends BaseSequencer {}

export default defineConfig({
	plugins: [
		blacksmith({
			allTests: process.env.BLACKSMITH_CHANGED !== '1',
			shadow: process.env.BLACKSMITH_SHADOW === '1',
			allowCustomShards: process.env.BLACKSMITH_ALLOW_CUSTOM_SHARDS === '1',
			disableCache: process.env.BLACKSMITH_DISABLE_CACHE === '1',
			...(process.env.BLACKSMITH_CACHE_PREFIX
				? { cachePrefix: process.env.BLACKSMITH_CACHE_PREFIX }
				: {}),
		}),
	],
	// Vite's cacheDir; Vitest keeps its records under <cacheDir>/vitest.
	...(process.env.BLACKSMITH_CACHE_DIR
		? { cacheDir: process.env.BLACKSMITH_CACHE_DIR }
		: {}),
	test: {
		include: ['src/**/*.test.ts'],
		...(process.env.BLACKSMITH_CUSTOM_SEQUENCER === '1'
			? { sequence: { sequencer: ContiguousSequencer } }
			: {}),
	},
})
