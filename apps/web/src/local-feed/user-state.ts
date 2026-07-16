import type {
  FeedStateReplica,
  FilterReplica,
  UserMutationResult,
  UserStateMutation,
  UserStatePage,
} from './cloud-replica'
import { userFilterMutationValueSchema } from '@better-github-feed/contract'
import { incrementLocalRevision } from './database'
import type {
  FeedStateRow,
  FilterReplicaRow,
  FilterRow,
  FilterValue,
  LocalFeedDatabase,
  OutboxRow,
} from './database'
import { assertTransactionLeadership } from './tab-coordinator'
import type { LeadershipFence } from './tab-coordinator'

function assertViewer(viewerGithubId: string, ownerGithubId: string) {
  if (viewerGithubId !== ownerGithubId) throw new Error('Cloud replica viewer mismatch')
}

function filterValue(replica: FilterReplica): FilterValue | null {
  if (!replica.value) return null
  return replica.value.isValid
    ? { name: replica.value.name, rule: replica.value.rule }
    : {
        name: replica.value.name,
        rule: null,
        invalidLegacyRule: replica.value.invalidLegacyRule,
      }
}

function filterReplicaRow(replica: FilterReplica): FilterReplicaRow {
  return {
    id: replica.id,
    entityVersion: replica.version,
    changedRevision: replica.changedRevision,
    deletedAt: replica.deletedAt,
    value: filterValue(replica),
  }
}

function feedStateRow(replica: FeedStateReplica | null, current?: FeedStateRow): FeedStateRow {
  return {
    key: 'active',
    entityVersion: replica?.version ?? current?.entityVersion ?? 0,
    changedRevision: replica?.changedRevision ?? current?.changedRevision ?? '0',
    serverClearedAt: replica ? replica.clearedAt : (current?.serverClearedAt ?? null),
    optimisticClearedAt: current?.optimisticClearedAt ?? null,
    provisionalThroughRevision: current?.provisionalThroughRevision ?? null,
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => deepEqual(value, right[index]))
    )
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])
  return [...keys].every(key => deepEqual(leftRecord[key], rightRecord[key]))
}

export type MergeResult = { kind: 'merged'; value: unknown } | { kind: 'conflict' }

export function retargetFilterMutationChain(input: {
  rows: readonly OutboxRow[]
  oldId: string
  newId: string
  createAttemptId: () => string
}) {
  const oldEntityKey = `filter:${input.oldId}`
  return input.rows.map(row => {
    if (row.entityKey !== oldEntityKey || row.operation.kind === 'feed.clear') return row
    return {
      ...row,
      entityKey: `filter:${input.newId}`,
      attemptId: input.createAttemptId(),
      conflictCopy: true,
      operation:
        row.operation.kind === 'filter.put'
          ? {
              ...row.operation,
              filter: { ...row.operation.filter, id: input.newId },
            }
          : { ...row.operation, id: input.newId },
    }
  })
}

function stableIds(values: readonly unknown[]) {
  const ids: string[] = []
  for (const value of values) {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !== 'string'
    ) {
      return null
    }
    ids.push((value as { id: string }).id)
  }
  return new Set(ids).size === ids.length ? ids : null
}

