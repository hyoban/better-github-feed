import type { LocalFeedDatabase } from './database'
import type { Projection } from './types'

export type LeadershipFence = {
  token: string
  isCurrent(): Promise<boolean>
  transactionProof?: {
    owner: string
    now: () => number
  }
  accountProof?: {
    ownerGithubId: string
    generation: number
    nonce: string
  }
}

export type TabAnnouncement =
  | {
      kind: 'demand-changed'
      tabId: string
      demandKey: string
      projection: Projection
      active: boolean
      expiresAt?: number
    }
  | {
      kind: 'local-revision'
      revision: number
      requestsSync?: boolean
      scope?: 'data' | 'status'
    }
  | { kind: 'projection-changed' }
  | { kind: 'leadership-retry' }
  | { kind: 'account-generation'; generation: number; nonce: string }

export interface TabCoordinatorPort {
  runAsLeader(task: (fence: LeadershipFence) => Promise<void>): Promise<boolean>
  announce(event: TabAnnouncement): void
  subscribe(listener: (event: TabAnnouncement) => void): () => void
  close(): void
}

export function createSingleTabCoordinator(): TabCoordinatorPort {
  const token = crypto.randomUUID()
  const listeners = new Set<(event: TabAnnouncement) => void>()
  let closed = false
  let running: Promise<void> | null = null

  return {
    async runAsLeader(task) {
      if (closed) return false
      if (running) {
        await running
        return false
      }

      const current = task({ token, isCurrent: async () => !closed })
      running = current
      try {
        await current
        return true
      } finally {
        running = null
      }
    },
    announce(event) {
      for (const listener of listeners) listener(event)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      listeners.clear()
    },
  }
}

export function createBroadcastTabCoordinator(
  channelName: string,
  lockName = channelName,
): TabCoordinatorPort {
  const channel = new BroadcastChannel(channelName)
  const listeners = new Set<(event: TabAnnouncement) => void>()
  let closed = false
  let fallbackBusy = false

  channel.addEventListener('message', event => {
    const announcement = event.data as TabAnnouncement
    for (const listener of listeners) listener(announcement)
  })

  async function runWithFallback(task: (fence: LeadershipFence) => Promise<void>) {
    if (fallbackBusy || closed) return false
    fallbackBusy = true
    const token = crypto.randomUUID()
    try {
      await task({ token, isCurrent: async () => !closed })
      return true
    } finally {
      fallbackBusy = false
    }
  }

  return {
    async runAsLeader(task) {
      if (closed) return false
      if (!navigator.locks) return runWithFallback(task)

      let acquired = false
      await navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
        if (!lock || closed) return
        acquired = true
        const token = crypto.randomUUID()
        await task({ token, isCurrent: async () => !closed })
      })
      return acquired
    },
    announce(event) {
      if (!closed) channel.postMessage(event)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      listeners.clear()
      channel.close()
    },
  }
}

