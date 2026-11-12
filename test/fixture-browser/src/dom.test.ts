import { expect, test } from 'vitest'

import { greet } from './lib/dom.ts'

test('greets in the DOM', () => {
	expect(greet('ada').textContent).toBe('shared: hi ada')
	expect(document.title).toBe('fixture')
})
