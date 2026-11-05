import { test } from 'vitest'

throw new Error('top-level boom')

test('never collected', () => {})