export function createDexieTabCoordinator(
  database: LocalFeedDatabase,
  channelName: string,
  options?: { now?: () => number; leaseMs?: number; random?: () => number },
): TabCoordinatorPort {
  const now = options?.now ?? Date.now
  const leaseMs = options?.leaseMs ?? 15_000
  const random = options?.random ?? Math.random
  const owner = crypto.randomUUID()
  const channel = new BroadcastChannel(channelName)
  const listeners = new Set<(event: TabAnnouncement) => void>()
  let closed = false
  let leadershipRetryTimer: number | null = null
  let leadershipRetryAt: number | null = null

  channel.addEventListener('message', event => {
    const announcement = event.data as TabAnnouncement
    for (const listener of listeners) listener(announcement)
  })

  function cancelLeadershipRetry() {
    if (leadershipRetryTimer !== null) window.clearTimeout(leadershipRetryTimer)
    leadershipRetryTimer = null
    leadershipRetryAt = null
  }

  function scheduleLeadershipRetry(retryAt: number) {
    if (closed || (leadershipRetryAt !== null && leadershipRetryAt <= retryAt)) return
    cancelLeadershipRetry()
    leadershipRetryAt = retryAt
    leadershipRetryTimer = window.setTimeout(
      () => {
        leadershipRetryTimer = null
        leadershipRetryAt = null
        if (closed) return
        for (const listener of listeners) listener({ kind: 'leadership-retry' })
      },
      leadershipRetryDelay(retryAt, now(), random),
    )
  }

  async function claimLease(): Promise<
    { kind: 'acquired'; fence: LeadershipFence } | { kind: 'busy'; retryAt: number }
  > {
    return database.transaction('rw', database.syncLease, async () => {
      const current = await database.syncLease.get('leader')
      if (current && current.owner !== owner && current.expiresAt > now()) {
        return { kind: 'busy' as const, retryAt: current.expiresAt }
      }
      const fencingToken = String(Number.parseInt(current?.fencingToken ?? '0', 10) + 1)
      await database.syncLease.put({
        key: 'leader',
        owner,
        expiresAt: now() + leaseMs,
        fencingToken,
      })
      return {
        kind: 'acquired' as const,
        fence: {
          token: fencingToken,
          transactionProof: { owner, now },
          isCurrent: async () => {
            if (closed) return false
            const lease = await database.syncLease.get('leader')
            return (
              lease?.owner === owner &&
              lease.fencingToken === fencingToken &&
              lease.expiresAt > now()
            )
          },
        },
      }
    })
  }

  async function runWithClaimedLease(
    fence: LeadershipFence,
    task: (fence: LeadershipFence) => Promise<void>,
  ) {
    const renew = window.setInterval(
      () => {
        void database.transaction('rw', database.syncLease, async () => {
          const current = await database.syncLease.get('leader')
          if (current?.owner === owner && current.fencingToken === fence.token) {
            await database.syncLease.put({ ...current, expiresAt: now() + leaseMs })
          }
        })
      },
      Math.max(1000, Math.floor(leaseMs / 3)),
    )
    try {
      await task(fence)
      return true
    } finally {
      window.clearInterval(renew)
      await database.transaction('rw', database.syncLease, async () => {
        const current = await database.syncLease.get('leader')
        if (current?.owner === owner && current.fencingToken === fence.token) {
          await database.syncLease.delete('leader')
        }
      })
    }
  }

  async function runWithLease(task: (fence: LeadershipFence) => Promise<void>) {
    const claim = await claimLease()
    if (claim.kind === 'busy') {
      scheduleLeadershipRetry(claim.retryAt)
      return false
    }
    cancelLeadershipRetry()
    return runWithClaimedLease(claim.fence, task)
  }

  return {
    async runAsLeader(task) {
      if (closed) return false
      if (!navigator.locks) return runWithLease(task)
      const claim = await navigator.locks.request(
        channelName,
        { ifAvailable: true },
        async lock => {
          if (!lock || closed) return
          return claimLease()
        },
      )
      if (!claim) {
        scheduleLeadershipRetry(now() + 250)
        return false
      }
      if (claim.kind === 'busy') {
        scheduleLeadershipRetry(claim.retryAt)
        return false
      }
      cancelLeadershipRetry()
      return runWithClaimedLease(claim.fence, task)
    },
    announce(event) {
      if (!closed) channel.postMessage(event)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      cancelLeadershipRetry()
      listeners.clear()
      channel.close()
    },
  }
}

export function leadershipRetryDelay(retryAt: number, now: number, random: () => number) {
  return Math.max(0, retryAt - now) + 25 + Math.floor(Math.max(0, Math.min(1, random())) * 225)
}

export async function assertTransactionLeadership(
  database: LocalFeedDatabase,
  fence: LeadershipFence,
) {
  const [lease, owner, generation, nonce] = await Promise.all([
    fence.transactionProof ? database.syncLease.get('leader') : undefined,
    fence.accountProof ? database.meta.get('ownerGithubId') : undefined,
    fence.accountProof ? database.meta.get('accountGeneration') : undefined,
    fence.accountProof ? database.meta.get('accountGenerationNonce') : undefined,
  ])
  const validity = transactionFenceValidity({
    fence,
    lease,
    ownerGithubId: typeof owner?.value === 'string' ? owner.value : undefined,
    accountGeneration: typeof generation?.value === 'number' ? generation.value : undefined,
    accountNonce: typeof nonce?.value === 'string' ? nonce.value : undefined,
  })
  if (!validity.leadership) {
    throw new Error('Incremental Sync lost its transaction fencing token')
  }
  if (!validity.account) {
    throw new Error('Incremental Sync lost its account generation fence')
  }
}

export function transactionFenceValidity(input: {
  fence: LeadershipFence
  lease?: { owner: string; fencingToken: string; expiresAt: number }
  ownerGithubId?: string
  accountGeneration?: number
  accountNonce?: string
}) {
  const leadership =
    !input.fence.transactionProof ||
    (input.lease?.owner === input.fence.transactionProof.owner &&
      input.lease.fencingToken === input.fence.token &&
      input.lease.expiresAt > input.fence.transactionProof.now())
  const account =
    !input.fence.accountProof ||
    (input.ownerGithubId === input.fence.accountProof.ownerGithubId &&
      input.accountGeneration === input.fence.accountProof.generation &&
      input.accountNonce === input.fence.accountProof.nonce)
  return { leadership, account }
}
