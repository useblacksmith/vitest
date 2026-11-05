import { defineConfig } from 'vitest/config'

import blacksmith from '../../src/index.ts'
import { BlacksmithReporter } from '../../src/reporter.ts'

export default defineConfig({
	plugins: [blacksmith({ runAllTests: true })],
	test: {
		include: ['src/**/*.test.ts'],
		reporters: ['default', new BlacksmithReporter()],
	},
})
