import { defineConfig } from 'vitest/config'
import { BaseSequencer } from 'vitest/node'

import blacksmith from '../../src/index.ts'

/** Vitest's own contiguous slicing, standing in for a third-party sequencer. */
class ContiguousSequencer extends BaseSequencer {}

export default defineConfig({
	plugins: [
		blacksmith({
			// The default (affected selection) is what BLACKSMITH_CHANGED=1 exercises.
			...(process.env.BLACKSMITH_CHANGED === '1' ? {} : { allTests: true }),
			shadow: process.env.BLACKSMITH_SHADOW === '1',
			allowCustomShards: process.env.BLACKSMITH_ALLOW_CUSTOM_SHARDS === '1',
			disableCache: process.env.BLACKSMITH_DISABLE_CACHE === '1',
			// mapped.test.ts reads nothing; only this rule ties it to mapped/.
			dependencies: { 'src/mapped.test.ts': 'mapped/**' },
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
		// A project with its own root makes vitest re-evaluate this file.
		...(process.env.BLACKSMITH_ROOTED_PROJECT === '1'
			? {
					projects: [
						{
							extends: true,
							test: {
								name: 'rooted',
								root: './src',
								include: ['one.test.ts', 'five.test.ts'],
							},
						},
					],
				}
			: {}),
		...(process.env.BLACKSMITH_CUSTOM_SEQUENCER === '1'
			? { sequence: { sequencer: ContiguousSequencer } }
			: {}),
	},
})
