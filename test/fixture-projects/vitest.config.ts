import { defineConfig } from 'vitest/config'

import blacksmith from '../../src/index.ts'

// The plugin is in the root config and, through `extends`, in both projects.
export default defineConfig({
	plugins: [blacksmith({ runAllTests: true })],
	test: {
		projects: [
			{ extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } },
			{
				extends: true,
				test: { name: 'second', include: ['src/**/*.test.ts'] },
			},
		],
	},
})
