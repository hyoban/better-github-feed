import type { ProjectionSnapshot } from '@/local-feed'

export type ReadyProjectionSnapshot<T> = Extract<ProjectionSnapshot<T>, { kind: 'ready' }>

export function selectStableProjectionSnapshot<T>(
  current: ProjectionSnapshot<T>,
  previous: ReadyProjectionSnapshot<T> | null,
): ProjectionSnapshot<T> {
  return current.kind === 'opening-local' && previous ? previous : current
}
