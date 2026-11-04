import { expect, test } from 'vitest'

import { a } from './lib/a.ts'
import { b } from './lib/b.ts'

test('two', () => expect(a + b).toBe('ab'))
