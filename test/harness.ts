import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import type { Payload } from '../src/payload.ts'

export const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
)
const vitestBin = path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs')

export interface ReceivedRequest {
	path: string
	headers: Record<string, string | string[] | undefined>
	payload: Payload
}

/** Records every POST; answers each with the next queued status (200 once the queue is empty). */
export class FakeBackend {
	readonly requests: ReceivedRequest[] = []
	private server!: Server
	url = ''

	constructor(private readonly statuses: number[] = []) {}

	async start(): Promise<this> {
		this.server = createServer((request, response) => {
			const chunks: Buffer[] = []
			request.on('data', (chunk: Buffer) => chunks.push(chunk))
			request.on('end', () => {
				const body = Buffer.concat(chunks)
				const json =
					request.headers['content-encoding'] === 'gzip'
						? gunzipSync(body).toString()
						: body.toString()
				this.requests.push({
					path: request.url ?? '',
					headers: request.headers,
					payload: JSON.parse(json) as Payload,
				})
				response.statusCode = this.statuses.shift() ?? 200
				response.end()
			})
		})
		await new Promise<void>((resolve) =>
			this.server.listen(0, '127.0.0.1', resolve),
		)
		const address = this.server.address()
		if (!address || typeof address === 'string') throw new Error('no port')
		this.url = `http://127.0.0.1:${address.port}`
		return this
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve, reject) =>
			this.server.close((error) => (error ? reject(error) : resolve())),
		)
	}
}

export interface FixtureRun {
	exitCode: number
	output: string
}

export function runFixture(
	env: Record<string, string>,
	fixture = 'fixture',
): Promise<FixtureRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [vitestBin, 'run'], {
			cwd: path.join(packageRoot, 'test', fixture),
			env: {
				PATH: process.env.PATH ?? '',
				HOME: process.env.HOME ?? '',
				GITHUB_WORKSPACE: packageRoot,
				...env,
			},
		})
		let output = ''
		child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
		child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
		child.on('error', reject)
		child.on('close', (exitCode) =>
			resolve({ exitCode: exitCode ?? -1, output }),
		)
	})
}
