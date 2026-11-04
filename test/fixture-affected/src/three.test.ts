import { expect, test } from 'vitest'

import { b } from './lib/b.ts'

test('three', () => expect(b).toBe('b'))
