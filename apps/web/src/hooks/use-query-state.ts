import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs'

export type SortOption = 'name' | 'latest'

export function useActiveId() {
  return useQueryState('id', parseAsString)
}

export function useActiveTypes() {
  return useQueryState('types', parseAsArrayOf(parseAsString).withDefault([]))
}

export function useActiveUsers() {
  // Keep the public `users` parameter for existing links. Values are stable actor keys;
  // FollowList upgrades legacy login values after the local Following snapshot resolves.
  return useQueryState('users', parseAsArrayOf(parseAsString).withDefault([]))
}

export function useSortBy() {
  return useQueryState(
    'sort',
    parseAsStringLiteral(['name', 'latest'] as const).withDefault('latest'),
  )
}
