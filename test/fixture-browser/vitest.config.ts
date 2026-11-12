import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

import blacksmith from '../../src/index.ts'

export default defineConfig({
	plugins: [
		blacksmith(
			process.env.BLACKSMITH_CHANGED === '1' ? {} : { runAllTests: true },
		),
	],
	test: {
		include: ['src/**/*.test.ts'],
		setupFiles: ['./src/setup.ts'],
		browser: {
			enabled: true,
			headless: true,
			screenshotFailures: false,
			provider: playwright(),
			instances: [{ browser: 'chromium' }],
		},
	},
})
