// Production build: two minified ESM bundles (the plugin and the worker
// setup file it points Vitest at), declarations from tsc, no source maps.
import { rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

rmSync('dist', { recursive: true, force: true })

await build({
	entryPoints: ['src/index.ts', 'src/record-reads.ts'],
	outdir: 'dist',
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	minify: true,
	sourcemap: false,
	legalComments: 'none',
	packages: 'external',
})

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--emitDeclarationOnly'], {
	stdio: 'inherit',
})
