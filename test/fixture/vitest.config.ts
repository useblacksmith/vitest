import { defineConfig } from 'vitest/config'

import blacksmith, { BlacksmithReporter } from '../../src/index.ts'

export default defineConfig({
	plugins: [blacksmith({ runAllTests: true })],
	test: {
		include: ['src/**/*.test.ts'],
		reporters: ['default', new BlacksmithReporter()],
	},
})
