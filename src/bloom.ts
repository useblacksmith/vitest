import { createHash } from 'node:crypto'

/** Serialized form stored in the snapshot: `m` bits, `k` hashes, bits base64-encoded. */
export interface BloomJSON {
	m: number
	k: number
	bits: string
}

/**
 * Set membership for the test files a snapshot vouches for. A false positive
 * would skip a test the shard never covered, so the default sizing keeps the
 * rate at one in a billion: ~43 bits per entry.
 */
export class BloomFilter {
	private constructor(
		readonly m: number,
		readonly k: number,
		private readonly bits: Uint8Array,
	) {}

	static from(keys: Iterable<string>, falsePositiveRate = 1e-9): BloomFilter {
		const entries = [...keys]
		const n = Math.max(entries.length, 1)
		const m = Math.ceil((-n * Math.log(falsePositiveRate)) / Math.LN2 ** 2)
		const k = Math.max(1, Math.round((m / n) * Math.LN2))
		const filter = new BloomFilter(m, k, new Uint8Array(Math.ceil(m / 8)))
		for (const key of entries) {
			for (const index of filter.indexes(key)) {
				const byte = index >> 3
				filter.bits[byte] = (filter.bits[byte] ?? 0) | (1 << (index & 7))
			}
		}
		return filter
	}

	static parse(value: unknown): BloomFilter | null {
		if (typeof value !== 'object' || value === null) return null
		const { m, k, bits } = value as Record<string, unknown>
		if (
			!Number.isInteger(m) ||
			!Number.isInteger(k) ||
			(m as number) < 1 ||
			(k as number) < 1 ||
			typeof bits !== 'string'
		) {
			return null
		}
		const bytes = Buffer.from(bits, 'base64')
		if (bytes.length !== Math.ceil((m as number) / 8)) return null
		return new BloomFilter(m as number, k as number, new Uint8Array(bytes))
	}

	has(key: string): boolean {
		for (const index of this.indexes(key)) {
			if (((this.bits[index >> 3] ?? 0) & (1 << (index & 7))) === 0)
				return false
		}
		return true
	}

	toJSON(): BloomJSON {
		return {
			m: this.m,
			k: this.k,
			bits: Buffer.from(this.bits).toString('base64'),
		}
	}

	/** Kirsch–Mitzenmacher double hashing over the two 64-bit halves of sha256. */
	private *indexes(key: string): Generator<number> {
		const digest = createHash('sha256').update(key).digest()
		const h1 = digest.readBigUInt64BE(0)
		const h2 = digest.readBigUInt64BE(8) | 1n
		const m = BigInt(this.m)
		for (let i = 0n; i < BigInt(this.k); i++) {
			yield Number((h1 + i * h2) % m)
		}
	}
}
