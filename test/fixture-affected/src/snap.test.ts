import { expect, test } from 'vitest'

test('snap', () => expect('hello').toMatchSnapshot())
