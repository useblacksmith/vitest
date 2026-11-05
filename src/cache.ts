import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

/**
 * Keeps the dependency record and tree anchor in the Actions cache from
 * inside the run, so a job needs no restore/save steps. Speaks the cache
 * service's twirp API at ACTIONS_RESULTS_URL; on a Blacksmith runner a plain
 * step can reach it with no token because the VM proxy adds one, elsewhere
 * the variable is absent and nothing happens. Every failure here is logged
 * once and never changes the run.
 */

export const ENV_CACHE_URL = 'ACTIONS_RESULTS_URL'
const TWIRP = 'twirp/github.actions.results.api.v1.CacheService/'
/** Bundle format; bumped when its shape changes so old entries are missed, not misread. */
export const BUNDLE_VERSION = 'blacksmith-vitest-bundle-1'
export const TIMEOUT_MS = 15_000
/** Files under the cache dir that travel in the bundle. */
export const RECORD_FILE =
	/^(dependencies\.json|blacksmith(\.[0-9a-f]{12})?\.json)$/

export interface CacheKey {
	/** Exact key for this tree; also the save key. */
	key: string
	/** Prefix shared by every entry for the same shard and project set: the newest one restores. */
	prefix: string
}

export const DEFAULT_CACHE_PREFIX = 'blacksmith-vitest'

export function cacheKey(input: {
	snapshotVersion: number
	projects: string[]
	shard: { index: number; count: number } | null
	head: string
}): CacheKey {
	const scope = [
		`v${input.snapshotVersion}`,
		input.projects.some(Boolean)
			? createHash('sha1')
					.update(input.projects.join('\n'))
					.digest('hex')
					.slice(0, 12)
			: 'all',
		input.shard ? `${input.shard.index}of${input.shard.count}` : '1of1',
	].join('-')
	const prefix = `${DEFAULT_CACHE_PREFIX}-${scope}-`
	return { key: `${prefix}${input.head}`, prefix }
}

interface Bundle {
	version: string
	files: Record<string, string>
}

async function twirp<T>(
	base: string,
	method: string,
	body: object,
): Promise<T> {
	const response = await fetch(new URL(TWIRP + method, base), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'user-agent': '@useblacksmith/vitest',
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	})
	if (!response.ok) throw new Error(`${method} ${response.status}`)
	return (await response.json()) as T
}

/**
 * Requests carry both casings: a twirp JSON server accepts proto field names
 * (`restore_keys`, `size_bytes` as an integer) and their lowerCamel aliases;
 * the Blacksmith cache service validates the former and answers in it.
 */
function field(
	record: Record<string, unknown>,
	snake: string,
	camel: string,
): unknown {
	return record[snake] ?? record[camel]
}

export type RestoreOutcome =
	| { restored: true; key: string; files: number }
	| { restored: false; reason: string }

/** Fetches the newest bundle under `prefix` (exact `key` first) into `cacheDir`. */
export async function restoreBundle(
	base: string,
	cacheDir: string,
	{ key, prefix }: CacheKey,
): Promise<RestoreOutcome> {
	const lookup = await twirp<Record<string, unknown>>(
		base,
		'GetCacheEntryDownloadURL',
		{
			key,
			restore_keys: [prefix],
			restoreKeys: [prefix],
			version: BUNDLE_VERSION,
		},
	)
	const url = field(lookup, 'signed_download_url', 'signedDownloadUrl')
	if (!lookup.ok || typeof url !== 'string' || url === '') {
		return { restored: false, reason: `no entry under ${prefix}` }
	}
	const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
	if (!response.ok) throw new Error(`download ${response.status}`)
	const bundle = JSON.parse(
		gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8'),
	) as Bundle
	if (bundle.version !== BUNDLE_VERSION) {
		return { restored: false, reason: `bundle version ${bundle.version}` }
	}
	await mkdir(cacheDir, { recursive: true })
	for (const [name, content] of Object.entries(bundle.files)) {
		if (!RECORD_FILE.test(name)) continue
		await writeFile(path.join(cacheDir, name), content)
	}
	const matched = field(lookup, 'matched_key', 'matchedKey')
	return {
		restored: true,
		key: typeof matched === 'string' && matched !== '' ? matched : key,
		files: Object.keys(bundle.files).length,
	}
}

export type SaveOutcome =
	{ saved: true; bytes: number } | { saved: false; reason: string }

/** Uploads the record and anchors under the exact `key`; an existing entry for that key is left alone. */
export async function saveBundle(
	base: string,
	cacheDir: string,
	{ key }: CacheKey,
): Promise<SaveOutcome> {
	const files: Record<string, string> = {}
	for (const name of await readdir(cacheDir)) {
		if (RECORD_FILE.test(name))
			files[name] = await readFile(path.join(cacheDir, name), 'utf8')
	}
	const body = gzipSync(
		JSON.stringify({ version: BUNDLE_VERSION, files } satisfies Bundle),
	)
	const reserve = await twirp<Record<string, unknown>>(
		base,
		'CreateCacheEntry',
		{
			key,
			version: BUNDLE_VERSION,
		},
	)
	const url = field(reserve, 'signed_upload_url', 'signedUploadUrl')
	if (!reserve.ok || typeof url !== 'string' || url === '') {
		return { saved: false, reason: `${key} already exists or was refused` }
	}
	const put = await fetch(url, {
		method: 'PUT',
		headers: {
			'x-ms-blob-type': 'BlockBlob',
			'content-type': 'application/octet-stream',
		},
		body,
		signal: AbortSignal.timeout(TIMEOUT_MS * 4),
	})
	if (!put.ok) throw new Error(`upload ${put.status}`)
	const done = await twirp<Record<string, unknown>>(
		base,
		'FinalizeCacheEntryUpload',
		{
			key,
			version: BUNDLE_VERSION,
			size_bytes: body.byteLength,
			sizeBytes: String(body.byteLength),
		},
	)
	if (!done.ok) return { saved: false, reason: `finalize refused ${key}` }
	return { saved: true, bytes: body.byteLength }
}
