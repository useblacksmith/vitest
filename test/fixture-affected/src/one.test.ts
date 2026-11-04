import { expect, test } from 'vitest'

import { a } from './lib/a.ts'

test('one', () => expect(a).toBe('a'))
