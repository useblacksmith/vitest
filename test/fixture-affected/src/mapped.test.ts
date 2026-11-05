import { expect, test } from 'vitest'

// Reads nothing; the config's `dependencies` ties it to mapped/.
test('mapped', () => expect(1 + 1).toBe(2))
