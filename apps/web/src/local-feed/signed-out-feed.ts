import type { LocalFeed, Projection, ProjectionOutput, ProjectionSnapshot } from './types'

const emptyCoverage = {
  bootstrap: 'never-synced',
  hasMoreLocal: false,
  remoteWindow: 'unchecked',
  integrity: 'continuous',
} as const

function projectionValue(projection: Projection): unknown {
  switch (projection.kind) {
    case 'following':
      return {
        items: [],
        totalLocal: 0,
        coverage: emptyCoverage,
        computation: 'ready',
      }
    case 'visible-feed':
      return {
        items: [],
        coverage: emptyCoverage,
        rejectedActorKeys: [],
        computation: 'ready',
      }
    case 'activity':
      return { kind: 'unavailable', reason: 'not-synced-or-unknown' }
    case 'user-filters':
      return []
    case 'statistics':
      return { typeCounts: {}, coverage: 'complete', computation: 'ready' }
    case 'sync-status':
      return { kind: 'quiet', pendingUserOperations: 0 }
  }
}

export const signedOutFeed: LocalFeed = {
  observe<P extends Projection>(projection: P) {
    const snapshot: ProjectionSnapshot<ProjectionOutput<P>> = {
      kind: 'ready',
      localRevision: 0,
      value: projectionValue(projection) as ProjectionOutput<P>,
    }
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    }
  },
  async commit() {
    throw new Error('Sign in with GitHub to change your local feed.')
  },
  requestSync() {},
  async close() {
    return { kind: 'closed' }
  },
}
