import type { SortOption } from './use-query-state'

function selectionsAreEqual(current: readonly string[], next: readonly string[]) {
  return current.length === next.length && current.every((value, index) => value === next[index])
}

export function sortSelectionTransition(current: SortOption, next: SortOption) {
  if (current === next) return null
  return { sort: next, users: [] as string[], id: null }
}

export function userSelectionTransition(current: readonly string[], next: readonly string[]) {
  if (selectionsAreEqual(current, next)) return null
  return { users: [...next], id: null }
}