export function mergeThreeWay(base: unknown, local: unknown, remote: unknown): MergeResult {
  if (deepEqual(local, base)) return { kind: 'merged', value: remote }
  if (deepEqual(remote, base) || deepEqual(local, remote)) {
    return { kind: 'merged', value: local }
  }
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    const baseIds = stableIds(base)
    const localIds = stableIds(local)
    const remoteIds = stableIds(remote)
    if (baseIds && localIds && remoteIds) {
      const order = [...new Set([...baseIds, ...localIds, ...remoteIds])]
      const baseById = new Map(baseIds.map((id, index) => [id, base[index]]))
      const localById = new Map(localIds.map((id, index) => [id, local[index]]))
      const remoteById = new Map(remoteIds.map((id, index) => [id, remote[index]]))
      const merged: unknown[] = []
      for (const id of order) {
        const result = mergeThreeWay(baseById.get(id), localById.get(id), remoteById.get(id))
        if (result.kind === 'conflict') return result
        if (result.value !== undefined) merged.push(result.value)
      }
      return { kind: 'merged', value: merged }
    }
    if (base.length !== local.length || base.length !== remote.length) {
      return { kind: 'conflict' }
    }
    const merged: unknown[] = []
    for (let index = 0; index < base.length; index += 1) {
      const baseId = (base[index] as { id?: unknown } | null)?.id
      const localId = (local[index] as { id?: unknown } | null)?.id
      const remoteId = (remote[index] as { id?: unknown } | null)?.id
      if (baseId !== undefined && (baseId !== localId || baseId !== remoteId)) {
        return { kind: 'conflict' }
      }
      const result = mergeThreeWay(base[index], local[index], remote[index])
      if (result.kind === 'conflict') return result
      merged.push(result.value)
    }
    return { kind: 'merged', value: merged }
  }
  if (
    base === null ||
    local === null ||
    remote === null ||
    Array.isArray(base) ||
    Array.isArray(local) ||
    Array.isArray(remote) ||
    typeof base !== 'object' ||
    typeof local !== 'object' ||
    typeof remote !== 'object'
  ) {
    return { kind: 'conflict' }
  }

  const baseRecord = base as Record<string, unknown>
  const localRecord = local as Record<string, unknown>
  const remoteRecord = remote as Record<string, unknown>
  const merged: Record<string, unknown> = {}
  const keys = new Set([
    ...Object.keys(baseRecord),
    ...Object.keys(localRecord),
    ...Object.keys(remoteRecord),
  ])
  for (const key of keys) {
    const result = mergeThreeWay(baseRecord[key], localRecord[key], remoteRecord[key])
    if (result.kind === 'conflict') return result
    if (result.value !== undefined) merged[key] = result.value
  }
  return { kind: 'merged', value: merged }
}

async function materializeUserState(database: LocalFeedDatabase, now: number) {
  const [replicas, pending, feedState] = await Promise.all([
    database.filterReplicas.toArray(),
    database.outbox.orderBy('localSequence').toArray(),
    database.feedState.get('active'),
  ])
  const filters = new Map<string, FilterRow>()
  for (const replica of replicas) {
    if (replica.deletedAt !== null || !replica.value) continue
    filters.set(replica.id, {
      id: replica.id,
      name: replica.value.name,
      rule: replica.value.rule,
      invalidLegacyRule: replica.value.invalidLegacyRule,
      deletedAt: null,
      sync: 'synced',
      updatedAt: now,
    })
  }

  let provisionalThroughRevision = feedState?.provisionalThroughRevision ?? null
  let optimisticClearedAt = feedState?.serverClearedAt ?? null
  for (const item of pending) {
    if (item.operation.kind === 'filter.put') {
      filters.set(item.operation.filter.id, {
        id: item.operation.filter.id,
        name: item.operation.filter.name,
        rule: item.operation.filter.rule,
        deletedAt: null,
        sync: item.conflictCopy ? 'conflict-copy' : 'pending',
        updatedAt: item.createdAt,
      })
    } else if (item.operation.kind === 'filter.delete') {
      filters.delete(item.operation.id)
    } else {
      provisionalThroughRevision = Math.max(provisionalThroughRevision ?? 0, item.localSequence - 1)
      const { candidate } = item.operation
      if (candidate !== null) {
        optimisticClearedAt = Math.max(optimisticClearedAt ?? candidate, candidate)
      }
    }
  }

  await database.filters.clear()
  await database.filters.bulkPut([...filters.values()])
  await database.feedState.put({
    ...(feedState ?? feedStateRow(null)),
    optimisticClearedAt,
    provisionalThroughRevision,
  })
}

