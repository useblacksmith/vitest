import { createHash } from 'node:crypto'
import path from 'node:path'

import {
	BaseSequencer,
	type ResolvedConfig,
	type TestSpecification,
	type Vitest,
} from 'vitest/node'

const BRAND = Symbol.for('blacksmith.vitest.sequencer')
const WRAPPED = Symbol.for('blacksmith.vitest.sequencer.wrapped')

type SequencerClass = ResolvedConfig['sequence']['sequencer']

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
/**
 * Vitest hands `shard()` the specs `--changed` kept, so a sequencer that
 * slices by position moves tests between shards as the selection changes,
 * and a test two shards disagree about can run on neither. The wrapper takes
 * the sequencer's own assignment over the full test list, as on a full run,
 * and keeps it whatever the selection; `sort()` stays the sequencer's.
 */
export function stableShards(Theirs: SequencerClass): SequencerClass {
	return class extends Theirs {
		static readonly [BRAND] = true
		static readonly [WRAPPED] = Theirs
		readonly #vitest: Vitest
		constructor(vitest: Vitest) {
			super(vitest)
			this.#vitest = vitest
		}
		override shard = async (
			files: TestSpecification[],
		): Promise<TestSpecification[]> => {
			const owns = await shardOwner(this.#vitest)
			return files.filter((file) => owns(file.moduleId))
		}
	}
}

/**
 * Which tests this shard runs, independent of the selection: by path hash
 * under Blacksmith's sequencer, by the wrapped sequencer's own `shard()`
 * over the full test list otherwise.
 */
export async function shardOwner(
	vitest: Vitest,
): Promise<(moduleId: string) => boolean> {
	const { root, shard } = vitest.config
	if (!shard) return () => true
	const Theirs = (
		vitest.config.sequence.sequencer as { [WRAPPED]?: SequencerClass }
	)[WRAPPED]
	if (!Theirs) return (moduleId) => inShard(root, moduleId, shard)
	const owned = new Set(
		(await new Theirs(vitest).shard(await vitest.globTestSpecifications())).map(
			(specification) => specification.moduleId,
		),
	)
	return (moduleId) => owned.has(moduleId)
}

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
