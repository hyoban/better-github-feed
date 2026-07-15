import { keepPreviousData } from '@tanstack/react-query'

export function getActivityQueryOptions<T extends object>(options: T) {
  return {
    ...options,
    placeholderData: keepPreviousData,
  }
}
