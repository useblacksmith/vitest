import { shared } from './shared.ts'

export function greet(name: string): HTMLElement {
	const element = document.createElement('p')
	element.textContent = `${shared}: hi ${name}`
	return element
}
