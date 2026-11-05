import { defineConfig } from 'vitest/config'

import blacksmith, { BlacksmithReporter } from '../../src/index.ts'

// The plugin is in the root config and, through `extends`, in both projects;
// the reporter is opted into once, at the root.
export default defineConfig({
	plugins: [blacksmith({ allTests: true })],
	test: {
		reporters: ['default', new BlacksmithReporter()],
		projects: [
			{ extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } },
			{
				extends: true,
				test: { name: 'second', include: ['src/**/*.test.ts'] },
			},
		],
	},
})