export async function applyUserStatePages(input: {
  database: LocalFeedDatabase
  ownerGithubId: string
  pages: readonly UserStatePage[]
  now: number
  fence: LeadershipFence
}) {
  if (input.pages.length === 0) return null
  for (const page of input.pages) assertViewer(page.viewerGithubId, input.ownerGithubId)
  const first = input.pages[0]!
  const last = input.pages.at(-1)!
  if (input.pages.some(page => page.mode !== first.mode || page.epoch !== first.epoch)) {
    throw new Error('User-state snapshot changed during pagination')
  }
  if (first.mode === 'snapshot' && input.pages.some(page => page.revision !== first.revision)) {
    throw new Error('User-state snapshot revision changed during pagination')
  }

  return input.database.transaction(
    'rw',
    [
      input.database.meta,
      input.database.filterReplicas,
      input.database.filters,
      input.database.feedState,
      input.database.outbox,
      input.database.syncState,
      input.database.syncLease,
    ],
    async () => {
      await assertTransactionLeadership(input.database, input.fence)
      if (first.mode === 'snapshot') await input.database.filterReplicas.clear()
      const replicas: FilterReplicaRow[] = []
      for (const page of input.pages) {
        for (const filter of page.filters) replicas.push(filterReplicaRow(filter))
      }
      if (replicas.length > 0) await input.database.filterReplicas.bulkPut(replicas)

      const remoteFeedState = [...input.pages]
        .reverse()
        .find(page => page.feedState !== null)?.feedState
      if (remoteFeedState) {
        const current = await input.database.feedState.get('active')
        await input.database.feedState.put(feedStateRow(remoteFeedState, current))
      }
      await input.database.syncState.put({
        key: 'user-state',
        userStateRevision: last.revision,
        userStateEpoch: last.epoch,
      })
      await materializeUserState(input.database, input.now)
      return incrementLocalRevision(input.database)
    },
  )
}

