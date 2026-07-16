import type { FeedView, NonEmpty } from '@/local-feed'

function asNonEmpty(values: readonly string[]): NonEmpty<string> {
  const [first, ...rest] = values
  if (!first) throw new Error('Expected at least one value')
  return [first, ...rest]
}

export function toActorSelection(values: readonly string[]): FeedView['actors'] {
  return values.length > 0 ? asNonEmpty(values) : 'following'
}

export function toTypeSelection(values: readonly string[]): FeedView['types'] {
  return values.length > 0 ? asNonEmpty(values) : 'all'
}
