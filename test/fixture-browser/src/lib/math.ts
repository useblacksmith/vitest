import { shared } from './shared.ts'

export function double(n: number): string {
	return `${shared}: ${n * 2}`
}
