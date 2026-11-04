import { createHash } from 'node:crypto'
import path from 'node:path'

import { BaseSequencer, type TestSpecification } from 'vitest/node'

const BRAND = Symbol.for('blacksmith.vitest.sequencer')

/**
 * The name of the configured sequencer when it is not Blacksmith's (nor a
 * subclass of it), `null` when it is. Another plugin or the config may have
 * replaced `sequence.sequencer` after this plugin's `config()` ran.
 */
export function customSequencer(sequencer: unknown): string | null {
	if (typeof sequencer !== 'function') return null
	if ((sequencer as { [BRAND]?: boolean })[BRAND] === true) return null
	return sequencer.name || 'anonymous sequencer'
}

/** Zero-based shard owning `relativePath`; depends only on the path and `count`, never on the other test files. */
export function shardFor(relativePath: string, count: number): number {
	const digest = createHash('sha1')
		.update(relativePath.split(path.sep).join('/'))
		.digest()
	return digest.readUInt32BE(0) % count
}

export function inShard(
	root: string,
	moduleId: string,
	shard: { index: number; count: number } | undefined,
): boolean {
	if (!shard) return true
	return (
		shardFor(path.relative(root, moduleId), shard.count) === shard.index - 1
	)
}

/**
 * Replaces vitest's contiguous slices: a test stays in the same shard when
 * other tests are added, removed or filtered out by `--changed`, so each
 * shard's dependency record only ever has to vouch for its own tests.
 */
export class HashShardSequencer extends BaseSequencer {
	/** Marks this class and its subclasses, across copies of the module. */
	static readonly [BRAND] = true

	override async shard(
		files: TestSpecification[],
	): Promise<TestSpecification[]> {
		const { root, shard } = this.ctx.config
		return files.filter((file) => inShard(root, file.moduleId, shard))
	}
}