export async function prepareNextMutation(input: {
  database: LocalFeedDatabase
  createId: () => string
  now: number
  fence: LeadershipFence
}): Promise<{ mutation: UserStateMutation | null; localRevision: number | null }> {
  return input.database.transaction(
    'rw',
    [
      input.database.meta,
      input.database.filterReplicas,
      input.database.filters,
      input.database.feedState,
      input.database.outbox,
      input.database.syncState,
      input.database.syncLease,
    ],
    async () => {
      await assertTransactionLeadership(input.database, input.fence)
      const outbox = await input.database.outbox
        .where('status')
        .equals('pending')
        .sortBy('localSequence')
        .then(rows => rows[0])
      if (!outbox) return { mutation: null, localRevision: null }

      if (outbox.operation.kind === 'feed.clear') {
        const state = await input.database.feedState.get('active')
        const remote = state?.serverClearedAt ?? null
        const candidate = Math.max(
          remote ?? outbox.operation.candidate ?? 0,
          outbox.operation.candidate ?? remote ?? 0,
        )
        outbox.baseVersion = state?.entityVersion ?? 0
        outbox.baseValue = remote
        outbox.operation.candidate = candidate || null
        await input.database.outbox.put(outbox)
        return {
          mutation: {
            kind: 'feed.clear',
            mutationId: outbox.mutationId,
            attemptId: outbox.attemptId,
            baseVersion: outbox.baseVersion,
            candidate: outbox.operation.candidate,
            timeAnchor: outbox.operation.timeAnchor,
          },
          localRevision: null,
        }
      }

      const id =
        outbox.operation.kind === 'filter.put' ? outbox.operation.filter.id : outbox.operation.id
      const remote = await input.database.filterReplicas.get(id)
      const remoteValue = remote?.deletedAt === null ? remote.value : null

      if (outbox.operation.kind === 'filter.delete') {
        if (remote?.deletedAt !== null && remote !== undefined) {
          await input.database.outbox.delete(outbox.mutationId)
          await materializeUserState(input.database, input.now)
          return {
            mutation: null,
            localRevision: await incrementLocalRevision(input.database),
          }
        }
        outbox.baseVersion = remote?.entityVersion ?? 0
        outbox.baseValue = remoteValue
        await input.database.outbox.put(outbox)
        return {
          mutation: {
            kind: 'filter.delete',
            mutationId: outbox.mutationId,
            attemptId: outbox.attemptId,
            baseVersion: outbox.baseVersion,
            id,
          },
          localRevision: null,
        }
      }

      let localRevision: number | null = null
      const desired: FilterValue = {
        name: outbox.operation.filter.name,
        rule: outbox.operation.filter.rule,
      }
      if (outbox.baseVersion !== (remote?.entityVersion ?? 0)) {
        const result = mergeThreeWay(outbox.baseValue, desired, remoteValue)
        if (result.kind === 'merged' && result.value !== null) {
          const merged = result.value as FilterValue
          if (!merged.rule) throw new Error('A local Filter merge produced an invalid rule')
          outbox.operation.filter = { id, name: merged.name, rule: merged.rule }
          outbox.baseVersion = remote?.entityVersion ?? 0
          outbox.baseValue = remoteValue
        } else {
          const conflictId = input.createId()
          const originalId = id
          outbox.entityKey = `filter:${conflictId}`
          outbox.baseVersion = 0
          outbox.baseValue = null
          outbox.attemptId = input.createId()
          outbox.conflictCopy = true
          outbox.operation.filter = { ...outbox.operation.filter, id: conflictId }
          const later = await input.database.outbox
            .where('entityKey')
            .equals(`filter:${originalId}`)
            .and(row => row.localSequence > outbox.localSequence)
            .toArray()
          const retargeted = retargetFilterMutationChain({
            rows: later,
            oldId: originalId,
            newId: conflictId,
            createAttemptId: input.createId,
          })
          if (retargeted.length > 0) await input.database.outbox.bulkPut(retargeted)
        }
        await input.database.outbox.put(outbox)
        await materializeUserState(input.database, input.now)
        localRevision = await incrementLocalRevision(input.database)
      }

      const validated = userFilterMutationValueSchema.safeParse({
        id: outbox.operation.filter.id,
        name: outbox.operation.filter.name,
        filterRule: outbox.operation.filter.rule,
      })
      if (!validated.success) {
        outbox.status = 'blocked'
        outbox.conflictCopy = true
        await input.database.outbox.put(outbox)
        await materializeUserState(input.database, input.now)
        localRevision ??= await incrementLocalRevision(input.database)
        return { mutation: null, localRevision }
      }

      return {
        mutation: {
          kind: 'filter.put',
          mutationId: outbox.mutationId,
          attemptId: outbox.attemptId,
          baseVersion: outbox.baseVersion,
          filter: {
            id: validated.data.id,
            name: validated.data.name,
            rule: validated.data.filterRule,
          },
        },
        localRevision,
      }
    },
  )
}

function applyResultReplica(
  database: LocalFeedDatabase,
  result: UserMutationResult,
): Promise<unknown> {
  if (result.filter) return database.filterReplicas.put(filterReplicaRow(result.filter))
  if (result.feedState) {
    return database.feedState.get('active').then(current =>
      database.feedState.put({
        ...feedStateRow(result.feedState!, current),
        optimisticClearedAt: result.feedState!.clearedAt,
        provisionalThroughRevision: null,
      }),
    )
  }
  return Promise.resolve()
}

export async function applyMutationResult(input: {
  database: LocalFeedDatabase
  ownerGithubId: string
  mutationId: string
  result: UserMutationResult
  createId: () => string
  now: number
  fence: LeadershipFence
}) {
  assertViewer(input.result.viewerGithubId, input.ownerGithubId)
  return input.database.transaction(
    'rw',
    [
      input.database.meta,
      input.database.filterReplicas,
      input.database.filters,
      input.database.feedState,
      input.database.outbox,
      input.database.syncLease,
    ],
    async () => {
      await assertTransactionLeadership(input.database, input.fence)
      const current = await input.database.outbox.get(input.mutationId)
      if (!current) return null
      await applyResultReplica(input.database, input.result)

      if (input.result.kind === 'conflict') {
        current.attemptId = input.createId()
        await input.database.outbox.put(current)
      } else {
        await input.database.outbox.delete(input.mutationId)
      }

      await materializeUserState(input.database, input.now)
      return incrementLocalRevision(input.database)
    },
  )
}
